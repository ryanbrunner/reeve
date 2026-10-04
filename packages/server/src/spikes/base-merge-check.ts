import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { cardEventsFor, createCard, createRepo, getCard, insertRun, runsForCard, updateSettings } from '../db/queries.js';
import type { Card } from '../db/schema.js';
import { commitsSince, diffSince } from '../git/worktree.js';
import { EventWriter } from '../runs/events.js';
import { ensureWorktree, mergeLatestBase, startStage } from '../startStage.js';

/**
 * What a stage start does to a reused worktree once the base has moved, against
 * a throwaway repo whose `origin` is a bare repo on disk. Mostly calls
 * `mergeLatestBase` directly; the last part goes through `startStage` with the
 * concurrency cap at 0, so it does everything up to starting Claude. Proves a landed commit is merged in and `baseSha` follows it, so the diff and
 * commits stay the card's own; a branch already up to date is left alone; and a
 * dirty tree, a conflict, or an unreachable origin each leave the branch where
 * it was, with a note on the card. Through `startStage`, setup runs again after
 * a merge, and a start beside a live stage run merges nothing. Never touches
 * the local `main`.
 *
 *   npx tsx packages/server/src/spikes/base-merge-check.ts
 */

const note = (l: string, v: unknown) => console.log(`${l.padEnd(52)}: ${v}`);
const check = (l: string, ok: boolean) => {
  note(l, ok ? 'ok' : 'FAILED');
  if (!ok) process.exitCode = 1;
};

const root = mkdtempSync(join(tmpdir(), 'reeve-base-merge-'));
const repoPath = join(root, 'repo');
const other = join(root, 'other');
const origin = join(root, 'origin.git');
const worktreeRoot = join(root, 'worktrees');
mkdirSync(repoPath); mkdirSync(worktreeRoot);

const run = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: 'pipe' }).trim();
const ok = (cwd: string, ...a: string[]) => {
  try { run(cwd, ...a); return true; } catch { return false; }
};
const g = (...a: string[]) => run(repoPath, ...a);
const commit = (cwd: string, file: string, body: string) => {
  writeFileSync(join(cwd, file), `${body}\n`);
  run(cwd, 'add', file); run(cwd, 'commit', '-qm', body);
  return run(cwd, 'rev-parse', 'HEAD');
};

g('init', '-q', '-b', 'main');
g('config', 'user.email', 't@t.t'); g('config', 'user.name', 'T');
commit(repoPath, 'README.md', 'base');
commit(repoPath, 'shared.txt', 'shared, as it began');
execFileSync('git', ['init', '-q', '--bare', origin]);
g('remote', 'add', 'origin', origin);
g('push', '-q', 'origin', 'main');
g('fetch', '-q', 'origin');
const localMain = g('rev-parse', 'main');

execFileSync('git', ['clone', '-q', origin, other]);
run(other, 'config', 'user.email', 'o@o.o'); run(other, 'config', 'user.name', 'O');
/** A pull request landing on GitHub: origin moves, the local checkout does not hear of it. */
const land = (file: string, body: string) => {
  const sha = commit(other, file, body);
  run(other, 'push', '-q', 'origin', 'main');
  return sha;
};

const db = openDatabase(join(root, 'reeve.db'));
runMigrations(db);
const repo = createRepo(db, {
  name: 'base-merge-check', repoPath, worktreeRoot, defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null,
});
const writer = {} as never; // only reached for a setup command, and there is none

async function cardWithTree(title: string) {
  const made = createCard(db, { title, repoId: repo.id, stage: 'in_progress' });
  const { path } = await ensureWorktree(db, writer, made, repo);
  return { card: getCard(db, made.id)!, path };
}
const notesOf = (c: Card) => cardEventsFor(db, c.id).filter((e) => e.kind === 'note').map((e) => e.body ?? '');
const head = (path: string) => run(path, 'rev-parse', 'HEAD');

// --- 1. A branch with no commits of its own is fast-forwarded --------------
const a = await cardWithTree('No work yet');
const landed1 = land('pr-1.txt', 'PR #1, landed while A sat in review');
const mergedA = await mergeLatestBase(db, a.card, repo, a.path);
note('A outcome', JSON.stringify(mergedA));
check('A merged one commit', mergedA.state === 'merged' && mergedA.commits === 1);
check('A HEAD is the landed commit (a fast-forward)', head(a.path) === landed1);
check('A baseSha moved to it', getCard(db, a.card.id)!.baseSha === landed1);
check('A has no commits of its own', (await commitsSince(a.path, landed1)).length === 0);
check('A says what it merged', notesOf(a.card).some((b) => /^Merged 1 new commit from origin\/main/.test(b)));

// --- 2. A branch with work gets a merge commit; the diff stays its own -----
const b = await cardWithTree('Some work');
const own = commit(b.path, 'work.txt', 'card B: its own work');
land('pr-2.txt', 'PR #2');
const landed2 = land('pr-3.txt', 'PR #3');
const mergedB = await mergeLatestBase(db, b.card, repo, b.path);
note('B outcome', JSON.stringify(mergedB));
check('B merged two commits', mergedB.state === 'merged' && mergedB.commits === 2);
check('B contains the base', ok(b.path, 'merge-base', '--is-ancestor', landed2, 'HEAD'));
check('B still contains its own commit', ok(b.path, 'merge-base', '--is-ancestor', own, 'HEAD'));
const bBase = getCard(db, b.card.id)!.baseSha!;
check('B baseSha moved to origin/main', bBase === landed2);
const diffB = await diffSince(b.path, bBase);
check('B diff has its own file', diffB.includes('work.txt'));
check('B diff has none of the landed files', !/pr-[123]\.txt/.test(diffB));
const commitsB = (await commitsSince(b.path, bBase)).map((c) => c.subject);
note('B commits', JSON.stringify(commitsB));
check('B commits are its own and the merge', commitsB.length === 2 && commitsB.includes('card B: its own work'));

