import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  freeLaneColor,
  type ApiRepo,
  type BoardResponse,
  type CreateRepoBody,
  type UpdateRepoBody,
} from '@reeve/shared';
import { api } from '../client.js';
import { CliError, cardRef, parseOrUsage, print, printJson, usageError } from '../output.js';
import { findRepo, realpathOrSelf } from '../resolve.js';

/**
 * `reeve repos`: the repos Reeve may work in, and the Settings form that adds
 * and edits them.
 *
 * The server does the checking that matters — that the path is a repository
 * and the branch is in it — and fills in what it can read off the repo
 * itself, so this passes on only what was typed and says what came back.
 */

/** The form's fields, as flags. `--path` is add's positional, so only edit takes it as a flag. */
const FIELDS = {
  name: { type: 'string' },
  branch: { type: 'string' },
  'worktree-root': { type: 'string' },
  setup: { type: 'string' },
  test: { type: 'string' },
  seed: { type: 'string' },
  server: { type: 'string' },
  'server-url': { type: 'string' },
  teardown: { type: 'string' },
  finish: { type: 'string' },
  color: { type: 'string' },
  // The form's checkbox, as a pair like `card edit`'s `--mockups`, so that
  // leaving both out leaves it as it was.
  'sync-branch': { type: 'boolean' },
  'no-sync-branch': { type: 'boolean' },
  json: { type: 'boolean' },
} as const;

type Switches = 'sync-branch' | 'no-sync-branch';
type Fields = Partial<Record<Exclude<keyof typeof FIELDS, 'json' | Switches>, string>> &
  Partial<Record<Switches, boolean>> & { path?: string };

/**
 * Relative to where the command was run, not to the server's cwd, which is
 * where the server would resolve it. A leading `~` is left for the server to
 * expand, as it does for the form: the shell only expands one it was not
 * asked to quote.
 */
const absolute = (path: string) => (path.startsWith('~') ? path : resolve(process.cwd(), path));

/** What must not be blank: the server needs a name, a path and a branch to mean something. */
function required(flag: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw usageError(`--${flag} cannot be blank`);
  return trimmed;
}

/** A blank command or colour is "none", which is null on the wire — the same as a blank field on the form. */
const blankIsNull = (value: string) => (value.trim() ? value.trim() : null);

/** The fields given, as the body the server takes. A flag left out is absent, so it stays as it was. */
function body(fields: Fields): UpdateRepoBody {
  const out: UpdateRepoBody = {};
  if (fields.name !== undefined) out.name = required('name', fields.name);
  if (fields.path !== undefined) out.repoPath = absolute(required('path', fields.path));
  if (fields.branch !== undefined) out.defaultBranch = required('branch', fields.branch);
  if (fields['worktree-root'] !== undefined) {
    out.worktreeRoot = absolute(required('worktree-root', fields['worktree-root']));
  }
  if (fields.setup !== undefined) out.setupCommand = blankIsNull(fields.setup);
  if (fields.test !== undefined) out.testCommand = blankIsNull(fields.test);
  if (fields.seed !== undefined) out.seedCommand = blankIsNull(fields.seed);
  if (fields.server !== undefined) out.serverCommand = blankIsNull(fields.server);
  if (fields['server-url'] !== undefined) out.serverUrl = blankIsNull(fields['server-url']);
  if (fields.teardown !== undefined) out.teardownCommand = blankIsNull(fields.teardown);
  if (fields.finish !== undefined) out.finishCommand = blankIsNull(fields.finish);
  if (fields.color !== undefined) out.laneColor = blankIsNull(fields.color);
  if (fields['sync-branch'] && fields['no-sync-branch']) throw usageError('give --sync-branch or --no-sync-branch, not both');
  if (fields['sync-branch'] || fields['no-sync-branch']) out.syncDefaultBranch = fields['sync-branch'] === true;
  return out;
}

