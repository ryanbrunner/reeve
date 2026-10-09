import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { STAGE_LABELS, isRunnable, nextStage, type CritReviewResponse, type Stage, type StopReason } from '@reeve/shared';
import { blockedMove } from './blockers.js';
import { sendToCard } from './conversation.js';
import type { Db } from './db/client.js';
import {
  artifactsForCard,
  cardEventsFor,
  getCard,
  insertCardEvent,
  latestDeliverableRun,
  listRepos,
  liveStageRun,
  liveTaskRun,
  reviewsForCard,
  runsForCard,
  setRunStatus,
} from './db/queries.js';
import type { Card, Run } from './db/schema.js';
import { failureOutput } from './git/worktree.js';
import { shellQuote } from './handoff.js';
import { approveStage } from './review.js';
import { isStartingStage } from './startStage.js';
import type { EventWriter } from './runs/events.js';
import { runRegistry } from './runs/registry.js';
import { startShellRun } from './runs/shell.js';
import { blockquote, renderPrompt } from './stages/template.js';

const exec = promisify(execFile);

/**
 * Reviewing in Crit, the local review tool, instead of the text box: the plan,
 * line by line, or the changes on the card's branch, as a diff.
 *
 * Crit opens in the browser and blocks until the reviewer clicks Finish
 * Review, so it runs as a shell run: its output is in the log, Stop works, and
 * the modal already polls while a task is live. When it exits the comments are
 * read back as structured data and go into the card's conversation as one
 * message from the person — read by Claude at its next step if it is working,
 * or carrying the stage on if not. Finishing with none approves the stage, as
 * the button does, when that work is the one waiting at the gate; otherwise it
 * is recorded and nothing moves.
 */

export const CRIT_TASK = 'crit_review';
const PLAN_PATH = '.reeve/plan.md';

/** What a review in Crit is of. */
export type CritTarget = 'plan' | 'changes';
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
    id: z.string().optional(),
    // Set on a comment on the changes: which file it is in.
    path: z.string().optional(),
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
 * Open the card's plan, or its changes, in Crit, or answer with the review
 * already open.
 *
 * Everything from the reuse check to the run's row being written is
 * synchronous, so two clicks close together cannot both start one.
 */
