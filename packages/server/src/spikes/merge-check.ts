import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitAt, commitsSince, createWorktree, deleteBranch, diffOfCommit, findCheckout, GitError, isDirty,
  listWorktrees, removeWorktree, squashMerge,
} from '../git/worktree.js';

/**
 * Every path through the merge that touches the user's main checkout, against
 * a throwaway repo. The one that matters most is the conflict: it must leave
 * main exactly as it found it, including a file the branch added.
 */

const note = (l: string, v: unknown) => console.log(`${l.padEnd(34)}: ${v}`);
const check = (l: string, ok: boolean) => {
  note(l, ok ? 'ok' : 'FAILED');
  if (!ok) process.exitCode = 1;
};

const root = mkdtempSync(join(tmpdir(), 'reeve-merge-'));
const repo = join(root, 'repo');
const worktreeRoot = join(root, 'worktrees');
mkdirSync(repo); mkdirSync(worktreeRoot);

const run = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
const g = (...a: string[]) => run(repo, ...a);
g('init', '-q', '-b', 'main');
g('config', 'user.email', 't@t.t'); g('config', 'user.name', 'T');
writeFileSync(join(repo, 'README.md'), '# base\n');
writeFileSync(join(repo, 'shared.txt'), 'one\n');
g('add', '-A'); g('commit', '-qm', 'base');

const mainLog = () => g('log', '--format=%s', 'main').trim().split('\n');
const mainStatus = () => g('status', '--porcelain').trim();

/** A card with a worktree and one commit, as In Progress would leave it. */
async function card(title: string, files: Record<string, string>) {
  const cardId = crypto.randomUUID();
  const wt = await createWorktree({ repoPath: repo, worktreeRoot, cardId, title, baseBranch: 'main' });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(wt.path, name), body);
  run(wt.path, 'add', '-A');
  run(wt.path, 'commit', '-qm', `work on ${title}`);
  // What every stage leaves behind, untracked: must not count as unsaved work.
  mkdirSync(join(wt.path, '.reeve'));
  writeFileSync(join(wt.path, '.reeve', 'plan.md'), '# plan\n');
  return wt;
}

const failure = (e: unknown) => (e instanceof GitError ? `${e.message}: ${e.stderr}` : String(e));

// --- the happy path ---------------------------------------------------------
{
  const wt = await card('Add a greeting', { 'greeting.txt': 'hello\n', 'more.txt': 'more\n' });
  run(wt.path, 'commit', '-q', '--allow-empty', '-m', 'second commit');
  check('card tree clean despite .reeve/', !(await isDirty(wt.path, { ignore: ['.reeve'] })));
  check('card has commits to merge', (await commitsSince(wt.path, wt.baseSha)).length === 2);

  const checkout = await findCheckout(repo, 'main');
  check('main found checked out', checkout !== null);
  const before = mainLog().length;
  const sha = await squashMerge({ checkoutPath: checkout!, branch: wt.branch, message: ['Add a greeting', 'Reeve #1'] });
  check('exactly one new commit on main', mainLog().length === before + 1);
  check('titled with the card', mainLog()[0] === 'Add a greeting');
  check('main clean after merge', mainStatus() === '');

  await removeWorktree(repo, wt.path, true);
  await deleteBranch(repo, wt.branch);
  check('worktree directory gone', !existsSync(wt.path));
  check('worktree unlisted', !(await listWorktrees(repo)).some((r) => r.branch === wt.branch));
  check('branch deleted', g('branch', '--list', wt.branch).trim() === '');

  const diff = await diffOfCommit(repo, sha);
  check('merged diff still readable', diff.includes('greeting.txt') && diff.includes('more.txt'));
  check('merged commit still listed', (await commitAt(repo, sha))[0]?.subject === 'Add a greeting');
}

