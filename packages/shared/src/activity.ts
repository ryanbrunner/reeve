import type { RunStatus } from './runs.js';
import { isRunnable, type Stage } from './stages.js';

/**
 * A card's sub-state *within* its column.
 *
 * The column says where the human put the card; the activity says what the
 * machine has done with it since. They are deliberately independent: nothing
 * but a human drag changes a card's stage, so this is the only part of a card
 * that moves on its own, and colour is how the board shows it.
 */
export const CARD_ACTIVITIES = ['idle', 'running', 'needs_input', 'needs_review', 'error'] as const;
export type CardActivity = (typeof CARD_ACTIVITIES)[number];

export interface ActivityInput {
  /** Status of the latest Claude run for the card's CURRENT stage; null if none has run. */
  status: RunStatus | null;
  /** The stage's own reading of its output: Claude needs something from the human. */
  awaitsInput: boolean;
}

/**
 * Precedence inside `succeeded` is the one real judgement call here:
 * `needs_input` beats `needs_review`, because a plan that ends in questions is
 * a question, not a deliverable, and the human should answer before reading it
 * as finished work.
 */
export function deriveActivity({ status, awaitsInput }: ActivityInput): CardActivity {
  switch (status) {
    case null:
      return 'idle';
    case 'queued':
    case 'running':
    case 'stopping':
      return 'running';
    case 'failed':
    case 'interrupted':
      return 'error';
    // Stopped on purpose by the human. Nothing is wrong and nothing is waiting.
    case 'cancelled':
      return 'idle';
    case 'succeeded':
      return awaitsInput ? 'needs_input' : 'needs_review';
  }
}

/**
 * Activities a fresh run may be started from. `needs_review` and `needs_input`
 * are absent on purpose: once a run has succeeded the way forward is the review
 * gate, which forks the session so the attempt stays readable — a bare second
 * run would throw that history away.
 *
 * This is the board's affordance rule, not server policy. `POST /:id/run` gates
 * on the stage, the run registry, the concurrency cap and worktree health, and
 * never looks at the last run's status.
 */
const STARTABLE: readonly CardActivity[] = ['idle', 'error'];

export function canStartRun(card: { stage: Stage; activity: CardActivity }): boolean {
  return isRunnable(card.stage) && STARTABLE.includes(card.activity);
}