export async function startCritReview(
  db: Db,
  writer: EventWriter,
  card: Card,
  worktreePath: string,
  target: CritTarget,
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

  let command: string;
  let slug: string | null = null;
  if (target === 'plan') {
    const plans = artifactsForCard(db, card.id).filter((a) => a.kind === 'plan');
    // The row outlives the file, which can be deleted by hand or cleaned away.
    const path = join(worktreePath, PLAN_PATH);
    if (!existsSync(path)) {
      const content = plans[0]?.content;
      if (!content) return { ok: false, error: 'no plan to review', detail: `${PLAN_PATH} is missing`, status: 409 };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, 'utf8');
    }
    // One slug per plan version. Crit keeps a comment unresolved from one round
    // to the next, so reusing a slug would send the last round's notes again.
    const version = runsForCard(db, card.id).filter(
      (r) => r.kind === 'claude' && r.task === null && r.stage === 'planning' && r.status === 'succeeded',
    ).length;
    slug = `reeve-${card.id.slice(0, 8)}-v${version}`;
    command = `crit plan --name ${slug} ${shellQuote(path)}`;
  } else {
    if (!card.baseSha) return { ok: false, error: 'nothing to review', detail: 'the card has no base to diff against', status: 409 };
    // What the card changed, and only that: its own commits since its base,
    // the same range its Diff tab shows.
    command = `crit --range ${shellQuote(`${card.baseSha}..HEAD`)}`;
  }

  let announce: (url: string | null) => void = () => {};
  const announced = new Promise<string | null>((resolve) => (announce = resolve));
  let runId = '';
  let urlSeen = false;
  let critApproved: boolean | null = null;

  const handle = startShellRun({
    db, writer, cardId: card.id, stage: card.stage,
    command,
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
    (result) => finishCritReview(db, writer, card.id, runId, target, slug, worktreePath, { ...result, critApproved }),
    (err: unknown) => recordOutcome(db, card.id, runId, 'failed', `Crit review ended badly: ${String(err)}`, { target }),
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
 * Turn a finished review into words in the conversation, or a verdict, or a
 * record of why there is neither.
 *
 * Runs long after the request that started it — a review can sit open for
 * hours — so the card is read again. Comments are about the work whatever has
 * happened since, so they are sent on whenever the card can still be talked
 * to; only the approval a review with none gives is held to the work still
 * being the one waiting. Anything thrown here would take the server down, so
 * nothing is.
 */
async function finishCritReview(
  db: Db,
  writer: EventWriter,
  cardId: string,
  reviewRunId: string,
  target: CritTarget,
  slug: string | null,
  cwd: string,
  result: { exitCode: number | null; stopReason: StopReason; critApproved: boolean | null },
): Promise<void> {
  try {
    // Checked before the exit code: a `crit plan` stopped while it owns the
    // daemon shuts it down and exits 0.
    if (result.stopReason === 'cancelled_by_user') {
      recordOutcome(db, cardId, reviewRunId, 'cancelled', null, { target });
      return;
    }
    if (result.stopReason !== 'completed' || result.exitCode !== 0) {
      recordOutcome(db, cardId, reviewRunId, 'failed', `crit exited with code ${result.exitCode ?? 'unknown'}.`, { target });
      return;
    }

    // Only a clean exit that parses to a list counts. Unreadable output read
    // as "no comments" would approve work the reviewer had objected to.
    let comments: CritComment[];
    try {
      const { stdout } = await exec('crit', ['comments', ...(slug ? ['--plan', slug] : []), '--json'], {
        cwd, timeout: CRIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
      });
      const parsed = critComments.safeParse(JSON.parse(stdout));
      if (!parsed.success) throw new Error('the comment list was not in the shape expected');
      // Crit's own convention: a resolved comment is settled, not feedback.
      // And a review of the changes keeps one session per worktree, so a
      // comment an earlier round already sent is not sent again.
      const sent = sentCommentIds(db, cardId);
      comments = parsed.data.filter((c) => !c.resolved && !(c.id && sent.has(c.id)));
    } catch (cause) {
      recordOutcome(db, cardId, reviewRunId, 'failed',
        `Could not read the comments back from Crit: ${failureOutput(cause, CRIT_TIMEOUT_MS) || String(cause)}`, { target });
      return;
    }

    const card = getCard(db, cardId);
    const repo = card?.repoId ? listRepos(db).find((p) => p.id === card.repoId) : undefined;
    if (!card || card.archivedAt || !repo) {
      recordOutcome(db, cardId, reviewRunId, 'not_applied',
        `Nothing was sent: ${!card ? 'the card is gone' : card.archivedAt ? 'the card was archived' : 'the card has no repo'}.`,
        { comments: comments.length, target });
      return;
    }

    if (comments.length === 0) {
      // Crit's own `approved:` line never makes the decision, but it can veto
      // one: if Crit saw comments and none came back, the list was read from
      // the wrong place, and approving would bury the reviewer's objections.
      if (result.critApproved === false) {
        recordOutcome(db, cardId, reviewRunId, 'failed',
          'Crit reported unresolved comments, but none could be read back. Nothing was approved.', { target });
        return;
      }
      const gate = approvable(db, card, target);
      if (typeof gate === 'string') {
        recordOutcome(db, cardId, reviewRunId, 'not_applied', `Reviewed with no comments. Nothing was approved: ${gate}.`, { target });
        return;
      }
      approveStage(db, writer, card, repo, gate, { meta: { via: 'crit', target } });
      return;
    }

    const what = target === 'plan' ? 'the plan' : 'the changes';
    const notes = formatNotes(comments, target);
    // Framed as a revision when there is submitted work in this stage to
    // revise; otherwise it is simply the person's comments.
    const deliverable = latestDeliverableRun(db, card.id, card.stage);
    const prompt = deliverable && isRunnable(card.stage as Stage)
      ? renderPrompt('revision', { notes: blockquote(`Review comments from Crit on ${what}:\n\n${notes}`), submitTool: `submit_${card.stage}` })
      : `Review comments from Crit on ${what}:\n\n${notes}`;
    const sent = await sendToCard(db, writer, card, `**${comments.length} comment${comments.length === 1 ? '' : 's'} on ${what}**\n\n${notes}`, {
      actor: 'human', source: 'crit', prompt,
    });
    if (!sent.ok) {
      recordOutcome(db, cardId, reviewRunId, 'failed', `Reviewed in Crit, but the comments could not be sent: ${sent.error}.`, { target });
      return;
    }
    recordOutcome(db, cardId, reviewRunId, 'sent', null, {
      target, comments: comments.length, sentIds: comments.map((c) => c.id).filter(Boolean), deliveredTo: sent.runId,
    });
  } catch (err) {
    recordOutcome(db, cardId, reviewRunId, 'failed', `Crit review ended badly: ${String(err)}`, { target });
  }
}

/**
 * The run a review with no comments approves, or why it approves nothing:
 * the work reviewed has to be the stage's, submitted and waiting at its gate,
 * with nothing running on top of it — the button's own conditions. A plan is
 * the Planning stage's work; the changes are what In Progress and Testing
 * submit. Release's gate is Merge, which a review in Crit never presses.
 */
function approvable(db: Db, card: Card, target: CritTarget): Run | string {
  const stage = card.stage as Stage;
  const ours = target === 'plan' ? stage === 'planning' : stage === 'in_progress' || stage === 'testing';
  if (!ours) return `the card is in ${STAGE_LABELS[stage]}, where ${target === 'plan' ? 'the plan' : 'the changes'} are not what is approved`;
  if (isStartingStage(card.id) || liveStageRun(db, card.id)) return 'Claude is working on the card';
  const run = latestDeliverableRun(db, card.id, card.stage);
  if (!run) return 'nothing has been submitted in this stage yet';
  if (reviewsForCard(db, card.id).some((r) => r.runId === run.id)) return 'it had already been reviewed';
  const to = nextStage(stage);
  const blocked = to ? blockedMove(db, card, to) : null;
  if (blocked) return `the card waits on ${blocked.detail}`;
  return run;
}

/** Comment ids already sent to Claude from Crit for this card. */
function sentCommentIds(db: Db, cardId: string): Set<string> {
  const ids = new Set<string>();
  for (const e of cardEventsFor(db, cardId)) {
    if (e.kind !== 'crit_reviewed') continue;
    const sent = (e.meta as { sentIds?: unknown } | null)?.sentIds;
    if (Array.isArray(sent)) for (const id of sent) if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

function recordOutcome(
  db: Db,
  cardId: string,
  runId: string,
  outcome: 'cancelled' | 'failed' | 'not_applied' | 'sent',
  body: string | null,
  meta: Record<string, unknown> = {},
): void {
  try {
    const card = getCard(db, cardId);
    insertCardEvent(db, {
      cardId, actor: 'human', kind: 'crit_reviewed', stage: card?.stage ?? 'planning',
      runId, body, meta: { ...meta, outcome },
    });
  } catch (err) {
    // The card itself may be gone; there is nowhere left to say so.
    console.error(`[reeve] crit review outcome for card ${cardId} went unrecorded: ${String(err)}`);
  }
}

/** Every comment in full, with where it sits — a line of the plan, or a file in the change — when Crit knows. */
function formatNotes(comments: CritComment[], target: CritTarget): string {
  return comments
    .map((c) => {
      const file = target === 'plan' ? PLAN_PATH : c.path ? `\`${c.path}\`` : null;
      const where =
        c.scope === 'review' || !file ? `On ${target === 'plan' ? 'the plan' : 'the changes'} as a whole`
        : c.scope === 'file' || !c.start_line ? `On ${file}`
        : c.end_line && c.end_line !== c.start_line ? `Lines ${c.start_line}–${c.end_line} of ${file}`
        : `Line ${c.start_line} of ${file}`;
      const heading = c.anchor ? `**${where}, under “${c.anchor}”**` : `**${where}**`;
      const quote = c.quote?.trim();
      return [heading, quote ? blockquote(quote) : null, c.body.trim()].filter(Boolean).join('\n');
    })
    .join('\n\n');
}
