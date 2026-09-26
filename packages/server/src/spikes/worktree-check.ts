import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openDatabase } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { createCard, createRepo, eventsSince, getCard, getRun } from '../db/queries.js';
import {
  branchNameFor, checkWorktree, commitsSince, copyWorktreeIncludes, createWorktree, diffSince, isDirty, listWorktrees,
  removeWorktree,
} from '../git/worktree.js';
import { EventWriter } from '../runs/events.js';
import { ensureWorktree } from '../startStage.js';

const note = (l: string, v: unknown) => console.log(`${l.padEnd(40)}: ${v}`);
const root = mkdtempSync(join(tmpdir(), 'reeve-git-'));
const repo = join(root, 'repo');
const worktreeRoot = join(root, 'worktrees');
mkdirSync(repo); mkdirSync(worktreeRoot);

const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
g('init', '-q', '-b', 'main');
g('config', 'user.email', 't@t.t'); g('config', 'user.name', 'T');
writeFileSync(join(repo, 'README.md'), '# base\n');
g('add', '-A'); g('commit', '-qm', 'base');

const cardId = crypto.randomUUID();
note('branch name', branchNameFor(cardId, 'Wire the Planning stage end to end!!'));

const wt = await createWorktree({ repoPath: repo, worktreeRoot, cardId, title: 'Wire the Planning stage', baseBranch: 'main' });
note('worktree created', wt.path.replace(root, '…'));
note('base sha', wt.baseSha.slice(0, 8));
note('listed by git', (await listWorktrees(repo)).length + ' worktrees');
note('health', JSON.stringify(await checkWorktree(repo, wt.path)).replace(root, '…'));

// The decisive test: a committed change AND an uncommitted one.
writeFileSync(join(wt.path, 'committed.ts'), 'export const a = 1;\n');
execFileSync('git', ['-C', wt.path, 'add', '-A']);
execFileSync('git', ['-C', wt.path, 'commit', '-qm', 'add committed file']);
writeFileSync(join(wt.path, 'uncommitted.ts'), 'export const b = 2;\n');
execFileSync('git', ['-C', wt.path, 'add', '-A']); // staged but not committed

const diff = await diffSince(wt.path, wt.baseSha);
note('dirty', await isDirty(wt.path));
note('commits since base', JSON.stringify(await commitsSince(wt.path, wt.baseSha)));
note('diff covers committed', diff.includes('committed.ts'));
note('diff covers UNcommitted', diff.includes('uncommitted.ts'));

// Self-heal: delete the directory out from under the database, as a human would.
rmSync(wt.path, { recursive: true, force: true });
const health = await checkWorktree(repo, wt.path);
note('after manual delete', `${health.state}${health.state === 'missing' ? ` (${health.reason})` : ''}`);

await removeWorktree(repo, wt.path);
note('after remove', (await listWorktrees(repo)).length + ' worktrees remain');
note('health of null path', JSON.stringify(await checkWorktree(repo, null)));

// --- .worktreeinclude --------------------------------------------------------
const check = (l: string, ok: boolean) => {
  note(l, ok ? 'ok' : 'FAILED');
  if (!ok) process.exitCode = 1;
};
const read = (...p: string[]) => (existsSync(join(...p)) ? readFileSync(join(...p), 'utf8') : null);
const write = (rel: string, body: string) => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), body);
};

// Nothing to include yet: exactly what happened before the file existed.
{
  const wt = await createWorktree({ repoPath: repo, worktreeRoot, cardId: crypto.randomUUID(), title: 'No include', baseBranch: 'main' });
  write('.env', 'SECRET=from-main\n');
  write('.gitignore', '.env\n');
  check('no .worktreeinclude, nothing copied', (await copyWorktreeIncludes(repo, wt.path)).length === 0 && !existsSync(join(wt.path, '.env')));
}

// local.cfg is tracked on main, where the cards branch from, but the main
// checkout sits on a branch that ignores it and keeps its own copy.
write('.gitignore', '.env\nsecret/\nnode_modules/\nother.txt\n*.log\n');
write('local.cfg', 'as committed on main\n');
g('add', '.gitignore', 'local.cfg'); g('commit', '-qm', 'ignore things');
g('checkout', '-qb', 'elsewhere');
g('rm', '-q', '--cached', 'local.cfg');
write('.gitignore', '.env\nsecret/\nnode_modules/\nother.txt\n*.log\nlocal.cfg\n');
g('commit', '-qam', 'stop tracking local.cfg');
write('local.cfg', 'the main checkout\'s own\n');

