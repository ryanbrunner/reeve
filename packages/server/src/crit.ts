import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { STAGE_LABELS, type CritReviewResponse, type StopReason } from '@reeve/shared';
import { blockedMove } from './blockers.js';
import { cardActivity } from './board.js';
import type { Db } from './db/client.js';
import {
  artifactsForCard,
  getCard,
  insertCardEvent,
  listRepos,
  liveTaskRun,
  reviewsForCard,
  runsForCard,
  setRunStatus,
} from './db/queries.js';
import type { Card, Repo, Run } from './db/schema.js';
import { failureOutput } from './git/worktree.js';
import { shellQuote } from './handoff.js';
import { approveStage, sendBackForRevision } from './review.js';
import type { EventWriter } from './runs/events.js';
import { runRegistry } from './runs/registry.js';
import { startShellRun } from './runs/shell.js';
import { blockquote } from './stages/template.js';

const exec = promisify(execFile);

/**
 * Reviewing a plan in Crit, the local review tool, instead of the text box.
 *
 * `crit plan` opens the plan in the browser and blocks until the reviewer
 * clicks Finish Review, so it runs as a shell run: its output is in the log,
 * Stop works, and the modal already polls while a task is live. When it exits
 * the comments are read back as structured data and become the same verdict
 * the buttons give — comments send the plan back, none approve it.
 */

export const CRIT_TASK = 'crit_review';
const PLAN_PATH = '.reeve/plan.md';
/** How long the request waits for Crit to say where it is serving. */
const URL_WAIT_MS = 10_000;
const CRIT_TIMEOUT_MS = 30_000;

/**
 * One entry of `crit comments --json`. Only `body` is required: the rest is
 * where the comment sits, and a comment without a place is still feedback.
 */
const critComments = z.array(
  z.object({
    body: z.string(),
    scope: z.string().optional(),
    start_line: z.number().optional(),
    end_line: z.number().optional(),
    quote: z.string().optional(),
    anchor: z.string().optional(),
    resolved: z.boolean().optional(),
  }),
);
type CritComment = z.infer<typeof critComments>[number];

export type CritStart =
  | ({ ok: true } & CritReviewResponse)
  | { ok: false; error: string; detail?: string; status: 400 | 409 };

/**
 * Open the card's current plan in Crit, or answer with the review already open.
 *
 * The caller has checked the card is a plan waiting for review. Everything
 * from the reuse check to the run's row being written is synchronous, so two
 * clicks close together cannot both start one.
 */