function render(repo: ApiRepo): string {
  const rows: Array<[string, string]> = [
    ['Path', repo.repoPath],
    ['Branch', repo.defaultBranch],
    ['Kept up to date', repo.syncDefaultBranch ? 'yes, when a card merges' : 'no'],
    ['Worktrees', repo.worktreeRoot],
    ['Setup', repo.setupCommand ?? '-'],
    ['Test', repo.testCommand ?? '-'],
    ['Seed', repo.seedCommand ?? '-'],
    ['Server', repo.serverCommand ?? '-'],
    ['Server URL', repo.serverUrl ?? '-'],
    ['Teardown', repo.teardownCommand ?? '-'],
    ['Finish', repo.finishCommand ?? '-'],
    ['Lane colour', repo.laneColor ?? '-'],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return [repo.name, ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`)].join('\n');
}

/**
 * The top of the git checkout a path is in, as the server will register it:
 * the nearest directory holding a `.git`, which is a directory in a checkout
 * and a file in a worktree. The path as given when there is none, for the
 * server to refuse in its own words.
 */
function toplevelOf(path: string): string {
  for (let dir = path; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return path;
  }
}

/**
 * A card's worktree is a checkout of its own, so the server would register
 * one as a repo — and an agent working in a card, running this with no path,
 * is exactly who would ask it to. The server allows two names for one
 * directory, too. Both are refused here, where the board is to hand.
 * Compared exactly rather than by containment, so a repo nested in another
 * can still be added.
 */
function refuseKnown(board: BoardResponse, toplevel: string): void {
  const here = realpathOrSelf(toplevel);
  const worktreeOf = board.cards.find((c) => c.worktreePath && realpathOrSelf(c.worktreePath) === here);
  if (worktreeOf) {
    throw new CliError(`${toplevel} is ${cardRef(worktreeOf)}'s worktree, not a repo. Add its repo by that repo's path`);
  }
  const registered = board.repos.find((r) => realpathOrSelf(r.repoPath) === here);
  if (registered) throw new CliError(`${toplevel} is already registered, as ${registered.name}`);
}

/**
 * Registers the repo at a path, the cwd if none is given. A path inside a
 * repo registers the whole repo, and the name defaults to that repo's
 * directory. The lane colour defaults to the first one no other repo has, as
 * on the form.
 */
async function add(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() => parseArgs({ args, allowPositionals: true, options: FIELDS }));
  if (positionals.length > 1) throw usageError('repos add takes one path');
  const path = absolute(positionals[0] ?? '.');
  // A `~` path is the server's to expand, so there is nothing here to look in.
  const toplevel = path.startsWith('~') ? path : toplevelOf(path);

  const board = await api.board();
  refuseKnown(board, toplevel);
  const fields = body(values);
  const created = await api.createRepo({
    ...fields,
    name: fields.name ?? basename(toplevel),
    repoPath: path,
    laneColor: fields.laneColor === undefined ? freeLaneColor(board.repos.map((r) => r.laneColor)) : fields.laneColor,
  } satisfies CreateRepoBody);
  if (values.json) return printJson(created);
  print(`Added ${created.name}`);
  print(render(created));
}

async function edit(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, allowPositionals: true, options: { ...FIELDS, path: { type: 'string' } } }),
  );
  const [name] = positionals;
  if (name === undefined || positionals.length > 1) throw usageError('repos edit needs one repo, by name');
  const changes = body(values);
  if (Object.keys(changes).length === 0) {
    throw usageError('repos edit needs something to change, as in: reeve repos edit storefront --test "npm test"');
  }

  const repo = findRepo(await api.board(), name);
  const updated = await api.updateRepo(repo.id, changes);
  if (values.json) return printJson(updated);
  print(`Saved ${updated.name}`);
  print(render(updated));
}

async function show(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } }),
  );
  const [name] = positionals;
  if (name === undefined || positionals.length > 1) throw usageError('repos show needs one repo, by name');
  const repo = findRepo(await api.board(), name);
  if (values.json) return printJson(repo);
  print(render(repo));
}

async function list(args: string[]): Promise<void> {
  const { values } = parseOrUsage(() => parseArgs({ args, options: { json: { type: 'boolean' } } }));
  const { repos } = await api.board();
  if (values.json) return printJson(repos);
  if (repos.length === 0) return print('No repos yet. Add one with `reeve repos add <path>`.');
  const width = Math.max(...repos.map((r) => r.name.length));
  print(repos.map((r) => `${r.name.padEnd(width)}  ${r.repoPath}  (${r.defaultBranch})`).join('\n'));
}

const ACTIONS: Record<string, (args: string[]) => Promise<void>> = { add, edit, show };

/** Bare, or with only `--json`, it lists them. */
export async function repos(args: string[]): Promise<void> {
  const [action] = args;
  if (action === undefined || action.startsWith('-')) return list(args);
  const run = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined;
  if (!run) throw usageError(`unknown repos action '${action}'. Actions: ${Object.keys(ACTIONS).join(', ')}`);
  return run(args.slice(1));
}
