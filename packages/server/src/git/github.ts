import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProbeResult } from '../runs/models.js';
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

/**
 * `reeve doctor` waits on its slowest check, and `gh --version` and
 * `gh auth status` are local enough that a quarter of a pull request's allowance
 * is plenty.
 */
const GH_PROBE_TIMEOUT_MS = 15_000;

// Built per call rather than once, so a PATH set after import still counts.
const unprompted = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' });

/** Finished by whoever says it: the server, or `reeve doctor` in someone's shell. */
const GH_MISSING = 'the GitHub CLI (gh) is not installed, or not on';

const isMissing = (cause: unknown) => (cause as { code?: unknown }).code === 'ENOENT';

async function gh(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('gh', args, { cwd, env: unprompted(), timeout: GH_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    return stdout;
  } catch (cause) {
    throw new GitError(
      `gh ${args.slice(0, 2).join(' ')} failed`,
      isMissing(cause) ? `${GH_MISSING} the server’s PATH` : failureOutput(cause, GH_TIMEOUT_MS),
    );
  }
}

export interface GhProbeResult extends ProbeResult {
  /**
   * The token's OAuth scopes, as `gh auth status` lists them, or null when
   * it named none — a fine-grained personal access token, which carries no
   * scope list at all, or a probe that never got as far as logging in.
   */
  scopes: string[] | null;
}

/**
 * Whether pull requests could be opened from here, for `reeve doctor`: `gh` is
 * installed, and logged in. Asked from the doctor's shell, whose PATH and login
 * may not be the server's.
 */
export async function ghProbe(): Promise<GhProbeResult> {
  const run = (args: string[]) =>
    exec('gh', args, { env: unprompted(), timeout: GH_PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  let version: string;
  try {
    version = (await run(['--version'])).stdout.split('\n')[0]?.trim() ?? 'gh';
  } catch (cause) {
    return {
      ok: false,
      detail: isMissing(cause) ? `${GH_MISSING} this shell’s PATH` : firstLine(failureOutput(cause, GH_PROBE_TIMEOUT_MS)),
      scopes: null,
    };
  }
  try {
    // `auth status` writes to stderr in some versions and stdout in others.
    const { stdout, stderr } = await run(['auth', 'status']);
    const text = `${stdout}\n${stderr}`;
    const account = /Logged in to (\S+) (?:account|as) (\S+)/.exec(text);
    const scopes = parseScopes(text);
    return {
      ok: true,
      detail: account ? `${version}, logged in to ${account[1]} as ${account[2]}` : `${version}, logged in`,
      scopes,
    };
  } catch (cause) {
    return { ok: false, detail: `${version}, but not logged in: ${firstLine(failureOutput(cause, GH_PROBE_TIMEOUT_MS))}`, scopes: null };
  }
}

/**
 * `gh auth status`'s "Token scopes: 'repo', 'workflow'" line, parsed into the
 * list it names — or null, for a token that carries no OAuth scopes at all,
 * which a fine-grained personal access token reports as a bare `none` rather
 * than omitting the line.
 */
function parseScopes(authStatus: string): string[] | null {
  const line = /Token scopes: (.+)/.exec(authStatus)?.[1];
  if (!line || line.trim() === 'none') return null;
  return line.split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
}

/** `gh auth status` answers in a paragraph; its first line says what is wrong. */
const firstLine = (text: string) => text.split('\n').find((l) => l.trim())?.trim() ?? text;

export interface PullRequestRef {
  url: string;
  number: number;
}

/** Never forced: a branch someone else has pushed to is theirs to reconcile. */
export async function pushBranch(worktreePath: string, branch: string): Promise<void> {
  await git(worktreePath, ['push', '-u', 'origin', branch], { env: unprompted(), timeout: PUSH_TIMEOUT_MS });
}

/**
 * `branch` as `origin` has it now, and the commit that is. The refspec is
 * spelled out rather than left to the remote's configuration, so the
 * remote-tracking ref is updated however `origin` was set up, and the sha
 * answered is exactly the one fetched.
 */
export async function fetchBranch(worktreePath: string, branch: string): Promise<string> {
  const ref = `refs/remotes/origin/${branch}`;
  await git(worktreePath, ['fetch', 'origin', `+refs/heads/${branch}:${ref}`], { env: unprompted(), timeout: PUSH_TIMEOUT_MS });
  return (await git(worktreePath, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
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
  /**
   * Whether GitHub could merge it as it stands. `UNKNOWN` is not an answer: it
   * is what GitHub says for a while after every push, until it has worked it out.
   */
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
}

/**
 * Where a pull request Reeve opened has got to. Asked by URL rather than by
 * branch: GitHub may delete the head branch on merge, and a URL names the
 * pull request from any checkout, not just the card's own worktree.
 */
export async function pullRequestState(cwd: string, url: string): Promise<PullRequestState> {
  const out = await gh(cwd, ['pr', 'view', url, '--json', 'state,mergedAt,mergeCommit,baseRefName,mergeable']);
  const pr = JSON.parse(out) as {
    state?: unknown; mergedAt?: unknown; mergeCommit?: { oid?: unknown } | null; baseRefName?: unknown; mergeable?: unknown;
  };
  if (pr.state !== 'OPEN' && pr.state !== 'CLOSED' && pr.state !== 'MERGED') {
    throw new GitError('gh pr view gave no pull request state', out.trim());
  }
  const mergedAt = typeof pr.mergedAt === 'string' && pr.mergedAt ? new Date(pr.mergedAt) : null;
  const sha = pr.mergeCommit?.oid;
  return {
    state: pr.state,
    mergedAt: mergedAt && !Number.isNaN(mergedAt.getTime()) ? mergedAt : null,
    mergeSha: typeof sha === 'string' ? sha : null,
    base: typeof pr.baseRefName === 'string' ? pr.baseRefName : '',
    mergeable: pr.mergeable === 'MERGEABLE' || pr.mergeable === 'CONFLICTING' ? pr.mergeable : 'UNKNOWN',
  };
}

/**
 * Squash the card's pull request onto its base branch.
 *
 * `--squash` is passed so that `gh` never drops into its interactive picker,
 * which on a server is a promise that never settles.
 *
 * Deliberately NOT `--admin`, whether a person pressed Merge or VIBES MODE
 * did. VIBES MODE's business is Reeve's own human-in-the-loop gates, and those
 * are Reeve's to waive; a repository's branch protection belongs to whoever set
 * it up and is not, and the Merge button is a shortcut to GitHub's, not a way
 * round it. So a repo that requires a review still requires one, `gh` refuses,
 * and the card records a `merge_failed` saying why rather than the rule being
 * bypassed quietly.
 *
 * The branch is left alone: the card's worktree is still checked out on it.
 */
export async function mergePullRequest(cwd: string, url: string): Promise<void> {
  await gh(cwd, ['pr', 'merge', url, '--squash']);
}

/** Set the pull request's title and description: what Release wrote for it. */
export async function editPullRequest(cwd: string, url: string, title: string, body: string): Promise<void> {
  await gh(cwd, ['pr', 'edit', url, '--title', title, '--body', body]);
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
