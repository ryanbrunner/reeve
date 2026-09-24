import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
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

export async function commitsSince(worktreePath: string, baseSha: string): Promise<string[]> {
  const out = await git(worktreePath, ['log', '--format=%s', `${baseSha}..HEAD`]);
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

export async function isDirty(worktreePath: string): Promise<boolean> {
  return (await git(worktreePath, ['status', '--porcelain'])).trim().length > 0;
}
