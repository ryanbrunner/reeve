import { STAGE_LABELS, type Stage } from '@reeve/shared';
import type { Db } from './db/client.js';
import { awaitingMerge, dependenciesOf, stillBlocking } from './db/queries.js';
import type { Card } from './db/schema.js';
import { isOpeningPr } from './pullRequest.js';

/**
 * The rule the board exists for: a card does not start, or move on, until what
 * it depends on is done.
 *
 * One module, because four places have to refuse the same cards for the same
 * reason — the move route, approval, `startStage` and the VIBES MODE sweep —
 * and a second copy of "done" would drift the first time either grew a case.
 * The board and the card modal refuse through `blockedMoveRefusal` in shared,
 * which reads the same answer off `ApiCardLink.done`.
 */

/**
 * The dependencies still standing in the way. What counts as standing in the
 * way is `stillBlocking`, in `db/queries.ts` — the board's chips read the same
 * rule, so a chip cannot say done while a drag is still refused for it.
 *
 * With one addition the chips do not see: a card in Done whose pull request is
 * still being opened. It has no `prUrl` yet, so `stillBlocking` reads it as a
 * card with nothing to land, and the VIBES sweep — every couple of seconds —
 * would move its dependents on before the pull request exists. For those few
 * seconds a chip may say done while the server refuses; the refusal says why.
 */
export function blockersOf(db: Db, cardId: string): Card[] {
  return dependenciesOf(db, cardId).filter((c) => stillBlocking(c) || openingInDone(c));
}

const openingInDone = (c: Card) => c.stage === 'done' && !c.archivedAt && isOpeningPr(c.id);

export type Blocked = { status: 409; error: string; detail: string };

/**
 * Why this card may not start, or null when it may. Shaped like every other
 * refusal the routes pass through, so the 409 names the blocking cards.
 *
 * `#n` and the title, since numbers are only unique within a repo, with the
 * column each is in so the sentence says how far off it is. A bare "(Done)"
 * would read as a contradiction beside "unfinished", so one in Done says what
 * it is waiting for.
 */
export function blockedStart(db: Db, card: Card): Blocked | null {
  const blockers = blockersOf(db, card.id);
  if (blockers.length === 0) return null;
  const names = blockers.map((b) => `#${b.number} ${b.title} (${where(b)})`);
  return { status: 409, error: 'waiting on unfinished cards', detail: names.join(', ') };
}

function where(c: Card): string {
  const column = STAGE_LABELS[c.stage as Stage];
  if (awaitingMerge(c)) return `${column}, PR not merged`;
  if (openingInDone(c)) return `${column}, PR opening`;
  return column;
}

/**
 * Why this card may not go to `to`, or null when it may. A blocked card can
 * only go back to Backlog, from whichever column it is in, until what it waits
 * on clears — backwards moves included, since an earlier column past Backlog
 * is still one where Claude would run on code that is not on main yet. Staying
 * in its own column, a reorder or a change of lane, is always allowed.
 *
 * Nothing pulls a card back on its own when a dependency is added: a person
 * moves cards, and this only narrows where they can move it to.
 */
export function blockedMove(db: Db, card: Card, to: Stage): Blocked | null {
  if (to === 'backlog' || to === card.stage) return null;
  return blockedStart(db, card);
}
