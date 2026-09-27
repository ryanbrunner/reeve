import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { cp, lstat, mkdir } from 'node:fs/promises';
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

/**
 * `env` and `timeout` are for the commands that talk to a remote, where a
 * credential prompt with nobody at the terminal would otherwise wait forever.
 */
export async function git(
  repoPath: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', repoPath, ...args], { maxBuffer: 16 * 1024 * 1024, ...opts });
    return stdout;
  } catch (cause) {
    throw new GitError(`git ${args[0]} failed in ${repoPath}`, failureOutput(cause, opts.timeout));
  }
}

/**
 * What a failed command had to say. Falls back to stdout because some failures
 * only speak there: a merge prints its CONFLICT lines to stdout, and so do
 * plenty of commit hooks. A command killed for taking too long often said
 * nothing at all, so that is reported in words rather than as a blank.
 */
export function failureOutput(cause: unknown, timeout?: number): string {
  const e = cause as { stderr?: string; stdout?: string; message?: string; killed?: boolean };
  const said = e.stderr?.trim() || e.stdout?.trim() || '';
  if (e.killed && timeout) return `no answer after ${timeout / 1000}s${said ? `: ${said}` : ''}`;
  return said || e.message?.trim() || '';
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
   * pointing at `packages/web` files the repo as the whole thing
   * rather than storing a path git would keep reinterpreting.
   */
  toplevel: string | null;
  currentBranch: string | null;
  branches: string[];
}

/**
 * What a repo path really is, before anything is built on top of it.
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

/** Where a repo's worktrees go when nobody says: beside the repo, out of it. */
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

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  return git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(
    () => true,
    () => false,
  );
}

/** `base` is anything `rev-parse` takes: the sha just fetched, or a branch name. */
export async function createWorktree(opts: {
  repoPath: string;
  worktreeRoot: string;
  cardId: string;
  title: string;
  base: string;
  /** The branch and base the card had before, if its worktree has been removed since. */
  previous?: { branch: string; baseSha: string } | null;
}): Promise<CreatedWorktree> {
  const { repoPath, worktreeRoot, cardId, title, base, previous } = opts;
  const path = worktreePathFor(worktreeRoot, cardId);

  // Removing a worktree keeps its branch, and `worktree add -b` refuses a
  // branch that exists, so a card whose worktree was removed (`reeve card
  // worktree --remove`, or deleted by hand) could never have one again. Its
  // branch is checked out afresh instead, with the base it started from, so
  // its diff and commits still count from where the card began. Pruned first,
  // because a directory deleted by hand leaves git thinking the branch is
  // still checked out there.
  if (previous && (await branchExists(repoPath, previous.branch))) {
    await git(repoPath, ['worktree', 'prune']);
    await git(repoPath, ['worktree', 'add', path, previous.branch]);
    return { path, branch: previous.branch, baseSha: previous.baseSha };
  }

  const branch = branchNameFor(cardId, title);

  const baseSha = (await git(repoPath, ['rev-parse', '--verify', `${base}^{commit}`])).trim();
  await git(repoPath, ['worktree', 'add', '-b', branch, path, baseSha]);
  return { path, branch, baseSha };
}

/**
 * Copy what a repo's `.worktreeinclude` names from the main checkout into a new
 * worktree: the `.env` and local config a fresh checkout never has. Claude
 * Code's rule, so a repo set up for its worktrees works in Reeve's too. The
 * file uses `.gitignore` syntax, and only files that match it AND are
 * gitignored are copied, so a tracked file is never duplicated. Returns the
 * paths copied, relative to the repo.
 *
 * Two listings rather than one. The first uses the include patterns alone, so
 * its answer is small. The ignored set is collapsed with `--directory`,
 * because listed in full it is every file in `node_modules`, and that can
 * overflow `git()`'s buffer. A match counts as ignored if it is in that set or
 * under a directory the set names whole.
 *
 * Nothing already in the worktree is overwritten: with the main checkout on
 * another branch, a file ignored there can be tracked at the card's base, and
 * the checked-out copy is the right one. Symlinks are copied as symlinks, and
 * nothing is ever linked back to the main checkout.
 */
