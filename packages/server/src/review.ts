import { nextStage, type Stage } from '@reeve/shared';
import type { Db } from './db/client.js';
import { cardsInStage, insertCardEvent, insertReview, moveCard } from './db/queries.js';
import type { Card, CardEventActor, Repo, Run } from './db/schema.js';
import { enterRelease } from './pullRequest.js';
import type { EventWriter } from './runs/events.js';
import { sendToCard } from './conversation.js';
import type { MessageSource } from './runs/claude.js';
import { blockquote, renderPrompt } from './stages/template.js';
import { isStartingStage, maybeStartStage } from './startStage.js';

/**
 * The two verdicts the human gate can reach, whoever reaches them.
 *
 * Out of the route because more than a button says them now: a review in Crit
 * or a round in Gloss ends in one or the other, and two copies of what
 * approving means would drift apart the first time one of them grew a step.
 */

/**
 * Approving says the stage's output is good, so it records the verdict AND
 * advances the card one column — a human deciding the work is done is the
 * whole point of the gate, and making them then drag the card is asking them
 * to say it twice. The card then starts its next stage as any card entering a
 * column does.
 */
export function approveStage(
  db: Db,
  writer: EventWriter,
  card: Card,
  repo: Repo,
  lastRun: Run,
  opts: { notes?: string | null; meta?: Record<string, unknown>; actor?: CardEventActor } = {},
): { fromStage: Stage; toStage: Stage; moved: boolean } {
  const notes = opts.notes ?? null;
  // Almost always the person who pressed Approve. VIBES MODE approves as
  // `claude`, so the card's history — and the count of approvals a human
  // actually gave — stays true.
  const actor = opts.actor ?? 'human';
  // Release is the end of the board; approving there is a verdict with nowhere
  // to go, so the card stays put rather than the request failing.
  const to = nextStage(card.stage as Stage) ?? card.stage;
  insertReview(db, {
    id: crypto.randomUUID(), cardId: card.id, runId: lastRun.id,
    stage: card.stage, decision: 'approved', notes,
    fromStage: card.stage, toStage: to,
  });
  insertCardEvent(db, {
    cardId: card.id, actor, kind: 'reviewed', stage: card.stage,
    runId: lastRun.id, body: notes, meta: { ...opts.meta, decision: 'approved' },
  });
  if (to !== card.stage) {
    // Appended, not inserted: the human chose the column, not the slot.
    // moveCard writes the `moved` event, so the timeline reads as a verdict
    // followed by a move rather than one conflated entry.
    const moved = moveCard(db, card.id, to, cardsInStage(db, to).length, actor);
    // The same pull request a drag into Release gets, or the same automatic
    // start any other stage gets — Release no longer starts itself.
    if (moved?.stage === 'release') enterRelease(db, moved, repo);
    else if (moved) maybeStartStage(db, writer, moved, repo);
  }
  return { fromStage: card.stage, toStage: to, moved: to !== card.stage };
}

export type Revision =
  | { ok: true; revisionRunId: string; forkedFrom: string | null; done: Promise<void> }
  | { ok: false; error: string; status: 409 | 501 };

/**
 * Rejecting moves nothing: the notes go to Claude as the next message in the
 * stage's conversation, which forks its session so the prior attempt stays
 * intact and readable.
 */
export async function sendBackForRevision(
  db: Db,
  writer: EventWriter,
  card: Card,
  repo: Repo,
  lastRun: Run,
  notes: string,
  meta: Record<string, unknown> = {},
): Promise<Revision> {
  // A revision already waiting on the tree's setup still reads as needing
  // review, so a second Reject can land in that time. Refused before it is
  // recorded: `continueStage` would refuse it anyway, and the notes would sit
  // in the history as a verdict nothing ever acted on.
  if (isStartingStage(card.id)) return { ok: false, error: 'the stage is already starting', status: 409 };
  insertReview(db, {
    id: crypto.randomUUID(), cardId: card.id, runId: lastRun.id,
    stage: card.stage, decision: 'rejected', notes,
    fromStage: card.stage, toStage: card.stage,
  });
  insertCardEvent(db, {
    cardId: card.id, actor: 'human', kind: 'reviewed', stage: card.stage,
    runId: lastRun.id, body: notes, meta: { ...meta, decision: 'rejected' },
  });

  // Into the conversation as what it is: the person sending the work back.
  // The run that submitted it is the stage's last, so its session is the one
  // that carries on, with every earlier turn readable above it.
  const revision = await sendToCard(db, writer, card, notes, {
    actor: 'human',
    source: (meta['via'] as MessageSource | undefined) ?? 'review',
    prompt: renderPrompt('revision', { notes: blockquote(notes), submitTool: `submit_${card.stage}` }),
  });
  if (!revision.ok) return { ok: false, error: revision.error, status: revision.status === 501 ? 501 : 409 };
  return { ok: true, revisionRunId: revision.runId, forkedFrom: lastRun.sessionId, done: revision.done ?? Promise.resolve() };
}
