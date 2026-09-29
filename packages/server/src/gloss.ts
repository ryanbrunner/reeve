import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { STAGE_LABELS, nextStage, type GlossReviewResponse, type Stage, type StopReason } from '@reeve/shared';
import { blockedMove } from './blockers.js';
import { cardActivity, entryRefusal } from './board.js';
import type { Db } from './db/client.js';
import { getCard, getRun, insertCardEvent, listRepos, liveTaskRun, reviewsForCard } from './db/queries.js';
import type { Card, Repo, Run } from './db/schema.js';
import { failureOutput } from './git/worktree.js';
import { shellQuote } from './handoff.js';
import { approveStage, sendBackForRevision } from './review.js';
import { ensureDevServer, waitForServer } from './runs/devServer.js';
import type { EventWriter } from './runs/events.js';
import { runRegistry } from './runs/registry.js';
import { startShellRun } from './runs/shell.js';
import { stageDefinition } from './stages/index.js';
import { isStartingStage } from './startStage.js';

const exec = promisify(execFile);

/**
 * Reviewing what a card built by using it: the card's dev server, open in
 * Gloss, a browser window with a feedback bar across the top.
 *
 * Built on crit.ts and shaped the same way. `gloss wait` blocks until the
 * reviewer submits a round or approves, so it runs as a shell run beside the
 * stage: its output is in the log, Stop works, and the modal polls while it
 * is live. When it exits, its verdict is read back and becomes the same
 * verdict the buttons give.
 *
 * Unlike a review in Crit, one session lasts across rounds. Comments send the
 * card back for a revision, the window is told Claude is working, and when
 * the revision is ready for review again the window reloads onto it and the
 * next `gloss wait` starts, with no one pressing anything in Reeve. The loop
 * ends at an approval, a Stop, the window closing, or a revision that does not
 * come back ready for review.
 */

export const GLOSS_TASK = 'gloss_review';
const GLOSS_TIMEOUT_MS = 30_000;

/**
 * What `gloss wait` prints (Gloss's docs/verdict.md). Loose where Gloss says
 * the document may grow; `target` is a pinned comment's element, whose shape
 * only its `selector` is relied on here.
 */
const glossVerdict = z.object({
  version: z.number(),
  approved: z.boolean(),
  round: z.number(),
  page: z.string().nullable().optional(),
  comments: z.array(
    z.object({
      body: z.string(),
      page: z.string().nullable().optional(),
      target: z.record(z.string(), z.unknown()).nullable().optional(),
    }),
  ),
});
type GlossVerdict = z.infer<typeof glossVerdict>;

const glossStatus = z.object({ running: z.boolean(), phase: z.string().nullable().optional() });

export type GlossStart =
  | ({ ok: true } & GlossReviewResponse)
  | { ok: false; error: string; detail?: string; status: 400 | 409 };

/** Everything a round needs to find its session and the card again, long after the request. */
interface Session {
  cardId: string;
  stage: Stage;
  cwd: string;
  /** Gloss's `--name`, which with `cwd` picks the session. */
  name: string;
  /** The dev server page the window shows, kept on each round's row. */
  url: string;
}

/**
 * Open the card's running app in Gloss, or answer with the round already
 * waiting on the reviewer.
 *
 * The caller has checked the card's stage is waiting for review. The dev
 * server is started if it is not already, and waited on: Gloss shows a
 * connection error as readily as a page.
 */
export async function startGlossReview(
  db: Db,
  writer: EventWriter,
  card: Card,
  repo: Repo,
  worktreePath: string,
  reviewedRun: Run,
): Promise<GlossStart> {
  try {
    await exec('gloss', ['--help'], { timeout: GLOSS_TIMEOUT_MS });
  } catch (cause) {
    return (cause as { code?: unknown }).code === 'ENOENT'
      ? { ok: false, error: 'gloss is not installed', detail: 'there is no gloss on the server’s PATH', status: 400 }
      : { ok: false, error: 'gloss did not run', detail: failureOutput(cause, GLOSS_TIMEOUT_MS), status: 400 };
  }

  const live = liveTaskRun(db, card.id, GLOSS_TASK);
  if (live) return { ok: true, runId: live.id, url: live.url ?? '', reused: true };

  // Unlike Crit's, the start awaits a dev server and a window before the
  // round's row exists, long enough for a second click to start a second.
  if (opening.has(card.id)) return { ok: false, error: 'Gloss is already opening', status: 409 };
  opening.add(card.id);
  try {
    return await openSession(db, writer, card, repo, worktreePath, reviewedRun);
  } finally {
    opening.delete(card.id);
  }
}

