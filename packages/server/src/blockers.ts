import { STAGE_LABELS, type Stage } from '@reeve/shared';
import type { Db } from './db/client.js';
import { dependenciesOf } from './db/queries.js';
import type { Card } from './db/schema.js';

/**
 * The rule the board exists for: a card does not start until what it depends
 * on is done.
 *
 * One function, because three places have to refuse the same cards for the
 * same reason — the move route, `startStage` and the SICKO MODE sweep — and a
 * second copy of "done" would drift the first time either grew a case.
 */

/**
 * The dependencies still standing in the way: every one not in Done.
 *
 * Done is the column, not the merge. A card is finished when a person has put
 * it there, the same as everywhere else on the board; waiting for GitHub as
 * well would make a repository's review rules part of this one.
 *
 * An archived dependency does not block. Archiving is how a card is taken off
 * the board on purpose — dropped, superseded, or merged and swept away by the
 * auto-archive — and a card still waiting on it would wait for ever on
 * something the board no longer shows, with nothing to press to clear it.
 */
export function blockersOf(db: Db, cardId: string): Card[] {
  return dependenciesOf(db, cardId).filter((d) => d.stage !== 'done' && !d.archivedAt);
}

export type Blocked = { status: 409; error: string; detail: string };

/**
 * Why this card may not start, or null when it may. Shaped like every other
 * refusal the routes pass through, so the 409 names the blocking cards.
 *
 * `#n` and the title, since numbers are only unique within a repo, with the
 * column each is in so the sentence says how far off it is.
 */
export function blockedStart(db: Db, card: Card): Blocked | null {
  const blockers = blockersOf(db, card.id);
  if (blockers.length === 0) return null;
  const names = blockers.map((b) => `#${b.number} ${b.title} (${STAGE_LABELS[b.stage as Stage]})`);
  return { status: 409, error: 'waiting on unfinished cards', detail: names.join(', ') };
}