// --- refusals the route makes before touching main ----------------------------
{
  const wt = await card('Dirty card', { 'dirty.txt': 'a\n' });
  writeFileSync(join(wt.path, 'dirty.txt'), 'edited, never committed\n');
  check('uncommitted edit counts as dirty', await isDirty(wt.path, { ignore: ['.reeve'] }));
  writeFileSync(join(wt.path, 'dirty.txt'), 'a\n');
  writeFileSync(join(wt.path, 'new-untracked.ts'), 'x\n');
  check('untracked new file counts as dirty', await isDirty(wt.path, { ignore: ['.reeve'] }));
  rmSync(join(wt.path, 'new-untracked.ts'));

  writeFileSync(join(repo, 'README.md'), '# base, edited by hand\n');
  check('edited main counts as dirty', await isDirty(repo, { untracked: false }));
  g('checkout', '--', 'README.md');
  writeFileSync(join(repo, 'scratch.txt'), 'mine\n');
  check('untracked file in main is not', !(await isDirty(repo, { untracked: false })));
  rmSync(join(repo, 'scratch.txt'));

  g('checkout', '-q', '-b', 'elsewhere');
  check('main checked out nowhere', (await findCheckout(repo, 'main')) === null);
  g('checkout', '-q', 'main');

  await removeWorktree(repo, wt.path, true);
  await deleteBranch(repo, wt.branch);
}

// --- a conflict, which must leave main untouched ----------------------------
{
  const wt = await card('Conflicting', { 'shared.txt': 'from the card\n', 'brand-new.txt': 'added\n' });
  writeFileSync(join(repo, 'shared.txt'), 'from main\n');
  g('commit', '-qam', 'main moves on');
  const head = g('rev-parse', 'HEAD').trim();

  let error = '';
  try {
    await squashMerge({ checkoutPath: repo, branch: wt.branch, message: ['Conflicting'] });
  } catch (e) {
    error = failure(e);
  }
  note('conflict error', error);
  check('error names the file', error.includes('shared.txt'));
  check('main HEAD unmoved', g('rev-parse', 'HEAD').trim() === head);
  check('main status empty', mainStatus() === '');
  check('added file not left behind', !existsSync(join(repo, 'brand-new.txt')));
  check('no squash message left', !existsSync(join(repo, '.git', 'SQUASH_MSG')));

  await removeWorktree(repo, wt.path, true);
  await deleteBranch(repo, wt.branch);
}

// --- a branch whose change is already on main -------------------------------
{
  const wt = await card('Already there', { 'same.txt': 'identical\n' });
  writeFileSync(join(repo, 'same.txt'), 'identical\n');
  g('add', 'same.txt'); g('commit', '-qm', 'someone got there first');
  const head = g('rev-parse', 'HEAD').trim();

  let error = '';
  try {
    await squashMerge({ checkoutPath: repo, branch: wt.branch, message: ['Already there'] });
  } catch (e) {
    error = failure(e);
  }
  note('empty error', error);
  check('empty squash refused', error.startsWith('nothing to merge'));
  check('main HEAD unmoved', g('rev-parse', 'HEAD').trim() === head);
  check('main status empty', mainStatus() === '');

  await removeWorktree(repo, wt.path, true);
  await deleteBranch(repo, wt.branch);
}

// --- a pre-commit hook that says no -----------------------------------------
{
  const wt = await card('Hooked', { 'hooked.txt': 'x\n' });
  const hook = join(repo, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho "lint says no" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  const head = g('rev-parse', 'HEAD').trim();

  let error = '';
  try {
    await squashMerge({ checkoutPath: repo, branch: wt.branch, message: ['Hooked'] });
  } catch (e) {
    error = failure(e);
  }
  note('hook error', error);
  check('hook output surfaced', error.includes('lint says no'));
  check('main HEAD unmoved', g('rev-parse', 'HEAD').trim() === head);
  check('main status empty', mainStatus() === '');
  rmSync(hook);

  await removeWorktree(repo, wt.path, true);
  await deleteBranch(repo, wt.branch);
}

rmSync(root, { recursive: true, force: true });
console.log(process.exitCode ? '\nSOME MERGE BEHAVIOURS FAILED' : '\nall merge behaviours verified');
