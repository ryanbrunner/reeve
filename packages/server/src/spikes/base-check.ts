import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { cardEventsFor, createCard, createRepo, getCard } from '../db/queries.js';
import { cardDetail } from '../detail.js';
import { writeHandoff } from '../handoff.js';
import { syncMergedPullRequests } from '../pullRequest.js';
import { ensureWorktree } from '../startStage.js';

/**
 * Where a card's branch is cut from, against a throwaway repo whose `origin`
 * is a bare repo on disk and whose local `main` has split from it: one commit
 * only local, one only on origin. Proves the card starts from origin, leaves
 * the local-only commit out, falls back to the local branch with a note when
 * origin cannot be fetched, counts "behind" against origin after a merge sync,
 * and never moves the local `main`.
 */

const note = (l: string, v: unknown) => console.log(`${l.padEnd(52)}: ${v}`);
const check = (l: string, ok: boolean) => {
  note(l, ok ? 'ok' : 'FAILED');
  if (!ok) process.exitCode = 1;
};

const root = mkdtempSync(join(tmpdir(), 'reeve-base-'));
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
const commit = (cwd: string, file: string, msg: string) => {
  writeFileSync(join(cwd, file), `${msg}\n`);
  run(cwd, 'add', '-A'); run(cwd, 'commit', '-qm', msg);
  return run(cwd, 'rev-parse', 'HEAD');
};

g('init', '-q', '-b', 'main');
g('config', 'user.email', 't@t.t'); g('config', 'user.name', 'T');
commit(repoPath, 'README.md', 'base');
execFileSync('git', ['init', '-q', '--bare', origin]);
g('remote', 'add', 'origin', origin);
g('push', '-q', 'origin', 'main');
g('fetch', '-q', 'origin');

execFileSync('git', ['clone', '-q', origin, other]);
run(other, 'config', 'user.email', 'o@o.o'); run(other, 'config', 'user.name', 'O');
/** A pull request landing on GitHub: origin moves, the local checkout does not hear of it. */
const land = (file: string, msg: string) => {
  const sha = commit(other, file, msg);
  run(other, 'push', '-q', 'origin', 'main');
  return sha;
};

const unpushed = commit(repoPath, 'local-only.txt', 'unpushed, on local main only');
const landed = land('pr-24.txt', 'PR #24, squash-merged on GitHub');
const localMain = g('rev-parse', 'main');

const db = openDatabase(join(root, 'reeve.db'));
runMigrations(db);
const repo = createRepo(db, {
  name: 'base-check', repoPath, worktreeRoot, defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null, maxBudgetUsd: null,
});
const writer = {} as never; // only reached for a setup command, and there is none

