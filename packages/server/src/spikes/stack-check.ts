/**
 * Throwaway check on stacked branches (stacks.ts), with no API credit and no
 * GitHub: a real repo with a bare one as its origin, a parent card built on a
 * branch, and a card waiting on it.
 *
 * - the waiting card may start, but not go to Release while the parent has
 *   no pull request
 * - its worktree is cut from the parent's branch, and its diff is its own work
 * - a revision of the parent is merged in at the next stage start
 * - the parent squash-merges on origin, and the merge sync's restack moves the
 *   card onto main: it merges cleanly, its base moves, and its diff is still
 *   only its own
 * - merging a stacked card is refused, and so is a push to the parent's branch
 *
 *   REEVE_DB=/tmp/stack.db npx tsx packages/server/src/spikes/stack-check.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { blockedMove } from '../blockers.js';
import { config } from '../config.js';
import { addDependency, createCard, createRepo, getCard, insertRun, cardEventsFor, removeDependency } from '../db/queries.js';
import { card as cardTable } from '../db/schema.js';
import { diffSince } from '../git/worktree.js';
import { createApp } from '../index.js';
import { canMergePr, landPullRequest } from '../pullRequest.js';
import { mergeRefusal } from '../runs/permissions.js';
import { baseBranchFor, protectedBranches, restackChildren, stackedOn } from '../stacks.js';
import { ensureWorktree, mergeLatestBase } from '../startStage.js';

if (!process.env.REEVE_DB) throw new Error('give this a scratch REEVE_DB');
for (const f of [config.dbFile, `${config.dbFile}-wal`, `${config.dbFile}-shm`]) rmSync(f, { force: true });

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const root = mkdtempSync(join(tmpdir(), 'reeve-stack-'));
const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const origin = join(root, 'origin.git');
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
const repoPath = join(root, 'repo');
execFileSync('git', ['clone', '-q', origin, repoPath]);
g(repoPath, 'config', 'user.email', 't@t.t');
g(repoPath, 'config', 'user.name', 'T');
writeFileSync(join(repoPath, 'README.md'), '# stack\n');
g(repoPath, 'add', '-A');
g(repoPath, 'commit', '-qm', 'base');
g(repoPath, 'push', '-q', 'origin', 'main');
const commit = (cwd: string, file: string, text: string) => {
  writeFileSync(join(cwd, file), text);
  g(cwd, 'add', file);
  g(cwd, '-c', 'user.email=t@t.t', '-c', 'user.name=T', 'commit', '-qm', `add ${file}`);
};
const files = async (path: string, base: string) =>
  [...(await diffSince(path, base)).matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]).sort();

const { db, writer } = createApp();
const repo = createRepo(db, { name: 'stack', repoPath, worktreeRoot: join(root, 'wt'), defaultBranch: 'main' });

// The parent, built.
const parentCard = createCard(db, { repoId: repo.id, title: 'Store carts', body: '', stage: 'in_progress' });
await ensureWorktree(db, writer, getCard(db, parentCard.id)!, repo);
let parent = getCard(db, parentCard.id)!;
commit(parent.worktreePath!, 'store.ts', 'export const store = 1;\n');
insertRun(db, {
  id: crypto.randomUUID(), cardId: parent.id, kind: 'claude', stage: 'in_progress', status: 'succeeded',
  sessionId: crypto.randomUUID(), prompt: 'p', cwd: parent.worktreePath!, startedAt: new Date(), finishedAt: new Date(),
});

// The card that waits on it.
const childCard = createCard(db, { repoId: repo.id, title: 'Cart page', body: '', stage: 'backlog' });
addDependency(db, childCard.id, parent.id);
let child = getCard(db, childCard.id)!;
check('a card waiting on a built, unmerged card may start', blockedMove(db, child, 'planning') === null, JSON.stringify(blockedMove(db, child, 'planning')));
check('but not go to Release while that card has no pull request', blockedMove(db, child, 'release')?.error === 'waiting on the pull request it builds on');

await ensureWorktree(db, writer, child, repo);
child = getCard(db, childCard.id)!;
check('its worktree is cut from the parent\'s branch', child.stackedOnId === parent.id && existsSync(join(child.worktreePath!, 'store.ts')));
check('its base is the parent\'s branch', baseBranchFor(db, child, repo) === parent.branchName, baseBranchFor(db, child, repo));
commit(child.worktreePath!, 'page.ts', 'export const page = 1;\n');
check('its diff is its own work only', JSON.stringify(await files(child.worktreePath!, child.baseSha!)) === '["page.ts"]', JSON.stringify(await files(child.worktreePath!, child.baseSha!)));
check('a run on it may not push to the parent\'s branch', mergeRefusal(`git push origin ${parent.branchName}`, protectedBranches(db, child, repo)) !== null);

// The parent is revised; the next stage start takes it in.
commit(parent.worktreePath!, 'store-fix.ts', 'export const fix = 1;\n');
const merged = await mergeLatestBase(db, child, repo, child.worktreePath!);
child = getCard(db, childCard.id)!;
check('a revision of the parent is merged in at the next stage start', merged.state === 'merged' && existsSync(join(child.worktreePath!, 'store-fix.ts')), JSON.stringify(merged));
check('and the diff is still its own work only', JSON.stringify(await files(child.worktreePath!, child.baseSha!)) === '["page.ts"]', JSON.stringify(await files(child.worktreePath!, child.baseSha!)));

// In Release with a pull request: merging it is refused while stacked.
db.update(cardTable).set({ stage: 'release', prUrl: 'https://github.com/example/stack/pull/2' }).where(eq(cardTable.id, child.id)).run();
child = getCard(db, childCard.id)!;
check('the Merge button is not offered while it is stacked', !canMergePr(db, child));
const land = await landPullRequest(db, child, repo, 'human');
check('and merging it is refused, naming what it waits on', !land.ok && land.error === 'it waits on cards that have not landed', JSON.stringify(land));

// The parent squash-merges on origin.
const other = join(root, 'merger');
execFileSync('git', ['clone', '-q', origin, other]);
g(other, 'config', 'user.email', 't@t.t');
g(other, 'config', 'user.name', 'T');
g(repoPath, 'push', '-q', 'origin', parent.branchName!);
g(other, 'fetch', '-q', 'origin', parent.branchName!);
g(other, 'merge', '--squash', `origin/${parent.branchName}`);
g(other, 'commit', '-qm', 'Store carts (#1)');
g(other, 'push', '-q', 'origin', 'main');
db.update(cardTable).set({ mergedAt: new Date(), stage: 'release' }).where(eq(cardTable.id, parent.id)).run();
parent = getCard(db, parentCard.id)!;
check('once the parent merges, the card is due to move', stackedOn(db, getCard(db, childCard.id)!) === null);

// It has a pull request, and there is no GitHub here to point it at main:
// the stack must not end with the pull request still on the parent's branch.
await restackChildren(db);
child = getCard(db, childCard.id)!;
check('a restack whose pull request cannot be retargeted leaves the card stacked', child.stackedOnId === parent.id);
check('and still unmergeable', !canMergePr(db, child));
const said = (cardId: string, pattern: RegExp) => cardEventsFor(db, cardId).some((e) => e.kind === 'note' && pattern.test(e.body ?? ''));
check('and says why', said(child.id, /stays on that card's branch for now, because pointing its pull request at main failed/));

db.update(cardTable).set({ prUrl: null }).where(eq(cardTable.id, child.id)).run();
await restackChildren(db);
child = getCard(db, childCard.id)!;
const mainTip = g(repoPath, 'rev-parse', 'origin/main');
check('the restack moves it onto main', child.stackedOnId === null && child.baseSha === mainTip, `${child.stackedOnId} ${child.baseSha?.slice(0, 7)} vs ${mainTip.slice(0, 7)}`);
check('with main merged into its branch', g(child.worktreePath!, 'merge-base', '--is-ancestor', mainTip, 'HEAD') === '');
check('and its diff is still its own work only', JSON.stringify(await files(child.worktreePath!, child.baseSha!)) === '["page.ts"]', JSON.stringify(await files(child.worktreePath!, child.baseSha!)));
check('its base is main again', baseBranchFor(db, child, repo) === 'main');
check('and the card says what happened', said(child.id, /now builds on main/));

// A card cut from main before its dependency could be built on.
const lateCard = createCard(db, { repoId: repo.id, title: 'Cart badge', body: '', stage: 'in_progress' });
await ensureWorktree(db, writer, getCard(db, lateCard.id)!, repo);
let late = getCard(db, lateCard.id)!;
const second = createCard(db, { repoId: repo.id, title: 'Cart totals', body: '', stage: 'in_progress' });
await ensureWorktree(db, writer, getCard(db, second.id)!, repo);
let p2 = getCard(db, second.id)!;
commit(p2.worktreePath!, 'totals.ts', 'export const totals = 1;\n');
insertRun(db, {
  id: crypto.randomUUID(), cardId: p2.id, kind: 'claude', stage: 'in_progress', status: 'succeeded',
  sessionId: crypto.randomUUID(), prompt: 'p', cwd: p2.worktreePath!, startedAt: new Date(), finishedAt: new Date(),
});
addDependency(db, late.id, p2.id);
late = getCard(db, lateCard.id)!;
check('a card already on main is not yet stacked on its new dependency', late.stackedOnId === null);
db.update(cardTable).set({ stage: 'release', prUrl: 'https://github.com/example/stack/pull/3' }).where(eq(cardTable.id, p2.id)).run();
check('and may not go to Release until it is', blockedMove(db, late, 'release')?.error === 'not yet built on the card it waits on', JSON.stringify(blockedMove(db, late, 'release')));
db.update(cardTable).set({ stage: 'testing', prUrl: null }).where(eq(cardTable.id, p2.id)).run();
const lateMerge = await mergeLatestBase(db, late, repo, late.worktreePath!);
late = getCard(db, lateCard.id)!;
check('its next stage start merges the dependency\'s branch in and stacks it', late.stackedOnId === p2.id && existsSync(join(late.worktreePath!, 'totals.ts')), JSON.stringify(lateMerge));

// A dependency whose branch conflicts with the card's: it is not stacked.
const clashCard = createCard(db, { repoId: repo.id, title: 'Cart footer', body: '', stage: 'in_progress' });
await ensureWorktree(db, writer, getCard(db, clashCard.id)!, repo);
let clash = getCard(db, clashCard.id)!;
commit(clash.worktreePath!, 'totals.ts', 'export const totals = 2;\n');
addDependency(db, clash.id, p2.id);
clash = getCard(db, clashCard.id)!;
const clashMerge = await mergeLatestBase(db, clash, repo, clash.worktreePath!);
clash = getCard(db, clashCard.id)!;
check('a dependency that conflicts leaves the card unstacked', clashMerge.state === 'skipped' && clash.stackedOnId === null, JSON.stringify(clashMerge));

// The link removed: the card is moved off the branch it no longer waits on.
removeDependency(db, late.id, p2.id);
check('a removed dependency ends the stack', stackedOn(db, getCard(db, lateCard.id)!) === null);
await restackChildren(db);
late = getCard(db, lateCard.id)!;
check('and the next sync moves it onto main', late.stackedOnId === null && baseBranchFor(db, late, repo) === 'main');
check('saying it no longer waits on it', said(late.id, /no longer waits on #/));

// Merging waits on any dependency, stacked or not.
const gated = createCard(db, { repoId: repo.id, title: 'Gated', body: '', stage: 'release' });
db.update(cardTable).set({ prUrl: 'https://github.com/example/stack/pull/9' }).where(eq(cardTable.id, gated.id)).run();
addDependency(db, gated.id, p2.id);
const gatedLand = await landPullRequest(db, getCard(db, gated.id)!, repo, 'human');
check('a card with an unlanded dependency may not merge, stacked or not', !gatedLand.ok && gatedLand.error === 'it waits on cards that have not landed', JSON.stringify(gatedLand));

console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
