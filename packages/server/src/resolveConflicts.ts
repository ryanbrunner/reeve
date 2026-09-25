import { conflictResolutionOutput, type ConflictResolutionOutput } from '@reeve/shared';
import type { Db } from './db/client.js';
import { getCard, getRun, getSettings, insertCardEvent, liveTaskRun } from './db/queries.js';
import type { Card, Repo } from './db/schema.js';
import { fetchBranch, pullRequestState, pushBranch, type PullRequestState } from './git/github.js';
import {
  GitError,
  abortMerge,
  checkWorktree,
  conflictMarkersIn,
  headSha,
  isAncestor,
  isDirty,
  mergeInProgress,
  resetTo,
  startMerge,
  unmergedPaths,
  type MergeStart,
} from './git/worktree.js';
import { claimResolving, forgetConflict, isOpeningPr, releaseResolving } from './pullRequest.js';
import { startClaudeRun, type ClaudeRunHandle, type ClaudeRunParams } from './runs/claude.js';
import type { EventWriter } from './runs/events.js';
import { runRegistry } from './runs/registry.js';
import { RESOLVE_CONFLICTS_TASK, resolveConflictsTask } from './stages/resolve_conflicts.js';

export type ResolveResult =
  | { ok: true; runId: string | null; pushed: boolean }
  | { ok: false; status: 400 | 409 | 429 | 502; error: string; detail: string };

/** The spike stands in for Claude here; everything else calls the real thing. */
type StartRun = (params: ClaudeRunParams) => ClaudeRunHandle;

/** What the merge was, carried from the request that started it to the chain that finishes it. */
interface MergeFacts {
  cardId: string;
  prUrl: string;
  prNumber: number | null;
  worktreePath: string;
  branch: string;
  base: string;
  /** The base branch's head as fetched, which the merged branch must contain. */
  baseSha: string;
  /** The branch's head before anything was merged, and where it goes back to. */
  before: string;
}

const reason = (e: unknown) => (e instanceof GitError ? e.stderr || e.message : String(e));

/**
 * Merge a Done card's base branch into its branch and push the result to its
 * pull request, with Claude resolving whatever conflicts in between.
 *
 * The server owns git on both sides of the run. It fetches and starts the
 * merge here, so Claude is handed a merge already stopped on its conflicts;
 * and once the run ends it checks the commit Claude made and pushes it, or
 * puts the branch back where it was. Claude never merges, resets or pushes.
 *
 * If GitHub's verdict was stale and the base merges cleanly, the merge commit
 * is pushed straight away and no run is started.
 *
 * The card holds the resolving lock from here until the push or the rollback,
 * which is what stops a drag into Done pushing a branch halfway through a merge.
 */