// --- 1. A card started while local main has an unpushed commit -------------
const a = createCard(db, { title: 'Card from origin', repoId: repo.id, stage: 'in_progress' });
const madeA = await ensureWorktree(db, writer, a, repo);
const cardA = getCard(db, a.id)!;
const wtA = madeA.path;
const originMain = g('rev-parse', 'origin/main');
note('origin/main as fetched', originMain.slice(0, 8));
check('origin/main has the landed commit', originMain === landed);
check('merge-base --is-ancestor origin/main HEAD', ok(wtA, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD'));
check('unpushed commit is NOT an ancestor of HEAD', !ok(wtA, 'merge-base', '--is-ancestor', unpushed, 'HEAD'));
check('baseSha == origin/main as fetched', cardA.baseSha === originMain);
const eventsA = cardEventsFor(db, a.id);
note('card A events', JSON.stringify(eventsA.map((e) => [e.kind, e.body])));
check('no note written for a fetched start', eventsA.filter((e) => e.kind === 'note').length === 0);
check('local main unchanged after start', g('rev-parse', 'main') === localMain);

// --- 4. The rail's "behind" after a PR merges on GitHub --------------------
const detailBefore = await cardDetail(db, cardA, repo.name, null, repo);
note('rail before merge', `${detailBefore.worktree.baseBranch} · ${detailBefore.worktree.behind} behind`);
check('behind is 0 at start', detailBefore.worktree.behind === 0);
land('pr-25.txt', 'PR #25, squash-merged on GitHub');
const stale = await cardDetail(db, cardA, repo.name, null, repo);
note('rail after merge, before sync tick', `${stale.worktree.baseBranch} · ${stale.worktree.behind} behind`);
await syncMergedPullRequests(db);
const after = await cardDetail(db, cardA, repo.name, null, repo);
note('rail after one merge-sync tick', `${after.worktree.baseBranch} · ${after.worktree.behind} behind`);
check('behind is non-zero after one sync tick', (after.worktree.behind ?? 0) > 0);
check('local main unchanged after sync', g('rev-parse', 'main') === localMain);

// --- 5. The handoff's git log lists only this card's commits ---------------
const own1 = commit(wtA, 'work-1.txt', 'card A: first piece');
const own2 = commit(wtA, 'work-2.txt', 'card A: second piece');
const handoff = writeHandoff(db, getCard(db, a.id)!, repo, wtA);
const text = readFileSync(handoff.path, 'utf8');
const m = /`git log ([^`]+)`/.exec(text);
note('handoff git log line', m?.[0]);
const range = m ? run(wtA, 'log', '--format=%H', ...m[1]!.split(' ')).split('\n').filter(Boolean) : [];
note('commits it lists', range.map((s) => s.slice(0, 8)).join(' '));
check('handoff lists exactly the card commits', range.length === 2 && range.includes(own1) && range.includes(own2));
const naive = run(wtA, 'log', '--format=%H', 'main..HEAD').split('\n').filter(Boolean);
note('(old `git log main..HEAD` would list)', `${naive.length} commits`);

// After Resolve conflicts has merged the base in: the base's commits must not
// show up as the card's. The merge commit itself is the card's own.
run(wtA, 'merge', '--no-edit', '-q', 'origin/main');
const mergeSha = run(wtA, 'rev-parse', 'HEAD');
const own3 = commit(wtA, 'work-3.txt', 'card A: after the merge');
const text2 = readFileSync(writeHandoff(db, getCard(db, a.id)!, repo, wtA).path, 'utf8');
const m2 = /`git log ([^`]+)`/.exec(text2);
note('handoff git log line, after a base merge', m2?.[0]);
// Run exactly what the handoff tells Claude to run.
const listed = m2 ? run(wtA, 'log', '--format=%H %s', ...m2[1]!.split(' ')).split('\n').filter(Boolean) : [];
for (const l of listed) note('  lists', l.slice(0, 60));
const listedShas = listed.map((l) => l.split(' ')[0]);
check('after a merge, lists only the card commits (+ its merge)',
  listedShas.length === 4 && [own1, own2, own3, mergeSha].every((s) => listedShas.includes(s)));

// --- 3. Remote unreachable: fall back to the local branch, with a note -----
g('remote', 'set-url', 'origin', join(root, 'nowhere.git'));
const b = createCard(db, { title: 'Card while offline', repoId: repo.id, stage: 'in_progress' });
const madeB = await ensureWorktree(db, writer, b, repo);
const cardB = getCard(db, b.id)!;
check('worktree created while origin unreachable', !madeB.reused && ok(madeB.path, 'rev-parse', 'HEAD'));
check('offline baseSha == local main', cardB.baseSha === localMain);
const notes = cardEventsFor(db, b.id).filter((e) => e.kind === 'note');
const noteBody = notes[0]?.body ?? '';
note('offline note', noteBody.split('\n')[0]);
check('one note says the local base was used, and why', notes.length === 1 && /local main/.test(noteBody) && /fetching origin\/main failed/.test(noteBody));
const detailB = await cardDetail(db, cardB, repo.name, null, repo);
check('note shows in the card detail events', detailB.events.some((e) => e.kind === 'note' && /local main/.test(e.body ?? '')));
check('local main unchanged after offline start', g('rev-parse', 'main') === localMain);
check('local main still has its unpushed commit', g('rev-parse', 'main') === unpushed);

note('scratch', root);
