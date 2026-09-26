import { eq } from 'drizzle-orm';
import { canStartRun, isRunnable, type Stage } from '@reeve/shared';
import { blockedStart } from './blockers.js';
import { cardActivity } from './board.js';
import type { Db } from './db/client.js';
import { getCard, getSettings, insertCardEvent, liveStageRun } from './db/queries.js';
import { card as cardTable, type Card, type Repo } from './db/schema.js';
import { fetchBranch } from './git/github.js';
import { GitError, checkWorktree, copyWorktreeIncludes, createWorktree } from './git/worktree.js';
import { startClaudeRun } from './runs/claude.js';
import type { EventWriter } from './runs/events.js';
import { runRegistry } from './runs/registry.js';
import { startShellRun } from './runs/shell.js';
import { stageDefinition } from './stages/index.js';

/**
 * Cards with a start under way. Making a worktree takes seconds, and a drag
 * followed by a press of Run in that time would otherwise both find no tree
 * and both try to make one.
 */
const starting = new Set<string>();

/**
 * Whether a start is under way for the card: its worktree is being made and
 * its run has no row yet. For those seconds the card reads as idle, and
 * `reeve card wait` has to be able to tell that from a card nothing is going
 * to start.
 */
export const isStartingStage = (cardId: string) => starting.has(cardId);

export type StartStageResult =
  | { ok: true; runId: string; sessionId: string }
  | { ok: false; status: 400 | 409 | 429 | 500 | 501; error: string; detail: string };

const reason = (e: unknown) => (e instanceof GitError ? e.stderr || e.message : String(e));

/**
 * The card's worktree, made if it is not there yet. A new one is given the
 * files the repo's `.worktreeinclude` names, and if the repo defines a setup
 * command, that is kicked off as a background shell run and not awaited: it is
 * a different run kind, so it counts against neither the card's active run nor
 * the concurrency cap.
 */
export async function ensureWorktree(db: Db, writer: EventWriter, card: Card, repo: Repo) {
  const health = await checkWorktree(repo.repoPath, card.worktreePath);
  if (health.state === 'ok') return { reused: true as const, path: health.path };

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

  let setupRunId: string | null = null;
  if (repo.setupCommand) {
    const handle = startShellRun({
      db, writer, cardId: card.id, stage: card.stage,
      command: repo.setupCommand, cwd: created.path,
    });
    setupRunId = handle.runId;
  }
  return { reused: false as const, path: created.path, branch: created.branch, setupRunId, included };
}

/**
 * Start the card's current stage: make its worktree if need be, then its
 * Claude run. The Run button and a card entering a runnable column both come
 * through here, so they refuse the same things for the same reasons.
 */
export async function startStage(db: Db, writer: EventWriter, card: Card, repo: Repo): Promise<StartStageResult> {
  if (card.kind === 'project') {
    return { ok: false, status: 400, error: 'a project has no stages', detail: 'split it into tasks instead' };
  }
  if (!isRunnable(card.stage as Stage)) {
    return { ok: false, status: 400, error: 'stage has no Claude work', detail: card.stage };
  }
  const stage = stageDefinition(card.stage as never);
  if (!stage) return { ok: false, status: 501, error: 'stage not implemented yet', detail: card.stage };
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
    try {
      ({ path } = await ensureWorktree(db, writer, card, repo));
    } catch (e) {
      return { ok: false, status: 500, error: 'could not create the worktree', detail: reason(e) };
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

    const handle = startClaudeRun({ db, writer, card: fresh, repo, stage, worktreePath: path });
    return { ok: true, runId: handle.runId, sessionId: handle.sessionId };
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