/** Cards whose review in Gloss is being opened. See `startGlossReview`. */
const opening = new Set<string>();

async function openSession(
  db: Db,
  writer: EventWriter,
  card: Card,
  repo: Repo,
  worktreePath: string,
  reviewedRun: Run,
): Promise<GlossStart> {
  const server = await ensureDevServer(db, writer, card, repo);
  if (server.state === 'unavailable') {
    return { ok: false, error: 'no dev server to review', detail: server.reason, status: 400 };
  }
  const answer = await waitForServer(db, server.runId);
  if (answer.state !== 'answered') {
    return {
      ok: false,
      error: 'the dev server is not answering',
      detail:
        answer.state === 'no-url' ? 'it never said where it was serving; give the repo a Server URL or a {{port}} in its command'
        : answer.state === 'no-answer' ? `nothing answered at ${answer.url}`
        : `it stopped${answer.reason ? ` (${answer.reason})` : ''}`,
      status: 409,
    };
  }

  // One session per card and column. Gloss keeps an approved session approved,
  // and every `gloss wait` after reprints the approval: a session shared with
  // the column before would approve this one the moment it was asked.
  const session: Session = {
    cardId: card.id, stage: card.stage as Stage, cwd: worktreePath,
    name: `reeve-${card.id.slice(0, 8)}-${card.stage}`, url: answer.url,
  };

  // A session left in a phase no one is waiting on, by a Reeve that stopped or
  // restarted while it was open. An approval is closed rather than reused, for
  // the reason above. A round marked working is handed back, or `gloss wait`
  // refuses to start. A round submitted and never read is left for the wait to
  // pick up: the reviewer sent it for this card in this column, and this build
  // is the one waiting on review now.
  const phase = await sessionPhase(session);
  if (phase === 'approved') await gloss(session, 'close').catch(() => {});
  if (phase === 'working') await gloss(session, 'ready', 'Reeve lost track of this round. Here is the build as it stands.').catch(() => {});

  try {
    await gloss(session, 'open', answer.url);
  } catch (cause) {
    return { ok: false, error: 'gloss could not open the window', detail: failureOutput(cause, GLOSS_TIMEOUT_MS), status: 409 };
  }
  return { ok: true, runId: startRound(db, writer, session, reviewedRun.id), url: answer.url, reused: false };
}

/**
 * One `gloss wait`, for the build `reviewedRunId` produced. Everything from
 * here to the row being written is synchronous, so a second click finds it.
 */
function startRound(db: Db, writer: EventWriter, session: Session, reviewedRunId: string): string {
  // Pretty-printed, so the document is every line of stdout together. Progress
  // goes to stderr and never reaches it.
  const stdout: string[] = [];
  const handle = startShellRun({
    db, writer, cardId: session.cardId, stage: session.stage,
    command: `gloss wait --name ${shellQuote(session.name)}`,
    cwd: session.cwd,
    task: GLOSS_TASK,
    // Where the window points, so a modal opened later can still say.
    url: session.url,
    onLine: (kind, line) => {
      if (kind === 'stdout') stdout.push(line);
    },
  });
  void handle.done.then(
    (result) => finishRound(db, writer, session, reviewedRunId, { ...result, stdout: stdout.join('\n') }),
    (err: unknown) => recordOutcome(db, session, reviewedRunId, 'failed', `Gloss review ended badly: ${String(err)}`),
  );
  return handle.runId;
}

/**
 * Turn a round's verdict into a move, or into a record of why there isn't one.
 *
 * Runs long after anything that started it, so the card is read again, and
 * nothing is applied unless the build reviewed is still the one waiting.
 * Anything thrown here would take the server down, so nothing is.
 */
