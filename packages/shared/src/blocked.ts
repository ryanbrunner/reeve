import type { ApiCardLink } from './api.js';
import type { Stage } from './stages.js';

/**
 * Why a card waiting on others may not move from `from` to `to`, as a sentence
 * to show a person, or null if it may.
 *
 * A blocked card can only go back to Backlog until what it waits on clears,
 * from whichever column it is in. Staying in its own column — a reorder, or a
 * change of lane — always passes. Whether a dependency has cleared is never
 * worked out here: `done` is the server's answer, from the same rule its own
 * refusal uses (`stillBlocking`), so the board refuses a drop before sending
 * it rather than guessing differently. The server has the last word either
 * way, and for a dependency whose pull request is still being opened it
 * refuses a move this lets through.
 */
export function blockedMoveRefusal(from: Stage, to: Stage, dependsOn: readonly ApiCardLink[]): string | null {
  if (to === 'backlog' || to === from) return null;
  const open = dependsOn.filter((d) => !d.done);
  if (open.length === 0) return null;
  const names = open.map((d) => `#${d.number}${d.awaitingMerge ? ' (PR not merged)' : ''}`).join(', ');
  const them = open.length === 1 ? 'it is' : 'they are';
  return `Waits on ${names}: it can only go back to Backlog until ${them} cleared.`;
}