export async function startCritReview(
  db: Db,
  writer: EventWriter,
  card: Card,
  worktreePath: string,
  planRun: Run,
): Promise<CritStart> {
  try {
    await exec('crit', ['--version'], { timeout: CRIT_TIMEOUT_MS });
  } catch (cause) {
    return (cause as { code?: unknown }).code === 'ENOENT'
      ? { ok: false, error: 'crit is not installed', detail: 'there is no crit on the server’s PATH', status: 400 }
      : { ok: false, error: 'crit did not run', detail: failureOutput(cause, CRIT_TIMEOUT_MS), status: 400 };
  }

  const live = liveTaskRun(db, card.id, CRIT_TASK);
  if (live) return { ok: true, runId: live.id, url: live.port ? critUrl(live.port) : null, reused: true };

  // The row outlives the file, which can be deleted by hand or cleaned away.
  const path = join(worktreePath, PLAN_PATH);
  if (!existsSync(path)) {
    const plans = artifactsForCard(db, card.id).filter((a) => a.kind === 'plan');
    const content = (plans.find((a) => a.runId === planRun.id) ?? plans[0])?.content;
    if (!content) return { ok: false, error: 'no plan to review', detail: `${PLAN_PATH} is missing`, status: 409 };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }

  // One slug per plan version. Crit keeps a comment unresolved from one round
  // to the next, so reusing a slug would send the last round's notes again.
  const version = runsForCard(db, card.id).filter(
    (r) => r.kind === 'claude' && r.task === null && r.stage === 'planning' && r.status === 'succeeded',
  ).length;
  const slug = `reeve-${card.id.slice(0, 8)}-v${version}`;

  let announce: (url: string | null) => void = () => {};
  const announced = new Promise<string | null>((resolve) => (announce = resolve));
  let runId = '';
  let urlSeen = false;
  let critApproved: boolean | null = null;

  const handle = startShellRun({
    db, writer, cardId: card.id, stage: card.stage,
    command: `crit plan --name ${slug} ${shellQuote(path)}`,
    cwd: worktreePath,
    task: CRIT_TASK,
    // "Started crit daemon at http://…" or "Connected to …", on stderr. The
    // port goes on the row so a modal opened later can still link to it.
    onLine: (_kind, line) => {
      const said = /^approved: (true|false)$/.exec(line.trim())?.[1];
      if (said) critApproved = said === 'true';
      const url = urlSeen ? null : /https?:\/\/[^\s)]+/.exec(line)?.[0];
      if (!url) return;
      urlSeen = true;
      const port = Number(/^https?:\/\/[^/]+:(\d+)/.exec(url)?.[1]);
      if (port) setRunStatus(db, runId, { port });
      announce(url);
    },
  });
  runId = handle.runId;

  void handle.done.then(
    (result) => finishCritReview(db, writer, card.id, planRun.id, slug, worktreePath, { ...result, critApproved }),
    (err: unknown) => recordOutcome(db, card.id, planRun.id, 'failed', `Crit review ended badly: ${String(err)}`),
  );

  // A crit that fails at once answers at once, rather than after the wait.
  let timer: NodeJS.Timeout | undefined;
  const url = await Promise.race([
    announced,
    handle.done.then(() => null),
    new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), URL_WAIT_MS))),
  ]);
  clearTimeout(timer);

  if (!url && !runRegistry.get(runId)) {
    const row = runsForCard(db, card.id).find((r) => r.id === runId);
    return {
      ok: false,
      error: 'crit exited before the review opened',
      detail: row?.errorMessage ?? 'see the run log',
      status: 409,
    };
  }
  return { ok: true, runId, url, reused: false };
}

/** Crit binds to loopback, so this is only a link on the machine running Reeve. */
function critUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * Turn a finished review into a verdict, or into a record of why there isn't one.
 *
 * Runs long after the request that started it — a review can sit open for
 * hours — so the card is read again, and nothing is applied unless the plan
 * reviewed is still the one waiting. Anything thrown here would take the
 * server down, so nothing is.
 */
async function finishCritReview(
  db: Db,
  writer: EventWriter,
  cardId: string,
  planRunId: string,
  slug: string,
  cwd: string,
  result: { exitCode: number | null; stopReason: StopReason; critApproved: boolean | null },
): Promise<void> {
  try {
    // Checked before the exit code: a `crit plan` stopped while it owns the
    // daemon shuts it down and exits 0.
    if (result.stopReason === 'cancelled_by_user') {
      recordOutcome(db, cardId, planRunId, 'cancelled', null);
      return;
    }
    if (result.stopReason !== 'completed' || result.exitCode !== 0) {
      recordOutcome(db, cardId, planRunId, 'failed', `crit exited with code ${result.exitCode ?? 'unknown'}.`);
      return;
    }

    // Only a clean exit that parses to a list counts. Unreadable output read
    // as "no comments" would approve a plan the reviewer had objected to.
    let comments: CritComment[];
    try {
      const { stdout } = await exec('crit', ['comments', '--plan', slug, '--json'], {
        cwd, timeout: CRIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
      });
      const parsed = critComments.safeParse(JSON.parse(stdout));
      if (!parsed.success) throw new Error('the comment list was not in the shape expected');
      // Crit's own convention: a resolved comment is settled, not feedback.
      comments = parsed.data.filter((c) => !c.resolved);
    } catch (cause) {
      recordOutcome(db, cardId, planRunId, 'failed',
        `Could not read the comments back from Crit: ${failureOutput(cause, CRIT_TIMEOUT_MS) || String(cause)}`);
      return;
    }

    const card = getCard(db, cardId);
    const repo = card?.repoId ? listRepos(db).find((p) => p.id === card.repoId) : undefined;
    const stale = staleReason(db, card, repo, planRunId);
    const run = card && cardActivity(db, card).run;
    if (stale || !card || !repo || !run) {
      recordOutcome(db, cardId, planRunId, 'not_applied',
        `Nothing was sent back or approved: ${stale ?? 'the plan is no longer there'}.`,
        { comments: comments.length });
      return;
    }

    if (comments.length === 0) {
      // Crit's own `approved:` line never makes the decision, but it can veto
      // one: if Crit saw comments and none came back, the list was read from
      // the wrong place, and approving would bury the reviewer's objections.
      if (result.critApproved === false) {
        recordOutcome(db, cardId, planRunId, 'failed',
          'Crit reported unresolved comments, but none could be read back. Nothing was approved.');
        return;
      }
      // The Approve button refuses a card waiting on another, and so does this,
      // before `approveStage` records a verdict for a move that cannot happen.
      // Crit is on a Planning card, and approving it moves it to In Progress.
      const blocked = blockedMove(db, card, 'in_progress');
      if (blocked) {
        recordOutcome(db, cardId, planRunId, 'not_applied',
          `Nothing was approved: the card waits on ${blocked.detail}.`);
        return;
      }
      approveStage(db, writer, card, repo, run, { meta: { via: 'crit' } });
      return;
    }
    const revision = await sendBackForRevision(
      db, writer, card, repo, run, formatNotes(comments), { via: 'crit', comments: comments.length },
    );
    if (!revision.ok) {
      recordOutcome(db, cardId, planRunId, 'failed', `Sent back from Crit, but the revision did not start: ${revision.error}.`);
    }
  } catch (err) {
    recordOutcome(db, cardId, planRunId, 'failed', `Crit review ended badly: ${String(err)}`);
  }
}