export async function resolveConflicts(
  db: Db,
  writer: EventWriter,
  card: Card,
  repo: Repo,
  startRun: StartRun = startClaudeRun,
): Promise<ResolveResult> {
  const refuse = (status: 400 | 409 | 429 | 502, error: string, detail: string): ResolveResult =>
    ({ ok: false, status, error, detail });

  if (card.stage !== 'done') return refuse(400, 'only a Done card’s conflicts are resolved', card.stage);
  if (card.mergedAt) return refuse(409, 'already merged', card.prUrl ?? `#${card.number}`);
  const { branchName: branch, worktreePath, prUrl } = card;
  if (!prUrl) return refuse(400, 'no pull request', 'conflicts are resolved against an open pull request');
  if (!branch || !worktreePath) return refuse(400, 'nothing to merge into', 'the card has no worktree');
  if (isOpeningPr(card.id)) return refuse(409, 'a pull request is being opened', `#${card.number}`);
  if (liveTaskRun(db, card.id, RESOLVE_CONFLICTS_TASK)) return refuse(409, 'already resolving conflicts', `#${card.number}`);
  // Checked before touching git as well as after, so a refusal here leaves nothing to undo.
  const full = atCap(db);
  if (full) return refuse(429, 'too many concurrent runs', full);
  // Taken before the first await, so no second press can slip in between.
  if (!claimResolving(card.id)) return refuse(409, 'already resolving conflicts', `#${card.number}`);

  // Once the run exists its `done` chain owns the lock and lets it go. Every
  // return before that point lets it go here.
  let handedOff = false;
  try {
    const health = await checkWorktree(repo.repoPath, worktreePath);
    if (health.state !== 'ok') {
      return refuse(409, 'worktree missing', health.state === 'missing' ? health.reason : worktreePath);
    }
    const path = health.path;

    let pr: PullRequestState;
    try {
      pr = await pullRequestState(repo.repoPath, prUrl);
    } catch (e) {
      return refuse(502, 'could not ask GitHub about the pull request', reason(e));
    }
    if (pr.state !== 'OPEN') return refuse(409, `the pull request is ${pr.state.toLowerCase()}`, prUrl);
    const base = pr.base || repo.defaultBranch;

    // A restart during a run skips everything that would have finished or
    // undone its merge, and nothing else in Reeve starts one. Cleared before
    // the dirty check, which a half-done merge would fail.
    if (await mergeInProgress(path)) await abortMerge(path);
    // `.reeve/` is every stage's untracked record, not work. See openPullRequest.
    if (await isDirty(path, { ignore: ['.reeve'] })) {
      return refuse(409, 'the card has uncommitted changes', 'the merge needs a clean tree — commit or discard them in the worktree first');
    }

    let baseSha: string;
    try {
      baseSha = await fetchBranch(path, base);
    } catch (e) {
      return refuse(502, `could not fetch ${base} from origin`, reason(e));
    }
    const facts: MergeFacts = {
      cardId: card.id, prUrl, prNumber: card.prNumber, worktreePath: path, branch, base, baseSha,
      before: await headSha(path),
    };

    let merge: MergeStart;
    try {
      merge = await startMerge(path, `origin/${base}`);
    } catch (e) {
      return refuse(409, `could not merge ${base}`, reason(e));
    }

    if (merge.clean) {
      const pushed = await pushResolution(db, facts, null);
      return pushed.ok ? { ok: true, runId: null, pushed: true } : refuse(502, 'push to origin failed', pushed.detail);
    }

    // Read again, and nothing awaited from here to the run: the card may have
    // been moved or archived, and the cap filled, while git worked.
    const fresh = getCard(db, card.id);
    const moved = !fresh || fresh.archivedAt ? 'the card was archived' : fresh.stage !== 'done' ? 'the card left Done' : null;
    const nowFull = atCap(db);
    if (moved || nowFull || !fresh) {
      await resetTo(path, facts.before);
      return nowFull && !moved
        ? refuse(429, 'too many concurrent runs', nowFull)
        : refuse(409, 'the card moved while its branch was merging', moved ?? 'gone');
    }

    const handle = startRun({
      db, writer, card: fresh, repo,
      stage: resolveConflictsTask({ base, conflicts: merge.conflicts }) as never,
      runStage: 'done',
      worktreePath: path,
    });
    handedOff = true;
    // `done` does not reject, but the chain must finish either way: a merge
    // left in progress is exactly what this is here to prevent. And nothing
    // may escape, since an unhandled rejection would take the server down.
    void handle.done
      .catch(() => {})
      .then(() => finishResolution(db, facts, merge.conflicts, handle.runId))
      .catch((e) => console.error(`[reeve] resolving conflicts for #${card.number} ended badly: ${reason(e)}`))
      .finally(() => releaseResolving(card.id));
    return { ok: true, runId: handle.runId, pushed: false };
  } finally {
    if (!handedOff) releaseResolving(card.id);
  }
}

function atCap(db: Db): string | null {
  const { maxConcurrentRuns } = getSettings(db);
  return runRegistry.countByKind('claude') >= maxConcurrentRuns ? `limit is ${maxConcurrentRuns}` : null;
}

/**
 * Check what the run left, then push it or put the branch back.
 *
 * Only a succeeded run whose output parses is trusted, and then only as far as
 * the checks go. They prove the merge is finished and nothing is left marked;
 * they cannot prove it is right, which is why Claude's account of it goes on
 * the event for a person to read.
 */
