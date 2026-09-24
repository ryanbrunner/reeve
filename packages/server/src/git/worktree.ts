import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface WorktreeRef {
  path: string;
  branch: string | null;
  head: string | null;
  locked: boolean;
  prunable: boolean;
}

export class GitError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
    this.name = 'GitError';
  }
}

async function git(repoPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', repoPath, ...args], { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (cause) {
    const e = cause as { stderr?: string; message?: string };
    throw new GitError(`git ${args[0]} failed in ${repoPath}`, (e.stderr ?? e.message ?? '').trim());
  }
}

/** `git worktree list --porcelain` is the only trustworthy source of what exists. */
export async function listWorktrees(repoPath: string): Promise<WorktreeRef[]> {
  const out = await git(repoPath, ['worktree', 'list', '--porcelain']);
  const refs: WorktreeRef[] = [];
  let current: Partial<WorktreeRef> | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current?.path) refs.push({ locked: false, prunable: false, branch: null, head: null, ...current } as WorktreeRef);
      current = { path: line.slice('worktree '.length) };
    } else if (!current) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'locked') {
      current.locked = true;
    } else if (line === 'prunable') {
      current.prunable = true;
    }
  }
  if (current?.path) refs.push({ locked: false, prunable: false, branch: null, head: null, ...current } as WorktreeRef);
  return refs;
}

/**
 * A path as a person typed it, as the filesystem wants it.
 *
 * `~` is the one expansion worth doing here: the field a repo path is typed
 * into is a browser text input, which has no shell behind it to do this, and
 * `~/code/thing` is how anyone would write the answer.
 */
export function expandPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '~') return homedir();
  const expanded = trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(2)) : trimmed;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export interface RepoInspection {
  /** The path after expansion — what the other fields were read from. */
  path: string;
  exists: boolean;
  isRepo: boolean;
  /**
   * The repository root. A path inside a repo inspects as that repo, so
   * pointing at `packages/web` files the project against the whole thing
   * rather than storing a path git would keep reinterpreting.
   */
  toplevel: string | null;
  currentBranch: string | null;
  branches: string[];
}

/**
 * What a repo path really is, before a project is built on top of it.
 *
 * Every failure mode here — a typo'd path, a directory that was never a repo,
 * a branch that does not exist — otherwise surfaces hours later as a failed
 * worktree on the first run, which is the worst possible moment to learn it.
 */
