import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitError, failureOutput, git } from './worktree.js';

const exec = promisify(execFile);

/**
 * Talking to GitHub, through the person's own `git` and `gh`.
 *
 * `gh` rather than a token and an API client: it already holds their login,
 * and Reeve has nowhere safe to keep a secret. Everything here runs with
 * prompts off and a timeout, because a server has no terminal for a password
 * prompt to wait on — without both, a missing credential is a promise that
 * never settles rather than an error anyone sees.
 */

const PUSH_TIMEOUT_MS = 120_000;
const GH_TIMEOUT_MS = 60_000;

// Built per call rather than once, so a PATH set after import still counts.
const unprompted = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' });

async function gh(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('gh', args, { cwd, env: unprompted(), timeout: GH_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    return stdout;
  } catch (cause) {
    const missing = (cause as { code?: unknown }).code === 'ENOENT';
    throw new GitError(
      `gh ${args.slice(0, 2).join(' ')} failed`,
      missing ? 'the GitHub CLI (gh) is not installed, or not on the server’s PATH' : failureOutput(cause, GH_TIMEOUT_MS),
    );
  }
}

export interface PullRequestRef {
  url: string;
  number: number;
}

/** Never forced: a branch someone else has pushed to is theirs to reconcile. */
export async function pushBranch(worktreePath: string, branch: string): Promise<void> {
  await git(worktreePath, ['push', '-u', 'origin', branch], { env: unprompted(), timeout: PUSH_TIMEOUT_MS });
}

/**
 * The open pull request for `branch`, if there is one.
 *
 * Only "none found" means none. Every other failure — not logged in, a remote
 * that is not GitHub — is thrown, because answering null to those would send
 * the caller off to create a pull request that fails the same way, with a
 * message about creating rather than the real cause.
 */
export async function findPullRequest(worktreePath: string, branch: string): Promise<PullRequestRef | null> {
  let out: string;
  try {
    out = await gh(worktreePath, ['pr', 'view', branch, '--json', 'url,number,state']);
  } catch (e) {
    if (e instanceof GitError && /no pull requests? found/i.test(e.stderr)) return null;
    throw e;
  }
  const pr = JSON.parse(out) as { url?: unknown; number?: unknown; state?: unknown };
  // A closed or merged one is history; the branch gets a new pull request.
  if (pr.state !== 'OPEN' || typeof pr.url !== 'string' || typeof pr.number !== 'number') return null;
  return { url: pr.url, number: pr.number };
}

export interface PullRequestState {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergedAt: Date | null;
  /** The commit the pull request landed as on its base branch, once merged. */
  mergeSha: string | null;
  base: string;
}

/**
 * Where a pull request Reeve opened has got to. Asked by URL rather than by
 * branch: GitHub may delete the head branch on merge, and a URL names the
 * pull request from any checkout, not just the card's own worktree.
 */
export async function pullRequestState(cwd: string, url: string): Promise<PullRequestState> {
  const out = await gh(cwd, ['pr', 'view', url, '--json', 'state,mergedAt,mergeCommit,baseRefName']);
  const pr = JSON.parse(out) as { state?: unknown; mergedAt?: unknown; mergeCommit?: { oid?: unknown } | null; baseRefName?: unknown };
  if (pr.state !== 'OPEN' && pr.state !== 'CLOSED' && pr.state !== 'MERGED') {
    throw new GitError('gh pr view gave no pull request state', out.trim());
  }
  const mergedAt = typeof pr.mergedAt === 'string' && pr.mergedAt ? new Date(pr.mergedAt) : null;
  return {
    state: pr.state,
    mergedAt: mergedAt && !Number.isNaN(mergedAt.getTime()) ? mergedAt : null,
    mergeSha: typeof pr.mergeCommit?.oid === 'string' ? pr.mergeCommit.oid : null,
    base: typeof pr.baseRefName === 'string' ? pr.baseRefName : '',
  };
}

/**
 * Ready for review, not a draft. `--head` names the branch outright, so `gh`
 * neither guesses it from the checkout nor offers to push it.
 */
export async function createPullRequest(opts: {
  worktreePath: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}): Promise<PullRequestRef> {
  const { worktreePath, branch, base, title, body } = opts;
  const out = await gh(worktreePath, ['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body', body]);
  // `gh pr create` prints the new pull request's URL as its last line.
  const url = out.trim().split('\n').pop()?.trim() ?? '';
  const number = Number.parseInt(/\/pull\/(\d+)/.exec(url)?.[1] ?? '', 10);
  if (Number.isNaN(number)) throw new GitError('gh pr create gave no pull request URL', out.trim());
  return { url, number };
}