async function finishRound(
  db: Db,
  writer: EventWriter,
  session: Session,
  reviewedRunId: string,
  result: { exitCode: number | null; stopReason: StopReason; stdout: string },
): Promise<void> {
  try {
    // Stopped from Reeve: nothing is listening any more, so the window goes
    // too, rather than taking comments no one will read.
    if (result.stopReason === 'cancelled_by_user') {
      await gloss(session, 'close').catch(() => {});
      recordOutcome(db, session, reviewedRunId, 'cancelled', null);
      return;
    }
    // Exit 1 with nothing on stdout is Gloss's "no verdict": the window was
    // closed, or the session ended while it waited.
    if (result.stopReason !== 'completed' || result.exitCode !== 0) {
      recordOutcome(db, session, reviewedRunId, 'failed',
        `gloss wait exited with code ${result.exitCode ?? 'unknown'}: the window was closed, or the session ended, before a verdict.`);
      return;
    }

    // Only a version 1 document that parses counts. Anything else is no
    // verdict, and never an approval.
    let verdict: GlossVerdict;
    try {
      const parsed = glossVerdict.safeParse(JSON.parse(result.stdout));
      if (!parsed.success) throw new Error('the verdict was not in the shape expected');
      if (parsed.data.version !== 1) throw new Error(`the verdict is version ${parsed.data.version}, not 1`);
      verdict = parsed.data;
    } catch (cause) {
      recordOutcome(db, session, reviewedRunId, 'failed', `Could not read the verdict back from Gloss: ${String(cause)}`);
      return;
    }
    const meta = { round: verdict.round };

    const card = getCard(db, session.cardId);
    const repo = card?.repoId ? listRepos(db).find((p) => p.id === card.repoId) : undefined;
    const stale = staleReason(db, card, repo, session.stage, reviewedRunId);
    const run = card && cardActivity(db, card).run;
    if (stale || !card || !repo || !run) {
      // The window would otherwise wait on a round no one is going to answer.
      await gloss(session, 'close').catch(() => {});
      recordOutcome(db, session, reviewedRunId, 'not_applied',
        `Nothing was sent back or approved: ${stale ?? 'the build is no longer there'}.`,
        { ...meta, approved: verdict.approved, comments: verdict.comments.length });
      return;
    }

    if (verdict.approved === true) {
      // The Approve button's refusals, asked before `approveStage` records a
      // verdict for a move that cannot happen.
      const to = nextStage(card.stage as Stage) ?? card.stage;
      const refused = blockedMove(db, card, to)?.detail ?? entryRefusal(db, card, to);
      if (refused) {
        recordOutcome(db, session, reviewedRunId, 'not_applied', `Nothing was approved: ${refused}.`, meta);
        return;
      }
      approveStage(db, writer, card, repo, run, { meta: { via: 'gloss', ...meta } });
      await gloss(session, 'close').catch(() => {});
      return;
    }

    // The bar will not submit an empty round, so one that arrives is not a
    // verdict either way.
    const comments = verdict.comments.filter((c) => c.body.trim());
    if (comments.length === 0) {
      recordOutcome(db, session, reviewedRunId, 'failed', 'Gloss sent a round with no comments and no approval.', meta);
      return;
    }

    // Left as submitted if this fails: pressing Review in Gloss again picks the
    // same round up, so the comments are not lost with the start.
    const revision = await sendBackForRevision(
      db, writer, card, repo, run, formatNotes(verdict, comments),
      { via: 'gloss', ...meta, comments: comments.length },
    );
    if (!revision.ok) {
      recordOutcome(db, session, reviewedRunId, 'failed',
        `Sent back from Gloss, but the revision did not start: ${revision.error}.`, meta);
      return;
    }

    const n = comments.length;
    await gloss(session, 'working', `Claude is revising the build: ${n} comment${n === 1 ? '' : 's'} from round ${verdict.round}.`)
      .catch(() => {});
    await revision.done;
    await handBack(db, writer, session, revision.revisionRunId, verdict.round);
  } catch (err) {
    recordOutcome(db, session, reviewedRunId, 'failed', `Gloss review ended badly: ${String(err)}`);
  }
}

/**
 * The revision is over: reload the window onto it, and wait on the next round
 * if it is a build to review. Otherwise the window is told why not, and the
 * loop ends there; Review in Gloss starts it again once there is one.
 */
async function handBack(db: Db, writer: EventWriter, session: Session, revisionRunId: string, round: number) {
  const card = getCard(db, session.cardId);
  const repo = card?.repoId ? listRepos(db).find((p) => p.id === card.repoId) : undefined;
  const revision = getRun(db, revisionRunId);
  const stale = staleReason(db, card, repo, session.stage, revisionRunId);
  const activity = card && cardActivity(db, card).activity;

  if (!stale && revision) {
    try {
      await gloss(session, 'ready', summaryOf(session.stage, revision));
    } catch (cause) {
      recordOutcome(db, session, revisionRunId, 'failed',
        `The revision is ready, but Gloss could not be told: ${failureOutput(cause, GLOSS_TIMEOUT_MS)}`, { round });
      return;
    }
    startRound(db, writer, session, revisionRunId);
    return;
  }

  const why =
    activity === 'needs_input' ? 'Claude asked questions about your comments. Answer them in Reeve.'
    : activity === 'error' ? 'The revision did not finish. See the card in Reeve.'
    : `This review is over in Reeve: ${stale ?? 'the revision is gone'}.`;
  await gloss(session, 'ready', why).catch(() => {});
  recordOutcome(db, session, revisionRunId, 'ended', why, { round });
}