async function finishResolution(db: Db, facts: MergeFacts, conflicts: string[], runId: string): Promise<void> {
  try {
    const run = getRun(db, runId);
    if (run?.status !== 'succeeded') {
      const why = run?.status === 'cancelled' ? 'the run was stopped'
        : `the run ${run?.status ?? 'disappeared'}${run?.errorMessage ? `: ${run.errorMessage}` : ''}`;
      await rollBack(db, facts, runId, why);
      return;
    }
    const output = conflictResolutionOutput.safeParse(run.structuredOutput);
    if (!output.success) {
      await rollBack(db, facts, runId, 'the run gave no account of what it resolved');
      return;
    }
    const problem = await checkMerge(facts, conflicts);
    if (problem) {
      await rollBack(db, facts, runId, problem);
      return;
    }
    await pushResolution(db, facts, { runId, output: output.data });
  } catch (e) {
    await rollBack(db, facts, runId, reason(e));
  }
}

/** Why the merge Claude committed cannot be pushed, or null if it can. */
async function checkMerge(facts: MergeFacts, conflicts: string[]): Promise<string | null> {
  const path = facts.worktreePath;
  const unmerged = await unmergedPaths(path);
  if (unmerged.length) return `still conflicted: ${unmerged.join(', ')}`;
  if (await mergeInProgress(path)) return 'the merge was never committed';
  const marked = await conflictMarkersIn(path, conflicts);
  if (marked.length) return `conflict markers were committed in ${marked.join(', ')}`;
  if (!(await isAncestor(path, facts.baseSha))) return `the branch does not contain ${facts.base} as fetched`;
  if (!(await isAncestor(path, facts.before))) return 'the branch no longer contains its own commits';
  return null;
}

/**
 * Back to the commit the branch was on before the merge. A hard reset, because
 * the tree was clean when the merge started and so everything it would discard
 * is the resolution's own — and it clears a merge in progress as well as one
 * already committed. Untracked files, `.reeve/` among them, are left alone.
 */
async function rollBack(db: Db, facts: MergeFacts, runId: string, why: string): Promise<void> {
  let body = why;
  try {
    await resetTo(facts.worktreePath, facts.before);
  } catch (e) {
    body = `${why}. The branch could not be put back as it was: ${reason(e)}`;
  }
  record(db, facts.cardId, 'conflicts_failed', 'claude', runId, body, { base: facts.base, kept: false });
}

/**
 * Push the merge commit to the pull request's branch. Never forced: a merge
 * only adds to the branch, so the push is a fast-forward of what GitHub has.
 *
 * A push that fails keeps the commit. The merge is verified and may have cost
 * a run; pressing the button again finds the base already merged, takes the
 * clean path, and pushes it.
 */
async function pushResolution(
  db: Db,
  facts: MergeFacts,
  resolved: { runId: string; output: ConflictResolutionOutput } | null,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const actor = resolved ? 'claude' : 'human';
  const runId = resolved?.runId ?? null;
  try {
    await pushBranch(facts.worktreePath, facts.branch);
  } catch (e) {
    const detail = reason(e);
    record(db, facts.cardId, 'conflicts_failed', actor, runId,
      `The merge is committed in the worktree, but the push failed: ${detail}`, { base: facts.base, kept: true });
    return { ok: false, detail };
  }
  // GitHub's verdict was about the branch before this push. The next sync asks again.
  forgetConflict(facts.cardId);
  const output = resolved?.output;
  record(db, facts.cardId, 'conflicts_resolved', actor, runId, output?.summary ?? null, {
    url: facts.prUrl,
    number: facts.prNumber,
    base: facts.base,
    baseSha: facts.baseSha,
    sha: await headSha(facts.worktreePath).catch(() => null),
    clean: !resolved,
    testsPassed: output?.tests_passed ?? null,
    files: output?.files ?? [],
    concerns: output?.concerns ?? [],
  });
  return { ok: true };
}

function record(
  db: Db,
  cardId: string,
  kind: 'conflicts_resolved' | 'conflicts_failed',
  actor: 'human' | 'claude',
  runId: string | null,
  body: string | null,
  meta: Record<string, unknown>,
): void {
  try {
    insertCardEvent(db, { cardId, actor, kind, stage: 'done', runId, body, meta });
  } catch (e) {
    // The card itself may be gone; there is nowhere left to say so.
    console.error(`[reeve] ${kind} for card ${cardId} went unrecorded: ${String(e)}`);
  }
}