export async function inspectRepo(input: string): Promise<RepoInspection> {
  const path = expandPath(input);
  const blank: RepoInspection = { path, exists: false, isRepo: false, toplevel: null, currentBranch: null, branches: [] };
  if (!existsSync(path)) return blank;
  try {
    if (!statSync(path).isDirectory()) return { ...blank, exists: true };
  } catch {
    return blank;
  }

  let toplevel: string;
  try {
    toplevel = (await git(path, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return { ...blank, exists: true };
  }

  // A repo with no commits yet has a HEAD that points nowhere, so neither of
  // these is guaranteed even once we know it is a repository.
  const currentBranch = await git(toplevel, ['rev-parse', '--abbrev-ref', 'HEAD'])
    .then((out) => out.trim())
    .catch(() => null);
  const branches = await git(toplevel, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    .then((out) => out.split('\n').map((b) => b.trim()).filter(Boolean))
    .catch(() => []);

  return { path, exists: true, isRepo: true, toplevel, currentBranch: currentBranch === 'HEAD' ? null : currentBranch, branches };
}

/** Where a project's worktrees go when nobody says: beside the repo, out of it. */
export function defaultWorktreeRoot(toplevel: string): string {
  return join(dirname(toplevel), '.reeve-worktrees');
}

export function branchNameFor(cardId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `reeve/${cardId.slice(0, 8)}${slug ? `-${slug}` : ''}`;
}

export function worktreePathFor(worktreeRoot: string, cardId: string): string {
  return join(worktreeRoot, cardId.slice(0, 8));
}

export interface CreatedWorktree {
  path: string;
  branch: string;
  /**
   * The base commit, captured once at creation. The implementation diff is
   * `git diff <baseSha>` with no second ref, so it covers committed AND
   * uncommitted work — Claude sometimes edits without committing, and a
   * three-dot diff would show an empty review for a run that did real work.
   */
  baseSha: string;
}

export async function createWorktree(opts: {
  repoPath: string;
  worktreeRoot: string;
  cardId: string;
  title: string;
  baseBranch: string;
}): Promise<CreatedWorktree> {
  const { repoPath, worktreeRoot, cardId, title, baseBranch } = opts;
  const path = worktreePathFor(worktreeRoot, cardId);
  const branch = branchNameFor(cardId, title);

  const baseSha = (await git(repoPath, ['rev-parse', baseBranch])).trim();
  await git(repoPath, ['worktree', 'add', '-b', branch, path, baseSha]);
  return { path, branch, baseSha };
}

export async function removeWorktree(repoPath: string, path: string, force = false): Promise<void> {
  if (!existsSync(path)) {
    // Already gone from disk; prune the metadata so git stops listing it.
    await git(repoPath, ['worktree', 'prune']);
    return;
  }
  await git(repoPath, ['worktree', 'remove', ...(force ? ['--force'] : []), path]);
}

/**
 * git reports resolved paths. On macOS a worktree under /var/... comes back as
 * /private/var/..., so a plain string compare marks every healthy worktree as
 * missing. Compare resolved paths, falling back to the literal when the path is
 * already gone.
 */
function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export type WorktreeHealth =
  | { state: 'ok'; path: string }
  | { state: 'missing'; path: string; reason: string }
  | { state: 'none' };

/**
 * Never trust a stored worktree path. They get deleted by hand, pruned, or the
 * branch gets checked out somewhere else. Validate before every run.
 */
export async function checkWorktree(repoPath: string, path: string | null): Promise<WorktreeHealth> {
  if (!path) return { state: 'none' };
  if (!existsSync(path)) return { state: 'missing', path, reason: 'directory no longer exists' };
  const refs = await listWorktrees(repoPath);
  const target = realOrSelf(path);
  const ref = refs.find((r) => realOrSelf(r.path) === target);
  if (!ref) return { state: 'missing', path, reason: 'git no longer tracks this worktree' };
  if (ref.prunable) return { state: 'missing', path, reason: 'git reports the worktree as prunable' };
  return { state: 'ok', path };
}

/** Everything the card changed, committed or not. */
export async function diffSince(worktreePath: string, baseSha: string): Promise<string> {
  return git(worktreePath, ['diff', baseSha]);
}

export interface CommitRef {
  sha: string;
  subject: string;
}

/**
 * NUL-separated rather than split on a delimiter that could appear in a commit
 * subject. Newest first, which is the order the rail lists them in.
 */
export async function commitsSince(worktreePath: string, baseSha: string): Promise<CommitRef[]> {
  const out = await git(worktreePath, ['log', '--format=%h%x00%s', `${baseSha}..HEAD`]);
  return out
    .split('\n')
    .map((line) => line.split('\0'))
    .filter((parts): parts is [string, string] => parts.length === 2 && Boolean(parts[0]))
    .map(([sha, subject]) => ({ sha, subject }));
}

/**
 * How far the base branch has moved on since this worktree started — the rail's
 * "main · 2 behind". Counts commits on the base that the worktree lacks, which
 * is not the same as commits it is missing from its own history.
 */
export async function behindBase(worktreePath: string, baseBranch: string): Promise<number | null> {
  try {
    const out = await git(worktreePath, ['rev-list', '--count', `HEAD..${baseBranch}`]);
    const n = Number.parseInt(out.trim(), 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    // A base branch that isn't fetched here is not worth failing a card view for.
    return null;
  }
}

export async function isDirty(worktreePath: string): Promise<boolean> {
  return (await git(worktreePath, ['status', '--porcelain'])).trim().length > 0;
}
