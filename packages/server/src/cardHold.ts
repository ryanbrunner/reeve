/**
 * Cards whose modal has never been closed since they were made — the ghost
 * card and Add Project both open straight into one, with a placeholder title
 * and nothing in the brief, for a person to type over.
 *
 * `isPlaceholderCard` alone is not enough to keep VIBES MODE off a card like
 * that: the moment its title changes it stops being a placeholder, and in the
 * second before anyone has touched the brief the sweep would read a titled,
 * empty card as ready and send it on. The hold lasts until the card's own
 * modal closes, discarded or not, however that happens — Escape, the scrim,
 * Back — which is `App.tsx`'s one place for "this card is no longer open."
 *
 * In memory, not a column: the same trade `isStartingStage` and `isOpeningPr`
 * make. A restart forgets every hold, which only costs the one card that was
 * mid-edit when it happened — left for a person same as it always was —
 * rather than a hold a crash left standing that nothing would ever clear.
 */
const held = new Set<string>();

/** A card just made through the UI, open for its first edit. */
export const holdCard = (cardId: string): void => {
  held.add(cardId);
};

/** The card's modal has closed. Safe to call on any card, held or not. */
export const releaseCard = (cardId: string): void => {
  held.delete(cardId);
};

/** Whether a person is still meant to be looking this card over for the first time. */
export const isHeld = (cardId: string): boolean => held.has(cardId);
