import { nextStage, type Stage } from '@reeve/shared';
import type { Db } from './db/client.js';
import { cardsInStage, insertCardEvent, insertReview, moveCard } from './db/queries.js';
import type { Card, CardEventActor, Repo, Run } from './db/schema.js';
import { checkWorktree } from './git/worktree.js';
import { maybeOpenPullRequest } from './pullRequest.js';
import { startClaudeRun } from './runs/claude.js';
import type { EventWriter } from './runs/events.js';
import { stageDefinition } from './stages/index.js';
import { maybeStartStage } from './startStage.js';

/**
 * The two verdicts the human gate can reach, whoever reaches them.
 *
 * Out of the route because more than a button says them now: a review in Crit
 * ends in one or the other, and two copies of what approving means would
 * drift apart the first time one of them grew a step.
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
  // Almost always the person who pressed Approve. SICKO MODE approves as
  // `claude`, so the card's history — and the count of approvals a human
  // actually gave — stays true.
  const actor = opts.actor ?? 'human';
  // Done is the end of the board; approving there is a verdict with nowhere
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
    // The same automatic start, or pull request, that a drag there gets.
    if (moved?.stage === 'done') maybeOpenPullRequest(db, moved, repo);
    else if (moved) maybeStartStage(db, writer, moved, repo);
  }
  return { fromStage: card.stage, toStage: to, moved: to !== card.stage };
}

export type Revision =
  | { ok: true; revisionRunId: string; forkedFrom: string | null }
  | { ok: false; error: string; status: 409 | 501 };

/**
 * Rejecting moves nothing: it forks the session so the prior attempt stays
 * intact and readable, and the notes become the revision prompt.
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
  insertReview(db, {
    id: crypto.randomUUID(), cardId: card.id, runId: lastRun.id,
    stage: card.stage, decision: 'rejected', notes,
    fromStage: card.stage, toStage: card.stage,
  });
  insertCardEvent(db, {
    cardId: card.id, actor: 'human', kind: 'reviewed', stage: card.stage,
    runId: lastRun.id, body: notes, meta: { ...meta, decision: 'rejected' },
  });

  const stage = stageDefinition(card.stage as never);
  if (!stage) return { ok: false, error: 'stage not implemented yet', status: 501 };
  const health = await checkWorktree(repo.repoPath, card.worktreePath);
  if (health.state !== 'ok') return { ok: false, error: 'card has no usable worktree', status: 409 };

  const handle = startClaudeRun({
    db, writer, card, repo, stage,
    worktreePath: health.path,
    reviewNotes: notes,
    // Fork rather than continue: the rejected attempt stays readable and the
    // card's history is a list of attempts, not one mutating session.
    resumeSessionId: lastRun.sessionId,
    parentRunId: lastRun.id,
  });
  return { ok: true, revisionRunId: handle.runId, forkedFrom: lastRun.sessionId };
}
