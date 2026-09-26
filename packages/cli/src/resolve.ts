import {
  STAGE_LABELS,
  STAGES,
  type ApiCard,
  type ApiProject,
  type ApiRepo,
  type BoardResponse,
  type CardKind,
  type Stage,
} from '@reeve/shared';
import { api } from './client.js';
import { CliError, cardRef, usageError } from './output.js';

/** `in_progress`, `in-progress` and `In Progress` all mean the same column. */
export function parseStage(input: string): Stage {
  const key = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const stage = STAGES.find((s) => s === key(input) || key(STAGE_LABELS[s]) === key(input));
  if (!stage) throw usageError(`'${input}' is not a stage. Stages: ${STAGES.join(', ')}`);
  return stage;
}

/** By name, exactly or else ignoring case. */
export function findRepo(repos: ApiRepo[], name: string): ApiRepo {
  const exact = repos.find((r) => r.name === name);
  if (exact) return exact;
  const loose = repos.filter((r) => r.name.toLowerCase() === name.toLowerCase());
  if (loose.length === 1) return loose[0]!;
  const known = repos.map((r) => r.name).join(', ') || 'none';
  throw new CliError(`no repo called '${name}'. Repos: ${known}`);
}

/**
 * By title, ignoring case, or by id or a prefix of one. Titles are not unique,
 * so two projects with the same one are an error naming both ids rather than
 * a guess between them.
 */
export function findProject(projects: ApiProject[], ref: string): ApiProject {
  const input = ref.trim().toLowerCase();
  const byTitle = projects.filter((p) => p.title.toLowerCase() === input);
  const matches = byTitle.length > 0 ? byTitle : projects.filter((p) => p.id.startsWith(input));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    const known = projects.map((p) => `'${p.title}'`).join(', ') || 'none';
    throw new CliError(`no project matches '${ref}'. Projects: ${known}`);
  }
  throw new CliError(`'${ref}' matches more than one project: ${matches.map((p) => `${p.id} '${p.title}'`).join(', ')}`);
}

/** Anything `card show` and `runs` can name: a task on the board, a project, or either off it. */
export interface Addressable {
  id: string;
  kind: CardKind;
  title: string;
  archived: boolean;
}

/**
 * Every card a person could mean. The board carries tasks and projects in
 * separate lists and leaves archived cards out altogether, so all three go in:
 * a prefix is only unique if it is unique across everything it could name.
 */
export function addressable(board: BoardResponse, archived: ApiCard[]): Addressable[] {
  return [
    ...board.cards.map((c) => ({ id: c.id, kind: c.kind, title: c.title, archived: false })),
    ...board.projects.map((p) => ({ id: p.id, kind: 'project' as const, title: p.title, archived: false })),
    ...archived.map((c) => ({ id: c.id, kind: c.kind, title: c.title, archived: true })),
  ];
}

/**
 * A card from an id or a prefix of one, as long as only one card starts with
 * it. A full id that matches wins outright, even if it were somehow a prefix
 * of another.
 */
export function matchCard(cards: Addressable[], ref: string): Addressable {
  const input = ref.trim().toLowerCase();
  if (!/^[0-9a-f-]+$/.test(input)) throw usageError(`'${ref}' is not a card id or a prefix of one`);
  const exact = cards.find((c) => c.id === input);
  if (exact) return exact;
  const matches = cards.filter((c) => c.id.startsWith(input));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new CliError(`no card's id starts with '${ref}'`);
  const listed = matches.map((c) => `  ${c.id}  ${c.title}`).join('\n');
  throw new CliError(`'${ref}' is the start of more than one card's id — give more of it:\n${listed}`);
}

/**
 * `matchCard` against the live server. Two requests rather than one because
 * the archive is its own endpoint; they go out together. Everything it matched
 * against comes back too, for naming the card's project without asking again.
 */
export async function resolveCard(ref: string): Promise<{ card: Addressable; cards: Addressable[] }> {
  const [board, archived] = await Promise.all([api.board(), api.archived()]);
  const cards = addressable(board, archived);
  return { card: matchCard(cards, ref), cards };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `142`, `#142` or `reeve#142`. */
const NUMBER = /^(?:([^#\s]*)#)?(\d+)$/;

const ambiguous = (ref: string, cards: ApiCard[]) =>
  new CliError(`'${ref}' could be ${cards.map((c) => `${cardRef(c)} (${c.id.slice(0, 8)})`).join(' or ')}`);

/**
 * The card a person or a script named, in full, from the board alone.
 *
 * Beside `resolveCard` rather than instead of it: that one reaches archived
 * cards and projects, and answers with only enough to name them, which is what
 * `show` and `runs` want. This one answers with the card itself, because the
 * verbs that drive a run read its stage — and it stays on the board on purpose,
 * since nothing that drives runs has any business with an archived card.
 *
 * A number is per repo, so `142` is only enough while one repo has a #142;
 * `reeve#142` says which. Digits alone are tried as a number first and then as
 * the start of an id, since an id can begin with eight of them.
 */
export async function resolveCardOnBoard(ref: string): Promise<ApiCard> {
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
