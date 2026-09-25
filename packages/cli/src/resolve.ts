import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
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
import { CliError, cardRef, usageError } from './output.js';

/**
 * Everything here is a pure function of the board and a path, so the part of
 * the CLI most likely to pick the wrong card can be reasoned about on its own.
 */

/** `in_progress`, `in-progress` and `In Progress` all mean the same column. */
export function parseStage(input: string): Stage | null {
  const key = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return STAGES.find((s) => s === key(input) || key(STAGE_LABELS[s]) === key(input)) ?? null;
}

export function requireStage(input: string): Stage {
  const stage = parseStage(input);
  if (!stage) throw usageError(`'${input}' is not a stage. Stages: ${STAGES.join(', ')}`);
  return stage;
}

/**
 * macOS answers `/var/...` for a directory git knows as `/private/var/...`, so
 * both sides of a comparison go through this. A worktree that has since been
 * removed has no real path, and is compared as stored.
 */
export function realpathOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** On a segment boundary: `/code/reeve` holds `/code/reeve/src`, not `/code/reeve-other`. */
export function isWithin(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

export interface Here {
  /** The card whose worktree the cwd is in. */
  card: ApiCard | null;
  /** That card's repo, or else the registered repo the cwd is in. */
  repo: ApiRepo | null;
}

/**
 * What the cwd says about which card and repo are meant. Worktrees live beside
 * the repo rather than inside it, so they are checked first and a worktree's
 * repo comes from its card. The deepest match wins, for repos nested in repos.
 */
export function whereAmI(board: BoardResponse, cwd: string, real = realpathOrSelf): Here {
  const here = real(cwd);
  const deepest = <T>(items: T[], pathOf: (item: T) => string | null): T | null => {
    let best: { item: T; length: number } | null = null;
    for (const item of items) {
      const path = pathOf(item);
      if (!path) continue;
      const dir = real(path);
      if (isWithin(here, dir) && dir.length > (best?.length ?? -1)) best = { item, length: dir.length };
    }
    return best?.item ?? null;
  };

  const card = deepest(board.cards, (c) => c.worktreePath);
  const repo = card
    ? (board.repos.find((r) => r.id === card.repoId) ?? null)
    : deepest(board.repos, (r) => r.repoPath);
  return { card, repo };
}

/** By name, exactly or else ignoring case, or by id: what `--repo` takes. */
export function findRepo(board: BoardResponse, ref: string): ApiRepo {
  const exact = board.repos.find((r) => r.name === ref || r.id === ref);
  if (exact) return exact;
  const loose = board.repos.filter((r) => r.name.toLowerCase() === ref.toLowerCase());
  if (loose.length === 1) return loose[0]!;
  const known = board.repos.map((r) => r.name).join(', ') || 'none';
  throw new CliError(`no repo called '${ref}'. Repos: ${known}`);
}

/**
 * Where a new card goes when `--repo` does not say: the repo you are in, else
 * its project's, else the only one there is. A card with no repo can have no
 * worktree and so no run, which is why the board never makes one unasked.
 */
export function repoForNew(board: BoardResponse, here: Here, project: ApiProject | null): ApiRepo | null {
  if (here.repo) return here.repo;
  const ofProject = project?.repoId ? board.repos.find((r) => r.id === project.repoId) : undefined;
  if (ofProject) return ofProject;
  return board.repos.length === 1 ? board.repos[0]! : null;
}

/**
 * A project by its id or a prefix of one, or else by its title, exactly or
 * ignoring case: what `--project` takes. Projects have no number to say.
 */
export function findProject(board: BoardResponse, ref: string): ApiProject {
  const input = ref.trim();
  const candidates = [
    board.projects.filter((p) => p.id === input.toLowerCase()),
    /^[0-9a-f-]+$/i.test(input) ? board.projects.filter((p) => p.id.startsWith(input.toLowerCase())) : [],
    board.projects.filter((p) => p.title === input),
    board.projects.filter((p) => p.title.toLowerCase() === input.toLowerCase()),
  ];
  for (const matches of candidates) {
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new CliError(`'${ref}' matches more than one project: ${matches.map((p) => `${p.title} (${p.id})`).join(', ')}`);
    }
  }
  const known = board.projects.map((p) => p.title).join(', ') || 'none';
  throw new CliError(`no project matches '${ref}'. Projects: ${known}`);
}

function one(matches: ApiCard[], ref: string): ApiCard {
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new CliError(`no card on the board matches '${ref}'`);
  throw new CliError(`'${ref}' matches more than one card: ${matches.map(cardRef).join(', ')}`);
}

/**
 * A card from what a person typed: `142`, `#142`, `reeve#142`, or a card id or
 * an unambiguous prefix of one.
 *
 * Numbers are per repo, so a bare one is looked up in the repo the cwd is in.
 * Outside any repo it is looked up everywhere, and more than one match is an
 * error naming them rather than a guess. `cards` is the board's unless given:
 * an archived card is not on the board, and restoring one looks in the archive.
 */
export function resolveCard(board: BoardResponse, ref: string, here: Here, cards = board.cards): ApiCard {
  const input = ref.trim();
  const numbered = /^(.*)#(\d+)$/.exec(input) ?? /^()(\d+)$/.exec(input);
  if (numbered) {
    const [, repoName, digits] = numbered;
    const n = Number(digits);
    const withNumber = cards.filter((c) => c.kind === 'task' && c.number === n);
    if (repoName) {
      const repo = findRepo(board, repoName);
      return one(withNumber.filter((c) => c.repoId === repo.id), input);
    }
    if (here.repo) {
      const inRepo = withNumber.filter((c) => c.repoId === here.repo!.id);
      if (inRepo.length === 0) {
        throw new CliError(`no card #${n} in ${here.repo.name}. For another repo's, name it: <repo>#${n}`);
      }
      return one(inRepo, input);
    }
    return one(withNumber, input);
  }
  if (/^[0-9a-f-]+$/i.test(input)) {
    const prefix = input.toLowerCase();
    return one(cards.filter((c) => c.id.startsWith(prefix)), input);
  }
  throw usageError(`'${ref}' is not a card. Use 142, #142, <repo>#142, or a card id`);
}

/** What a `card` command acts on: a task, or a project, which is a card too. */
export interface Target {
  id: string;
  kind: CardKind;
  /** How to name it back: `reeve#142`, or the project's title. */
  label: string;
  /** The task as the board has it. Null for a project, which the board only has as a lane. */
  card: ApiCard | null;
}

/**
 * A task as `resolveCard` finds it, or failing that a project by its id or
 * title. A project is a card to the server, so the `card` commands take one:
 * editing its brief and archiving it are the same calls. Where a project
 * cannot go — a column — the server says so, not the CLI.
 */
export function resolveTarget(board: BoardResponse, ref: string, here: Here): Target {
  let taskError: unknown;
  try {
    const card = resolveCard(board, ref, here);
    return { id: card.id, kind: card.kind, label: cardRef(card), card };
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    taskError = e;
  }
  // `#12` is only ever a task, and a project that fails to match says less
  // than the task that did.
  if (/^(.*#)?\d+$/.test(ref.trim()) || board.projects.length === 0) throw taskError;
  try {
    const project = findProject(board, ref);
    return { id: project.id, kind: 'project', label: `project "${project.title}"`, card: null };
  } catch {
    throw taskError;
  }
}

/**
 * The slot at the end of `stage`, as `POST /move` counts slots: the column
 * without the card itself, which may already be in it.
 */
export function appendIndex(board: BoardResponse, cardId: string, stage: Stage): number {
  return board.cards.filter((c) => c.stage === stage && c.id !== cardId).length;
}