/**
 * Why the plan reviewed is no longer the one waiting for review, or null if it
 * still is. Clicking Mark reviewed or Leave feedback while Crit was open is
 * the usual cause; a late Finish must not move a card a second time.
 */
function staleReason(db: Db, card: Card | undefined, repo: Repo | undefined, planRunId: string): string | null {
  if (!card) return 'the card is gone';
  if (card.archivedAt) return 'the card was archived';
  if (!repo) return 'the card has no repo';
  if (card.stage !== 'planning') return `the card is in ${STAGE_LABELS[card.stage]} now`;
  if (reviewsForCard(db, card.id).some((r) => r.runId === planRunId)) return 'the plan had already been reviewed';
  if (runRegistry.all().some((r) => r.cardId === card.id && r.kind === 'claude' && !r.outOfBand)) {
    return 'Claude is running on the card';
  }
  const { activity, run } = cardActivity(db, card);
  if (run?.id !== planRunId) return 'a newer plan replaced the one reviewed';
  if (activity !== 'needs_review') return 'the plan is no longer waiting for review';
  return null;
}

function recordOutcome(
  db: Db,
  cardId: string,
  runId: string,
  outcome: 'cancelled' | 'failed' | 'not_applied',
  body: string | null,
  meta: Record<string, unknown> = {},
): void {
  try {
    insertCardEvent(db, {
      cardId, actor: 'human', kind: 'crit_reviewed', stage: 'planning',
      runId, body, meta: { ...meta, outcome },
    });
  } catch (err) {
    // The card itself may be gone; there is nowhere left to say so.
    console.error(`[reeve] crit review outcome for card ${cardId} went unrecorded: ${String(err)}`);
  }
}

/** Every comment in full, with where it sits in `.reeve/plan.md` when Crit knows. */
function formatNotes(comments: CritComment[]): string {
  return comments
    .map((c) => {
      const where =
        c.scope === 'review' || c.scope === 'file' || !c.start_line ? 'On the plan as a whole'
        : c.end_line && c.end_line !== c.start_line ? `Lines ${c.start_line}–${c.end_line} of ${PLAN_PATH}`
        : `Line ${c.start_line} of ${PLAN_PATH}`;
      const heading = c.anchor ? `**${where}, under “${c.anchor}”**` : `**${where}**`;
      const quote = c.quote?.trim();
      return [heading, quote ? blockquote(quote) : null, c.body.trim()].filter(Boolean).join('\n');
    })
    .join('\n\n');
}