write('.worktreeinclude', '.env\nsecret/*.json\nuntracked-not-ignored.txt\nREADME.md\nlocal.cfg\nlogs/*\n');
write('secret/keys.json', '{"key":"k"}\n');
write('secret/notes.txt', 'ignored, but not listed\n');
write('node_modules/pkg/index.js', 'module.exports = 1;\n');
write('other.txt', 'ignored, but not listed\n');
write('untracked-not-ignored.txt', 'listed, but not ignored\n');
// A directory that is untracked but not ignored as a whole, so the ignored
// listing names its ignored file rather than the directory.
write('logs/app.log', 'ignored inside a directory that is not\n');
write('logs/keep.txt', 'listed, but not ignored\n');

{
  const wt = await createWorktree({ repoPath: repo, worktreeRoot, cardId: crypto.randomUUID(), title: 'Include', baseBranch: 'main' });
  const copied = await copyWorktreeIncludes(repo, wt.path);
  note('copied', copied.join(', '));
  check('.env copied byte for byte', read(wt.path, '.env') === read(repo, '.env'));
  check('ignored, unlisted: not copied', !existsSync(join(wt.path, 'other.txt')) && !existsSync(join(wt.path, 'node_modules')));
  check('unlisted in a listed dir: not copied', !existsSync(join(wt.path, 'secret', 'notes.txt')));
  check('listed, not ignored: not copied', !existsSync(join(wt.path, 'untracked-not-ignored.txt')) && !existsSync(join(wt.path, 'logs', 'keep.txt')));
  check('tracked README left as checked out', read(wt.path, 'README.md') === '# base\n' && !copied.includes('README.md'));
  check('tracked at base: not overwritten', read(wt.path, 'local.cfg') === 'as committed on main\n' && !copied.includes('local.cfg'));
  check('inside an ignored dir: copied', read(wt.path, 'secret', 'keys.json') === '{"key":"k"}\n');
  check('ignored inside a plain dir: copied', read(wt.path, 'logs', 'app.log') === read(repo, 'logs', 'app.log'));
  check('copied list is exactly those', [...copied].sort().join() === ['.env', 'logs/app.log', 'secret/keys.json'].join());
}

// The same, through the path a card's start takes, with a setup command that
// can only succeed if the copy finished first.
{
  const db = openDatabase(join(root, 'reeve.db'));
  runMigrations(db);
  const writer = new EventWriter(db);
  const dbRepo = createRepo(db, {
    name: 'worktree-check', repoPath: repo, worktreeRoot, defaultBranch: 'main',
    setupCommand: 'cat .env', testCommand: null, serverCommand: null,
    teardownCommand: null, finishCommand: null, laneColor: null, maxBudgetUsd: null,
  });
  const startCard = (title: string) => getCard(db, createCard(db, { title, repoId: dbRepo.id, stage: 'planning' }).id)!;
  const setupOutput = async (runId: string | null) => {
    if (!runId) return [];
    for (let i = 0; i < 500 && getRun(db, runId)?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 20));
    return eventsSince(db, runId, 0)
      .filter((e) => e.kind === 'stdout')
      .map((e) => (JSON.parse(e.payload) as { line: string }).line);
  };

  const c = startCard('Setup reads .env');
  const made = await ensureWorktree(db, writer, c, dbRepo);
  note('ensureWorktree answer', JSON.stringify(made).replace(root, '…'));
  check('answer lists what was included', !made.reused && made.included.includes('.env'));
  const output = await setupOutput(made.reused ? null : made.setupRunId);
  check('setup command read the copied .env', output.includes('SECRET=from-main'));

  writeFileSync(join(made.path, '.env'), 'SECRET=edited-in-the-worktree\n');
  const again = await ensureWorktree(db, writer, getCard(db, c.id)!, dbRepo);
  check('reused worktree: nothing copied', again.reused && !('included' in again));
  check('reused worktree: edit survives', read(made.path, '.env') === 'SECRET=edited-in-the-worktree\n');

  // Unreadable, so git refuses it outright. The warning above this line is expected.
  chmodSync(join(repo, '.worktreeinclude'), 0o000);
  try {
    const bad = await ensureWorktree(db, writer, startCard('Unreadable include'), dbRepo);
    check('unreadable include: worktree made anyway', !bad.reused && existsSync(bad.path) && bad.included.length === 0);
    await setupOutput(bad.reused ? null : bad.setupRunId);
  } catch (e) {
    check(`unreadable include: worktree made anyway (${String(e)})`, false);
  } finally {
    chmodSync(join(repo, '.worktreeinclude'), 0o644);
  }
}

rmSync(root, { recursive: true, force: true });
console.log(process.exitCode ? '\nSOME WORKTREE BEHAVIOURS FAILED' : '\nall worktree behaviours verified');
