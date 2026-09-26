import type { Db } from './db/client.js';
import { addDependency, cardLinks, getCard, type CardLinks } from './db/queries.js';
import type { Card } from './db/schema.js';

/**
 * Making one card depend on another, and what gets refused.
 *
 * The table would take any pair of cards, so these rules live here and nowhere
 * else: only tasks take part, never a card on itself, and never a link that
 * closes a loop. A loop is a set of cards each waiting on the next, which
 * nothing could ever start — so it is refused when it is made rather than
 * discovered later by whatever reads the links to decide what can run.
 *
 * Repos and projects are no boundary. A task can wait on one in another repo,
 * and nothing about either card's worktree changes when it does.
 */

export type LinkResult = { ok: true } | { ok: false; status: 400; error: string; detail?: string };

export function linkDependency(db: Db, card: Card, dependsOnId: string): LinkResult {
  if (card.kind !== 'task') {
    return { ok: false, status: 400, error: 'only a task can depend on another card', detail: `${card.title} is a project` };
  }
  if (dependsOnId === card.id) return { ok: false, status: 400, error: 'a card cannot depend on itself' };
  const target = getCard(db, dependsOnId);
  if (!target) return { ok: false, status: 400, error: 'no such card', detail: dependsOnId };
  if (target.kind !== 'task') {
    return { ok: false, status: 400, error: 'only a task can be depended on', detail: `${target.title} is a project` };
  }
  // Checked against every link, archived cards' included: a loop through a
  // card nobody can see is still a loop. Nothing is awaited between this and
  // the insert, so no other request can close one in between.
  const loop = chain(cardLinks(db), target.id, card.id);
  if (loop) {
    const label = (id: string) => `#${getCard(db, id)?.number ?? '?'}`;
    const between = loop.slice(1, -1);
    return {
      ok: false,
      status: 400,
      error: 'that would make a cycle',
      detail: `${label(target.id)} already depends on ${label(card.id)}${
        between.length ? `, through ${between.map(label).join(' → ')}` : ''
      }`,
    };
  }
  addDependency(db, card.id, target.id);
  return { ok: true };
}

/**
 * The shortest run of dependencies from `from` to `to`, both ends included, or
 * null when `from` does not already wait on `to`. Breadth-first so the path in
 * the refusal is the one a person would find by following the links.
 */
function chain(links: (id: string) => CardLinks, from: string, to: string): string[] | null {
  const reachedFrom = new Map<string, string | null>([[from, null]]);
  // A for-of over an array visits what is pushed onto it mid-loop, which makes
  // it the queue as well.
  const queue = [from];
  for (const id of queue) {
    if (id === to) {
      const path: string[] = [];
      for (let at: string | null | undefined = id; at; at = reachedFrom.get(at)) path.unshift(at);
      return path;
    }
    for (const { id: next } of links(id).dependsOn) {
      if (reachedFrom.has(next)) continue;
      reachedFrom.set(next, id);
      queue.push(next);
    }
  }
  return null;
}
