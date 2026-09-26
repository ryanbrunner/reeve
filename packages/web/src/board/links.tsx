import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ApiCard } from '@reeve/shared';

/**
 * Where a card stands relative to the one being hovered or focused.
 *
 * `upstream` is everything the focused card waits on, however far back;
 * `downstream` is everything waiting on it. The whole chain rather than the
 * nearest link, because the point is to follow it across columns and lanes
 * without hovering each card along the way. `unlinked` is the rest of the
 * board, which steps back so the chain reads.
 */
export type LinkRole = 'focus' | 'upstream' | 'downstream' | 'unlinked';

interface Links {
  /** Null while nothing linked is focused, which is nearly always: the board is drawn as it is. */
  role: (id: string) => LinkRole | null;
  enter: (id: string) => void;
  /** Only clears the card it names, so leaving one card after entering the next cannot undo the entry. */
  leave: (id: string) => void;
}

const LinksContext = createContext<Links>({ role: () => null, enter: () => {}, leave: () => {} });

export const useLinks = () => useContext(LinksContext);

/**
 * A context rather than props because the cards it lights sit under two
 * different trees — the calm board's sortable columns and VIBES MODE's flying
 * layer — and both would otherwise thread the same pair of props through every
 * level to reach the face.
 *
 * `paused` is a drag: a card being carried across the board is not asking to
 * have its chain traced, and dimming every drop target would hide where it can
 * land.
 */
export function LinksProvider({ cards, paused, children }: {
  cards: ApiCard[];
  paused: boolean;
  children: React.ReactNode;
}) {
  const [focused, setFocused] = useState<string | null>(null);
  const roles = useMemo(() => (focused && !paused ? chainOf(cards, focused) : null), [cards, focused, paused]);

  const enter = useCallback((id: string) => setFocused(id), []);
  const leave = useCallback((id: string) => setFocused((cur) => (cur === id ? null : cur)), []);
  const value = useMemo<Links>(
    () => ({ role: (id) => (roles ? (roles.get(id) ?? 'unlinked') : null), enter, leave }),
    [roles, enter, leave],
  );
  return <LinksContext.Provider value={value}>{children}</LinksContext.Provider>;
}

/**
 * The focused card's chain in both directions, or null when it has none — a
 * card that waits on nothing and is waited on by nothing should not dim the
 * board just for being pointed at.
 *
 * Nothing stops two cards waiting on each other, so the walk keeps a visited
 * set and a cycle ends it. A dependency that has been archived is not on the
 * board and is not walked through, which only matters for the cards beyond it.
 */
function chainOf(cards: ApiCard[], id: string): Map<string, LinkRole> | null {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const roles = new Map<string, LinkRole>([[id, 'focus']]);
  const walk = (role: 'upstream' | 'downstream', next: (c: ApiCard) => string[]) => {
    const stack = [id];
    while (stack.length) {
      const card = byId.get(stack.pop()!);
      if (!card) continue;
      for (const n of next(card)) {
        if (roles.has(n) || !byId.has(n)) continue;
        roles.set(n, role);
        stack.push(n);
      }
    }
  };
  walk('upstream', (c) => c.dependsOn.map((d) => d.id));
  walk('downstream', (c) => c.dependents);
  return roles.size > 1 ? roles : null;
}
