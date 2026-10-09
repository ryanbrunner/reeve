import { existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { canStartRun, isRunnable, type Stage } from '@reeve/shared';
import { blockedStart } from './blockers.js';
import { cardActivity } from './board.js';
import type { Db } from './db/client.js';
import { getCard, getSettings, insertCardEvent, liveStageRun, runsForCard } from './db/queries.js';
import { card as cardTable, type Card, type Repo } from './db/schema.js';
import { fetchBranch } from './git/github.js';
import {
  GitError,
  abortMerge,
  behindBase,
  checkWorktree,
  copyWorktreeIncludes,
  createWorktree,
  isAncestor,
  isDirty,
  removeWorktree,
  startMerge,
  type MergeStart,
} from './git/worktree.js';
import { startClaudeRun, type ClaudeRunParams } from './runs/claude.js';
import type { EventWriter } from './runs/events.js';
import { runRegistry } from './runs/registry.js';
import { serverEnv, serverVars } from './runs/serverUrl.js';
import { startShellRun, type ShellRunHandle } from './runs/shell.js';
import { stageDefinition } from './stages/index.js';

/**
 * Cards with a start under way. Making a worktree takes seconds, and a drag
 * followed by a press of Run in that time would otherwise both find no tree
 * and both try to make one.
 */
const starting = new Set<string>();

/**
 * Whether a start is under way for the card: its worktree is being made, or
 * its setup waited on, and its run has no row yet. For those seconds the card
 * reads as whatever its last run left — idle, or for a revision or a resume
 * still waiting on a person — and `reeve card wait` has to be able to tell
 * that from a card nothing is going to start.
 */
export const isStartingStage = (cardId: string) => starting.has(cardId);

/**
 * Setup commands still running, by card. A stage started beside one works in
 * a tree whose `node_modules` is half there, where `npm test` fails on missing
 * modules and the stage's shell is too narrow to install them itself, so
 * `startStage` and `continueStage` wait on this before Claude is let in. Kept
 * here rather than read off the registry, which holds how to stop a run but
 * not how to wait for one.
 */
const settingUp = new Map<string, ShellRunHandle>();

export type StartStageResult =
  | { ok: true; runId: string; sessionId: string }
  | { ok: false; status: 400 | 409 | 429 | 500 | 501; error: string; detail: string };

const reason = (e: unknown) => (e instanceof GitError ? e.stderr || e.message : String(e));

/**
 * A merged card whose worktree has been removed is not given one again.
 * `createWorktree` could check its kept branch out afresh, but the work on it
 * has landed and its pull request is merged, so nothing done there could ship
 * through this card: anything more is a new card. Asked by the two ways a
 * worktree is made, so both say the same sentence.
 */
export function refuseMergedWorktree(card: Card): { error: string; detail: string } | null {
  if (!card.mergedAt || card.worktreePath) return null;
  return {
    error: 'already merged',
    detail: 'its worktree has been removed and its branch is kept; start a new card for more work',
  };
}

/**
 * The card's worktree, made if it is not there yet. A new one is given the
 * files the repo's `.worktreeinclude` names, and if the repo defines a setup
 * command, that is kicked off as a background shell run and not awaited here:
 * `startStage` waits on it, and the worktree button answers as soon as the
 * tree is there. It is a different run kind, so it counts against neither the
 * card's active run nor the concurrency cap. A reused worktree gets it too if
 * it never finished there; see `owedSetup`.
 */
export async function ensureWorktree(db: Db, writer: EventWriter, card: Card, repo: Repo) {
  const health = await checkWorktree(repo.repoPath, card.worktreePath);
  if (health.state === 'ok') {
    return { reused: true as const, path: health.path, setupRunId: owedSetup(db, writer, card, repo, health.path) };
  }

  // From the base as origin has it, never the local branch: that is the
  // person's own, and a commit sitting unpushed on it would otherwise ride
  // along in this card's pull request and every sibling cut beside it. Only a
  // fetch that fails falls back to the local branch, and the card says so.
  const base = repo.defaultBranch;
  let fetched: string | null = null;
  let fetchFailure = '';
  try {
    fetched = await fetchBranch(repo.repoPath, base);
  } catch (e) {
    fetchFailure = reason(e);
  }
  const created = await createWorktree({
    repoPath: repo.repoPath,
    worktreeRoot: repo.worktreeRoot,
    cardId: card.id,
    title: card.title,
    base: fetched ?? base,
    previous: card.branchName && card.baseSha ? { branch: card.branchName, baseSha: card.baseSha } : null,
  });
  db.update(cardTable)
    .set({ worktreePath: created.path, branchName: created.branch, baseSha: created.baseSha, updatedAt: new Date() })
    .where(eq(cardTable.id, card.id))
    .run();
  if (!fetched) {
    insertCardEvent(db, {
      cardId: card.id, actor: 'human', kind: 'note', stage: card.stage,
      body: `Started from the local ${base} at ${created.baseSha.slice(0, 7)}, because fetching origin/${base} failed: ${fetchFailure}`,
    });
  }

  // Awaited before the setup command, which may well need the `.env` this
  // brings over. Only a new worktree gets them: a reused one keeps whatever it
  // has been given since. A copy that fails costs the card a file, not its start.
  let included: string[] = [];
  try {
    included = await copyWorktreeIncludes(repo.repoPath, created.path);
  } catch (e) {
    console.warn(`[reeve] #${card.number} .worktreeinclude not copied: ${reason(e)}`);
  }

  // From `created`: `card` predates the branch.
  const setupRunId = startSetup(db, writer, card, repo, created.path, created.branch);
  return { reused: false as const, path: created.path, branch: created.branch, setupRunId, included };
}

/**
 * The setup a reused worktree is still owed: the one running in it, or a
 * fresh one when the last to run there did not succeed. #67's tree was made
 * before Reeve's own repo had a setup command, so nothing had ever installed
 * its `node_modules`, and two stages in a row failed `npm test` on missing
 * modules. Matched on the command as well as the tree, so a setup command
 * changed since is run where only the old one had.
 */
function owedSetup(db: Db, writer: EventWriter, card: Card, repo: Repo, path: string): string | null {
  const running = settingUp.get(card.id);
  if (running) return running.runId;
  if (!repo.setupCommand) return null;
  const last = runsForCard(db, card.id)
    .find((r) => r.kind === 'shell' && r.command === repo.setupCommand && r.cwd === path);
  if (last?.status === 'succeeded') return null;
  return startSetup(db, writer, card, repo, path, card.branchName);
}

/**
 * The repo's setup command, run in the tree and recorded for `startStage` to
 * wait on. Not awaited: see `ensureWorktree`.
 */
function startSetup(
  db: Db, writer: EventWriter, card: Card, repo: Repo, path: string, branch: string | null,
): string | null {
  if (!repo.setupCommand) return null;
  // The names a Server URL template can use, so a setup script can register
  // the same host with a local proxy. There is no port yet; each server start
  // picks its own.
  const handle = startShellRun({
    db, writer, cardId: card.id, stage: card.stage,
    command: repo.setupCommand, cwd: path,
    env: serverEnv(serverVars(card.id, branch)),
  });
  settingUp.set(card.id, handle);
  // Only its own entry: a tree removed and made again while this ran has a
  // setup of its own by now, and that is the one a start has to wait for.
  void handle.done.then(() => {
    if (settingUp.get(card.id) === handle) settingUp.delete(card.id);
  });
  return handle.runId;
}

export type BaseMerge =
  | { state: 'current' }
  | { state: 'merged'; baseSha: string; commits: number }
  | { state: 'skipped'; why: string };

/**
 * Bring what has landed on the repo's base since the card's branch was cut
 * into its reused worktree, before a stage starts there. A card that spent a
 * day in planning and review was otherwise built and tested against the main
 * it started from, and met everything merged since only as conflicts in Done.
 * Always, whatever the repo's "keep the default branch up to date" says: that
 * moves the person's own checkout, and this only the card's.
 *
 * A merge rather than a rebase, because the branch may already be pushed. It
 * is a fast-forward where the card has no commits yet. From `origin/<base>`,
 * as a new worktree is cut, never the person's local branch.
 *
 * Anything short of a clean merge leaves the branch as it was found and the
 * card says why: a fetch that fails, uncommitted work a merge could tangle
 * with, or conflicts, which are aborted and left for Done's resolve. The stage
 * starts either way. Once the base is in the branch, `baseSha` moves to it,
 * since the Diff tab and the commit list count from there and would otherwise
 * show everything just merged as the card's own work.
 */
export async function mergeLatestBase(db: Db, card: Card, repo: Repo, path: string): Promise<BaseMerge> {
  const base = repo.defaultBranch;
  const skip = (why: string): BaseMerge => {
    insertCardEvent(db, {
      cardId: card.id, actor: 'human', kind: 'note', stage: card.stage,
      body: `Started without the latest ${base}, because ${why}.`,
    });
    return { state: 'skipped', why };
  };

  let fetched: string;
  try {
    fetched = await fetchBranch(repo.repoPath, base);
  } catch (e) {
    return skip(`fetching origin/${base} failed: ${reason(e)}`);
  }
  if (await isAncestor(path, fetched)) {
    setBaseSha(db, card, fetched);
    return { state: 'current' };
  }
  // `.reeve/` is every stage's untracked record, not work. See openPullRequest.
  if (await isDirty(path, { ignore: ['.reeve'] })) return skip('the worktree has uncommitted changes');

  const commits = (await behindBase(path, base)) ?? 0;
  let merge: MergeStart;
  try {
    merge = await startMerge(path, `origin/${base}`);
  } catch (e) {
    return skip(`merging origin/${base} failed: ${reason(e)}`);
  }
  if (!merge.clean) {
    try {
      await abortMerge(path);
    } catch (e) {
      return skip(`merging origin/${base} conflicted in ${merge.conflicts.join(', ')}, and the merge could not be aborted: ${reason(e)}`);
    }
    return skip(`merging origin/${base} conflicted in ${merge.conflicts.join(', ')}; they are left for Resolve conflicts once the card is in Done`);
  }

  setBaseSha(db, card, fetched);
  insertCardEvent(db, {
    cardId: card.id, actor: 'human', kind: 'note', stage: card.stage,
    body: `Merged ${commits} new commit${commits === 1 ? '' : 's'} from origin/${base} (${fetched.slice(0, 7)}) before the stage started.`,
  });
  return { state: 'merged', baseSha: fetched, commits };
}

/**
 * Move a card's `baseSha` to a base it is now known to contain, so the Diff
 * tab and the commit list count from there rather than from where the card
 * started. Shared with `resolveConflicts`, which moves it the same way once
 * a Done card's branch has the base merged into it.
 */
export function setBaseSha(db: Db, card: Card, sha: string) {
  if (card.baseSha === sha) return;
  db.update(cardTable).set({ baseSha: sha, updatedAt: new Date() }).where(eq(cardTable.id, card.id)).run();
}

/**
 * How the card's setup command ended, once it has, or null when none is
 * running. Asked straight away, so a setup that finished before the start
 * reads as null: the tree was ready by then either way.
 */
export async function setupSettled(cardId: string) {
  const setup = settingUp.get(cardId);
  if (!setup) return null;
  return { runId: setup.runId, ...(await setup.done) };
}

export type WorktreeRemoval =
  | { removed: true; forced: boolean }
  | { removed: false };

/**
 * Take the card's worktree off disk: stop its dev servers, run the repo's
 * teardown command, then remove the tree and forget its path. Ordered so a
 * failed teardown never strands the tree. The branch is kept, so the Diff tab
 * and the commit list can still read what the card did from the main checkout.
 *
 * Always `--force`. `.reeve/` is untracked in every card's worktree, so git
 * would refuse to remove any of them without it. The event's `forced` is the
 * narrower question worth recording: whether work other than `.reeve/` went
 * with it. A directory already gone skips the teardown, which would only fail
 * for want of somewhere to run, and prunes git's record of it.
 *
 * `stillWanted` is asked of the card as it stands once the teardown is done,
 * since that can take a while and the card may have been restored in it.
 */
export async function removeCardWorktree(
  db: Db,
  writer: EventWriter,
  card: Card,
  repo: Repo,
  opts: { reason: 'archived' | 'by_hand'; stillWanted?: (fresh: Card) => boolean },
): Promise<WorktreeRemoval> {
  const path = card.worktreePath;
  if (!path) return { removed: false };
  for (const run of runRegistry.all().filter((r) => r.cardId === card.id && r.kind === 'server')) {
    await run.stop('cancelled_by_user');
  }
  const present = existsSync(path);
  if (present && repo.teardownCommand) {
    const handle = startShellRun({
      db, writer, cardId: card.id, stage: card.stage,
      command: repo.teardownCommand, cwd: path,
    });
    await handle.done;
  }

  const fresh = getCard(db, card.id);
  if (!fresh || fresh.worktreePath !== path || (opts.stillWanted && !opts.stillWanted(fresh))) {
    return { removed: false };
  }
  const forced = present && await isDirty(path, { ignore: ['.reeve'] }).catch(() => true);
  await removeWorktree(repo.repoPath, path, true);
  db.update(cardTable)
    .set({ worktreePath: null, updatedAt: new Date() })
    .where(eq(cardTable.id, card.id))
    .run();
  insertCardEvent(db, {
    cardId: card.id, actor: 'human', kind: 'worktree_removed', stage: fresh.stage,
    meta: { reason: opts.reason, path, branch: card.branchName, forced },
  });
  return { removed: true, forced };
}

/**
 * Start the card's current stage: make its worktree if need be, or bring the
 * base into the one it has, then its Claude run. The Run button and a card entering a runnable column both come
 * through here, so they refuse the same things for the same reasons.
 */
export async function startStage(
  db: Db,
  writer: EventWriter,
  card: Card,
  repo: Repo,
  // A person's message that started the stage, from the composer: shown at
  // the head of its conversation. Its words reach Claude as a note.
  opts: { userMessage?: ClaudeRunParams['userMessage'] } = {},
): Promise<StartStageResult> {
  if (card.kind === 'project') {
    return { ok: false, status: 400, error: 'a project has no stages', detail: 'split it into tasks instead' };
  }
  if (!isRunnable(card.stage as Stage)) {
    return { ok: false, status: 400, error: 'stage has no Claude work', detail: card.stage };
  }
  const stage = stageDefinition(card.stage as never);
  if (!stage) return { ok: false, status: 501, error: 'stage not implemented yet', detail: card.stage };
  const merged = refuseMergedWorktree(card);
  if (merged) return { ok: false, status: 409, ...merged };
  // The move route and approval already keep a blocked card from moving on,
  // so this is for the one that got past Backlog first: a dependency added, or
  // put back out of Done, after the card had left. It keeps its column, can
  // only be moved back to Backlog, and does not run until the dependency
  // clears. Before the worktree, so a card that may not start is not given one.
  const blocked = blockedStart(db, card);
  if (blocked) return { ok: false, ...blocked };
  // Taken before the first await, so no second start can slip in between
  // looking for a worktree and making one.
  if (starting.has(card.id)) {
    return { ok: false, status: 409, error: 'the stage is already starting', detail: `#${card.number}` };
  }
  starting.add(card.id);

  try {
    let path: string;
    let reused: boolean;
    try {
      ({ path, reused } = await ensureWorktree(db, writer, card, repo));
    } catch (e) {
      return { ok: false, status: 500, error: 'could not create the worktree', detail: reason(e) };
    }

    // The stage is told to get `npm test` green, and cannot install anything
    // to do it. Awaited before the card is read again, so a card dragged on
    // while `npm install` ran is still caught below and the cap is read as it
    // stands when Claude starts. `starting` is held all the while, so the card
    // reads as starting and `reeve card wait` keeps waiting. A VIBES sweep,
    // which awaits this, waits with it; a setup that hangs is let go by
    // stopping its run. One that failed does not hold the stage back — under
    // VIBES that would rerun it every sweep and never start — but the card
    // says so, since the stage's own checks will fail for the same reason.
    let setup = await setupSettled(card.id);

    // A new worktree was cut from the base just now. A reused one is brought
    // up to it, once setup has stopped writing to the tree and only if no
    // stage is running there: a Run pressed beside one is refused below, and
    // must not merge underneath it first. A merge that brought commits in
    // may have brought dependencies with them, so setup runs again.
    if (reused) {
      const live = liveStageRun(db, card.id);
      if (live) return { ok: false, status: 409, error: 'a run is already active for this card', detail: live.id };
      const merged = await mergeLatestBase(db, card, repo, path);
      if (merged.state === 'merged' && startSetup(db, writer, card, repo, path, card.branchName)) {
        setup = await setupSettled(card.id);
      }
    }

    // Read again, and nothing awaited from here to the run: the worktree has
    // just been written to the row, and the card may have been dragged on, or
    // archived, while it was being made.
    const fresh = getCard(db, card.id);
    if (!fresh || fresh.archivedAt || fresh.stage !== card.stage) {
      return { ok: false, status: 409, error: 'the card moved while its stage was starting', detail: fresh?.stage ?? 'gone' };
    }

    // A Suggest running beside the stage does not hold the card: it only reads,
    // and waiting on it to plan would make the button the thing that blocks.
    // The rows, not the registry, which only hears of a run once it has prepared.
    const live = liveStageRun(db, fresh.id);
    if (live) return { ok: false, status: 409, error: 'a run is already active for this card', detail: live.id };
    // Approving four cards at once shouldn't launch four sessions and burn
    // through budget in parallel. Read per start so a change in Settings
    // applies to the next run; lowering it stops nothing already going.
    const { maxConcurrentRuns } = getSettings(db);
    if (runRegistry.countByKind('claude') >= maxConcurrentRuns) {
      return { ok: false, status: 429, error: 'too many concurrent runs', detail: `limit is ${maxConcurrentRuns}` };
    }

    noteFailedSetup(db, fresh, setup);
    const handle = startClaudeRun({ db, writer, card: fresh, repo, stage, worktreePath: path, userMessage: opts.userMessage ?? null });
    return { ok: true, runId: handle.runId, sessionId: handle.sessionId };
  } finally {
    starting.delete(card.id);
  }
}

/** Written only once the run is certain to start, which is what the note says. */
function noteFailedSetup(db: Db, card: Card, setup: Awaited<ReturnType<typeof setupSettled>>) {
  if (!setup || setup.exitCode === 0 || setup.stopReason === 'cancelled_by_user') return;
  insertCardEvent(db, {
    cardId: card.id, actor: 'human', kind: 'note', stage: card.stage,
    body: `The repo's setup command failed (run ${setup.runId}), so the run started in a worktree it did not finish setting up.`,
  });
}

export type ContinueStageResult =
  // `done` settles once the run is finished and its row says how, for a caller
  // that has something to do then: a review in Gloss hands the next round back.
  | { ok: true; runId: string; done: Promise<void> }
  | { ok: false; error: string };

/**
 * Pick the card's stage back up in the worktree it already has: a revision
 * after a rejection, or the run that asked questions once they are answered.
 * Both fork a session that did its work in that tree, so a tree that has gone
 * is refused rather than made again the way `startStage` would.
 *
 * Otherwise the same wait `startStage` makes. A card whose setup failed when
 * its stage started, and was then rejected, would have its revision run in the
 * same unfinished tree with no retry; and one whose repo changed its setup
 * command since would never run the new one. So the setup the tree is owed is
 * run, and waited on, first. `starting` is held throughout, so a Run pressed,
 * or a second rejection sent, while `npm install` runs is refused rather than
 * starting beside this.
 *
 * Neither the concurrency cap nor `blockedStart` is asked, as neither was
 * before: the verdict or the answers are already recorded by now, and a
 * revision refused for the cap would leave a rejection with nothing after it.
 */
export async function continueStage(
  db: Db,
  writer: EventWriter,
  card: Card,
  repo: Repo,
  run: Omit<ClaudeRunParams, 'db' | 'writer' | 'card' | 'repo' | 'worktreePath'>,
): Promise<ContinueStageResult> {
  if (starting.has(card.id)) return { ok: false, error: 'the stage is already starting' };
  starting.add(card.id);

  try {
    const health = await checkWorktree(repo.repoPath, card.worktreePath);
    if (health.state !== 'ok') return { ok: false, error: 'card has no usable worktree' };
    owedSetup(db, writer, card, repo, health.path);
    const setup = await setupSettled(card.id);

    // Read again, as `startStage` does: a setup can take minutes, and the card
    // may have been approved on, dragged or archived while it ran.
    const fresh = getCard(db, card.id);
    if (!fresh || fresh.archivedAt || fresh.stage !== card.stage) {
      return { ok: false, error: 'the card moved while its stage was starting' };
    }
    const live = liveStageRun(db, fresh.id);
    if (live) return { ok: false, error: 'a run is already active for this card' };

    noteFailedSetup(db, fresh, setup);
    const handle = startClaudeRun({ ...run, db, writer, card: fresh, repo, worktreePath: health.path });
    return { ok: true, runId: handle.runId, done: handle.done };
  } finally {
    starting.delete(card.id);
  }
}

/**
 * The automatic start, for a card that has just entered a column Claude works
 * in. The routes that move cards call this without awaiting it, the same as
 * the automatic pull request: making a worktree takes seconds, and a drag
 * should not hang on it.
 *
 * Only a card the Run button would be offered on is started. One whose last
 * run in this column succeeded is waiting on its review, and a fresh run would
 * throw that attempt away. A refusal — the cap, a run still going from the
 * column it left — is not recorded: the card sits idle with its Run button,
 * which is where a person would have started it before. And nothing may
 * escape: an unhandled rejection here would take the server down. A project
 * has no stages, whatever column its row says it is in.
 */
export function maybeStartStage(db: Db, writer: EventWriter, card: Card, repo: Repo | undefined): void {
  if (!repo || card.archivedAt || card.kind === 'project') return;
  if (!canStartRun({ stage: card.stage as Stage, activity: cardActivity(db, card).activity })) return;
  startStage(db, writer, card, repo)
    .then((result) => {
      if (!result.ok) console.log(`[reeve] #${card.number} not started in ${card.stage}: ${result.error} (${result.detail})`);
    })
    .catch((e) => {
      console.error(`[reeve] starting #${card.number} in ${card.stage} failed: ${reason(e)}`);
    });
}