// --- 3. Already up to date: nothing happens, nothing is said ---------------
const notesBefore = notesOf(b.card).length;
const headB = head(b.path);
const again = await mergeLatestBase(db, getCard(db, b.card.id)!, repo, b.path);
check('B again is current', again.state === 'current');
check('B HEAD unchanged', head(b.path) === headB);
check('no note for a branch already current', notesOf(b.card).length === notesBefore);

// --- 4. Uncommitted work: skipped, and the work is untouched ---------------
const c = await cardWithTree('Dirty tree');
writeFileSync(join(c.path, 'half-done.txt'), 'not committed\n');
run(c.path, 'add', 'half-done.txt');
const headC = head(c.path);
land('pr-4.txt', 'PR #4');
const dirty = await mergeLatestBase(db, c.card, repo, c.path);
note('C outcome', JSON.stringify(dirty));
check('C skipped for uncommitted changes', dirty.state === 'skipped' && /uncommitted/.test(dirty.why));
check('C HEAD unchanged', head(c.path) === headC);
check('C still has its staged work', run(c.path, 'status', '--porcelain').includes('half-done.txt'));
check('C baseSha unchanged', getCard(db, c.card.id)!.baseSha === c.card.baseSha);
check('C has a note saying so', notesOf(c.card).some((b) => /without the latest main.*uncommitted/.test(b)));

// --- 5. A conflict: aborted, the branch exactly as it was ------------------
const d = await cardWithTree('Conflicting work');
const ownD = commit(d.path, 'shared.txt', 'shared, as card D has it');
land('shared.txt', 'shared, as main has it now');
const conflicted = await mergeLatestBase(db, d.card, repo, d.path);
note('D outcome', JSON.stringify(conflicted));
check('D skipped for the conflict', conflicted.state === 'skipped' && /conflicted in shared\.txt/.test(conflicted.why));
check('D HEAD unchanged', head(d.path) === ownD);
check('D has no merge in progress', !ok(d.path, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'));
check('D tree is clean', run(d.path, 'status', '--porcelain') === '');
check('D baseSha unchanged', getCard(db, d.card.id)!.baseSha === d.card.baseSha);
check('D note points at Done', notesOf(d.card).some((b) => /conflicted in shared\.txt.*Done/.test(b)));

// --- 6. Origin unreachable: skipped with the reason ------------------------
const e = await cardWithTree('Offline');
g('remote', 'set-url', 'origin', join(root, 'nowhere.git'));
const headE = head(e.path);
const offline = await mergeLatestBase(db, e.card, repo, e.path);
note('E outcome', JSON.stringify(offline).slice(0, 100));
check('E skipped for the fetch', offline.state === 'skipped' && /fetching origin\/main failed/.test(offline.why));
check('E HEAD unchanged', head(e.path) === headE);

g('remote', 'set-url', 'origin', origin);

// --- 7. Through startStage: setup again after a merge, nothing beside a run -
// The setup's log is outside the tree, since an untracked file would read as
// uncommitted work and skip the merge.
const setupLog = join(root, 'setup.log');
const withSetup = createRepo(db, {
  name: 'base-merge-setup', repoPath, worktreeRoot, defaultBranch: 'main',
  setupCommand: `echo ran >> ${setupLog}`, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null,
});
const realWriter = new EventWriter(db);
updateSettings(db, { maxConcurrentRuns: 0 });
const f = createCard(db, { title: 'Through startStage', repoId: withSetup.id, stage: 'in_progress' });
const first = await startStage(db, realWriter, f, withSetup);
note('F first start', JSON.stringify(first));
const setupRuns = () => runsForCard(db, f.id).filter((r) => r.kind === 'shell' && r.status === 'succeeded').length;
check('F first start refused only at the cap', !first.ok && first.status === 429);
check('F setup ran once for the new tree', setupRuns() === 1);
const fPath = getCard(db, f.id)!.worktreePath!;
const landed6 = land('pr-6.txt', 'PR #6');
const second = await startStage(db, realWriter, getCard(db, f.id)!, withSetup);
check('F second start refused only at the cap', !second.ok && second.status === 429);
check('F reused tree has the landed commit', head(fPath) === landed6);
check('F setup ran again after the merge', setupRuns() === 2);
const third = await startStage(db, realWriter, getCard(db, f.id)!, withSetup);
check('F third start, nothing landed: no setup', !third.ok && third.status === 429 && setupRuns() === 2);

insertRun(db, { id: crypto.randomUUID(), cardId: f.id, kind: 'claude', stage: 'in_progress', status: 'running', cwd: fPath });
land('pr-7.txt', 'PR #7');
const beside = await startStage(db, realWriter, getCard(db, f.id)!, withSetup);
note('F start beside a live run', JSON.stringify(beside));
check('F start beside a live run is refused', !beside.ok && beside.status === 409);
check('F nothing merged beside it', head(fPath) === landed6);

check('local main never moved', g('rev-parse', 'main') === localMain);
note('scratch', root);
