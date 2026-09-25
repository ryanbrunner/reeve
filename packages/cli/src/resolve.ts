import type { ApiCard } from '@reeve/shared';
import { api } from './client.js';
import { CliError, cardRef } from './output.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `142`, `#142` or `reeve#142`. */
const NUMBER = /^(?:([^#\s]*)#)?(\d+)$/;

const ambiguous = (ref: string, cards: ApiCard[]) =>
  new CliError(`'${ref}' could be ${cards.map((c) => `${cardRef(c)} (${c.id.slice(0, 8)})`).join(' or ')}`);

/**
 * The card a person or a script named: its id, the start of its id (a
 * worktree's directory is its first eight characters), or its number.
 *
 * A number is per repo, so `142` is only enough while one repo has a #142;
 * `reeve#142` says which. Digits alone are tried as a number first and then
 * as the start of an id, since an id can begin with eight of them.
 *
 * Only a whole id reaches an archived card — the others search the board —
 * and nothing that drives runs has any business with one.
 */
export async function resolveCard(ref: string): Promise<ApiCard> {
  if (UUID.test(ref)) return api.card(ref.toLowerCase());

  const { cards } = await api.board();
  const number = NUMBER.exec(ref);
  if (number) {
    const [, repo, digits] = number;
    const matches = cards.filter((c) => c.number === Number(digits) && (!repo || c.repoName === repo));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw ambiguous(ref, matches);
    if (ref.includes('#')) throw new CliError(`no card ${ref} on the board`);
  }

  const prefix = ref.toLowerCase();
  const matches = cards.filter((c) => c.id.startsWith(prefix));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw ambiguous(ref, matches);
  throw new CliError(`no card '${ref}' on the board`);
}