/**
 * Why the build reviewed is no longer the one waiting for review, or null if
 * it still is. Crit's, for any column with a running app: the buttons used
 * while Gloss was open, or a revision that ended in questions, must not have
 * a late verdict move the card a second time.
 */
function staleReason(
  db: Db, card: Card | undefined, repo: Repo | undefined, stage: Stage, reviewedRunId: string,
): string | null {
  if (!card) return 'the card is gone';
  if (card.archivedAt) return 'the card was archived';
  if (!repo) return 'the card has no repo';
  if (card.stage !== stage) return `the card is in ${STAGE_LABELS[card.stage as Stage]} now`;
  if (reviewsForCard(db, card.id).some((r) => r.runId === reviewedRunId)) return 'the build had already been reviewed';
  if (isStartingStage(card.id)) return 'Claude is starting on the card';
  if (runRegistry.all().some((r) => r.cardId === card.id && r.kind === 'claude' && !r.outOfBand)) {
    return 'Claude is running on the card';
  }
  const { activity, run } = cardActivity(db, card);
  if (run?.id !== reviewedRunId) return 'a newer run replaced the build reviewed';
  if (activity !== 'needs_review') return 'the build is no longer waiting for review';
  return null;
}

/** What the window shows beside the reload: the stage's own one-line summary of the run. */
function summaryOf(stage: Stage, run: Run): string {
  const fallback = 'Claude has revised the build.';
  const definition = stageDefinition(stage as never);
  if (!definition) return fallback;
  const parsed = definition.schema.safeParse(run.structuredOutput);
  return parsed.success ? definition.summarise(parsed.data) : fallback;
}

/** Where the session stands, or null when there is none or Gloss would not say. */
async function sessionPhase(session: Session): Promise<string | null> {
  // `gloss status` answers "no session" with exit 1 and the JSON still on stdout.
  let stdout: string;
  try {
    ({ stdout } = await exec('gloss', ['status', '--name', session.name, '--json'], {
      cwd: session.cwd, timeout: GLOSS_TIMEOUT_MS,
    }));
  } catch (cause) {
    stdout = String((cause as { stdout?: unknown }).stdout ?? '');
  }
  try {
    const parsed = glossStatus.safeParse(JSON.parse(stdout));
    return parsed.success && parsed.data.running ? (parsed.data.phase ?? null) : null;
  } catch {
    return null;
  }
}

/** One of Gloss's short commands, against this card's session. */
function gloss(session: Session, command: 'open' | 'close' | 'working' | 'ready', arg?: string) {
  return exec('gloss', [command, ...(arg ? [arg] : []), '--name', session.name], {
    cwd: session.cwd, timeout: GLOSS_TIMEOUT_MS,
  });
}

function recordOutcome(
  db: Db,
  session: Session,
  runId: string,
  outcome: 'cancelled' | 'failed' | 'not_applied' | 'ended',
  body: string | null,
  meta: Record<string, unknown> = {},
): void {
  try {
    insertCardEvent(db, {
      cardId: session.cardId, actor: 'human', kind: 'gloss_reviewed', stage: session.stage,
      runId, body, meta: { ...meta, outcome },
    });
  } catch (err) {
    // The card itself may be gone; there is nowhere left to say so.
    console.error(`[reeve] gloss review outcome for card ${session.cardId} went unrecorded: ${String(err)}`);
  }
}

/**
 * Every comment in full, under the page it was written on and, for one pinned
 * to an element, the element's selector: the next run has only these words to
 * find what the reviewer was looking at.
 */
function formatNotes(verdict: GlossVerdict, comments: GlossVerdict['comments']): string {
  return comments
    .map((c) => {
      const page = pagePath(c.page ?? verdict.page ?? null);
      const selector = typeof c.target?.['selector'] === 'string' ? c.target['selector'] : null;
      const where = [page ? `On ${page}` : 'On the app as a whole', selector ? `at \`${selector}\`` : null]
        .filter(Boolean)
        .join(', ');
      return `**${where}**\n${c.body.trim()}`;
    })
    .join('\n\n');
}

/** A page's path, which outlives the dev server's port from one round to the next. */
function pagePath(page: string | null): string | null {
  if (!page) return null;
  try {
    const url = new URL(page);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return page;
  }
}