export async function copyWorktreeIncludes(repoPath: string, worktreePath: string): Promise<string[]> {
  const includeFile = join(repoPath, '.worktreeinclude');
  if (!existsSync(includeFile)) return [];

  const listed = async (args: string[]) =>
    (await git(repoPath, ['ls-files', '-z', '--others', '--ignored', ...args])).split('\0').filter(Boolean);
  // A nested repository is listed as its directory even without `--directory`,
  // and there is no one file there to copy.
  const matched = (await listed([`--exclude-from=${includeFile}`])).filter((p) => !p.endsWith('/'));
  if (!matched.length) return [];
  const ignored = await listed(['--exclude-standard', '--directory']);
  const ignoredFiles = new Set(ignored);
  const ignoredDirs = ignored.filter((p) => p.endsWith('/'));

  const copied: string[] = [];
  for (const rel of matched) {
    if (!ignoredFiles.has(rel) && !ignoredDirs.some((dir) => rel.startsWith(dir))) continue;
    const dest = join(worktreePath, rel);
    // lstat rather than existsSync, which follows a link and calls a dangling one absent.
    if (await lstat(dest).then(() => true, () => false)) continue;
    await mkdir(dirname(dest), { recursive: true });
    await cp(join(repoPath, rel), dest, { force: false, errorOnExist: false, verbatimSymlinks: true, preserveTimestamps: true });
    copied.push(rel);
  }
  return copied;
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
 *
 * The native realpath, because it also gives back the case stored on disk, and
 * the JS one hands back whatever case it was given. macOS ignores case by
 * default, so `…/REEVE.db` and `/users/ryan/…` open the same file as the
 * spelling on disk. Found as a way past the live-board check in the shell
 * policy while verifying card 1cec1c89: a re-cased `REEVE_DB` compared unequal
 * and was allowed.
 */
export function realOrSelf(p: string): string {
  try {
    return realpathSync.native(p);
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

/**
 * Everything the card changed, committed or not. With `ref`, only what is
 * committed there: that is for a card whose worktree is gone, read from its
 * branch in the main checkout, where the working tree is not the card's.
 * Without it there is deliberately no second ref, not even `HEAD`, so that
 * uncommitted work counts.
 */
export async function diffSince(cwd: string, baseSha: string, ref?: string): Promise<string> {
  return git(cwd, ['diff', baseSha, ...(ref ? [ref] : []), '--']);
}

export interface CommitRef {
  sha: string;
  subject: string;
}

/**
 * NUL-separated rather than split on a delimiter that could appear in a commit
 * subject. Newest first, which is the order the rail lists them in. `ref` is
 * the card's branch when the worktree whose HEAD it was has been removed.
 */
export async function commitsSince(cwd: string, baseSha: string, ref = 'HEAD'): Promise<CommitRef[]> {
  // `--` so a branch that shares its name with a path is read as the branch.
  return parseLog(await git(cwd, ['log', '--format=%h%x00%s', `${baseSha}..${ref}`, '--']));
}

function parseLog(out: string): CommitRef[] {
  return out
    .split('\n')
    .map((line) => line.split('\0'))
    .filter((parts): parts is [string, string] => parts.length === 2 && Boolean(parts[0]))
    .map(([sha, subject]) => ({ sha, subject }));
}

/**
 * What one commit changed. Two refs rather than `diffSince`'s one, because the
 * checkout this runs in is the user's, and its working tree is none of ours.
 */
export async function diffOfCommit(repoPath: string, sha: string): Promise<string> {
  return git(repoPath, ['diff', `${sha}^`, sha]);
}

export async function commitAt(repoPath: string, sha: string): Promise<CommitRef[]> {
  return parseLog(await git(repoPath, ['log', '-1', '--format=%h%x00%s', sha]));
}

/**
 * How far the base branch has moved on since this worktree started — the rail's
 * "main · 2 behind". Counts commits on the base that the worktree lacks, which
 * is not the same as commits it is missing from its own history.
 *
 * Against `origin/<base>`, as last fetched: the local branch is the person's,
 * and moves only when they pull. Nothing here fetches — a card view stays
 * offline, and the merge sync keeps the remote-tracking ref current.
 */
export async function behindBase(worktreePath: string, baseBranch: string): Promise<number | null> {
  try {
    const out = await git(worktreePath, ['rev-list', '--count', `HEAD..origin/${baseBranch}`]);
    const n = Number.parseInt(out.trim(), 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    // A base branch that isn't fetched here is not worth failing a card view for.
    return null;
  }
}

/** `ignore` is for paths that are nobody's work. */
export async function isDirty(worktreePath: string, opts: { ignore?: string[] } = {}): Promise<boolean> {
  const args = ['status', '--porcelain'];
  if (opts.ignore?.length) args.push('--', '.', ...opts.ignore.map((p) => `:(exclude)${p}`));
  return (await git(worktreePath, args)).trim().length > 0;
}

export async function headSha(worktreePath: string): Promise<string> {
  return (await git(worktreePath, ['rev-parse', '--verify', 'HEAD'])).trim();
}

/**
 * Asked of git rather than looked for on disk: in a worktree `.git` is a file,
 * and MERGE_HEAD lives in the main repo's `worktrees/<name>/` instead.
 */
export async function mergeInProgress(worktreePath: string): Promise<boolean> {
  try {
    await git(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
    return true;
  } catch {
    return false;
  }
}

/** Paths git still holds as conflicted, NUL-separated so no filename can split one. */
export async function unmergedPaths(worktreePath: string): Promise<string[]> {
  const out = await git(worktreePath, ['diff', '--name-only', '-z', '--diff-filter=U']);
  return [...new Set(out.split('\0').filter(Boolean))];
}

export type MergeStart = { clean: true } | { clean: false; conflicts: string[] };

/**
 * Merge `ref` into the worktree's branch, committing if it applies cleanly and
 * stopping mid-merge if it does not. A merge refused for any other reason — an
 * untracked file in the way, a hook — is backed out and thrown, since there is
 * nothing to resolve and nothing should be left half-done.
 */
export async function startMerge(worktreePath: string, ref: string): Promise<MergeStart> {
  try {
    await git(worktreePath, ['merge', '--no-edit', ref]);
    return { clean: true };
  } catch (e) {
    const conflicts = await unmergedPaths(worktreePath);
    if (conflicts.length) return { clean: false, conflicts };
    if (await mergeInProgress(worktreePath)) await abortMerge(worktreePath);
    throw e;
  }
}

export async function abortMerge(worktreePath: string): Promise<void> {
  await git(worktreePath, ['merge', '--abort']);
}

/** Only for undoing what Reeve itself just did to a tree it found clean. */
export async function resetTo(worktreePath: string, sha: string): Promise<void> {
  await git(worktreePath, ['reset', '-q', '--hard', sha]);
}

/** git answers "no" by failing, so any failure reads as no. */
export async function isAncestor(worktreePath: string, ancestor: string, descendant = 'HEAD'): Promise<boolean> {
  try {
    await git(worktreePath, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/**
 * `current` covers a branch that is ahead, too: nothing to take, and nothing
 * of the person's to lose.
 */
export type FastForward = 'moved' | 'current' | 'diverged';

/**
 * Bring the repo's own `branch` up to `origin/<branch>` as last fetched, the
 * way `git pull --ff-only` would. The only place Reeve moves the person's
 * checkout rather than a card's, so git is left to refuse everything unsafe
 * and nothing here is ever forced, reset or checked out.
 *
 * Where the branch is checked out, it is merged `--ff-only` in that checkout,
 * which refuses local edits the new commits would overwrite and carries the
 * rest across, as a pull does. Where it is not, the ref is fetched into from
 * the repo itself rather than set with `update-ref`: without a `+` git refuses
 * anything but a fast-forward, and refuses a branch that some worktree has
 * checked out or is part-way through rebasing. The rebase matters: its
 * worktree is detached, so looking for the checkout by branch cannot see it.
 */
export async function fastForwardBranch(repoPath: string, branch: string): Promise<FastForward> {
  const local = `refs/heads/${branch}`;
  const upstream = `refs/remotes/origin/${branch}`;
  if (await isAncestor(repoPath, upstream, local)) return 'current';
  if (!(await isAncestor(repoPath, local, upstream))) return 'diverged';

  const checkout = (await listWorktrees(repoPath)).find((w) => w.branch === branch);
  if (checkout) await git(checkout.path, ['merge', '--ff-only', '--quiet', upstream]);
  else await git(repoPath, ['fetch', '--quiet', '.', `${upstream}:${local}`]);
  return 'moved';
}

/** Paths HEAD differs from `sha` in, NUL-separated like `unmergedPaths`. */
export async function changedPaths(worktreePath: string, sha: string): Promise<string[]> {
  return (await git(worktreePath, ['diff', '--name-only', '-z', sha, 'HEAD'])).split('\0').filter(Boolean);
}

/**
 * Which of `paths` still carry a conflict marker as committed at HEAD. Only the
 * two ends of a hunk count: a bare `=======` is a heading underline in half the
 * Markdown there is. A path HEAD no longer has was resolved by deleting it.
 */
export async function conflictMarkersIn(worktreePath: string, paths: string[]): Promise<string[]> {
  if (!paths.length) return [];
  const present = (await git(worktreePath, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...paths]))
    .split('\0')
    .filter(Boolean);
  const marked: string[] = [];
  for (const path of present) {
    const content = await git(worktreePath, ['show', `HEAD:${path}`]);
    if (/^(<{7}|>{7})( |$)/m.test(content)) marked.push(path);
  }
  return marked;
}

/**
 * Capital D, always: git judges merged-ness by ancestry, and a squash leaves
 * none, so `-d` refuses every branch this is ever asked to delete.
 */
export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  await git(repoPath, ['branch', '-D', branch]);
}
