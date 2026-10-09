/**
 * The clean-up that removes a merged card's worktree once it is archived,
 * against a real git repo and a throwaway database. The sweep is called
 * directly rather than waited for; the hand archive goes through the route,
 * the same as a click.
 *
 *   REEVE_DB=/tmp/scratch.db npx tsx packages/server/src/spikes/worktree-cleanup-check.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { ApiDiff } from '@reeve/shared';
import { createApp } from '../index.js';
import { archiveCard, cardEventsFor, createCard, createRepo, getCard, restoreCard, runsForCard } from '../db/queries.js';
import { card as cardTable } from '../db/schema.js';
import { listWorktrees, realOrSelf } from '../git/worktree.js';
import { cleanUpArchivedWorktrees } from '../pullRequest.js';
import { runRegistry } from '../runs/registry.js';
import { ensureWorktree } from '../startStage.js';

const note = (l: string, v: unknown) => console.log(`${l.padEnd(44)}: ${v}`);
const check = (l: string, ok: boolean) => {
  note(l, ok ? 'ok' : 'FAILED');
  if (!ok) process.exitCode = 1;
};

const { app, db, writer } = createApp();

const root = mkdtempSync(join(tmpdir(), 'reeve-cleanup-'));
const repoPath = join(root, 'repo');
mkdirSync(repoPath);
const g = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t.t', '-c', 'user.name=T', ...a], { encoding: 'utf8' }).trim();
g(repoPath, 'init', '-q', '-b', 'main');
writeFileSync(join(repoPath, 'README.md'), '# base\n');
g(repoPath, 'add', 'README.md');
g(repoPath, 'commit', '-qm', 'base');

// Writes outside the tree, so it can be read after the tree has gone.
const teardownLog = join(root, 'teardown.log');
const teardownCommand = `echo "$PWD" >> '${teardownLog}'`;
const repo = createRepo(db, {
  name: `cleanup-check-${Date.now()}`, repoPath, worktreeRoot: join(root, 'worktrees'), defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand, finishCommand: null, laneColor: null,
});

/** A Release card with a real worktree, one commit on its branch, and Reeve's own `.reeve/` beside it. */
async function card(title: string, opts: { merged?: boolean; archived?: boolean; dirty?: boolean } = {}) {
  const c = createCard(db, { title, repoId: repo.id, stage: 'release' });
  const { path } = await ensureWorktree(db, writer, c, repo);
  writeFileSync(join(path, `${c.number}.txt`), `${title}\n`);
  g(path, 'add', `${c.number}.txt`);
  g(path, 'commit', '-qm', title);
  mkdirSync(join(path, '.reeve'), { recursive: true });
  writeFileSync(join(path, '.reeve', 'plan.md'), '# plan\n');
  if (opts.dirty) writeFileSync(join(path, 'README.md'), '# base\n\nedited after the merge\n');
  if (opts.merged) db.update(cardTable).set({ mergedAt: new Date() }).where(eq(cardTable.id, c.id)).run();
  if (opts.archived) archiveCard(db, c.id);
  return { id: c.id, path, branch: getCard(db, c.id)!.branchName! };
}

const listed = async (path: string) =>
  (await listWorktrees(repoPath)).some((w) => realOrSelf(w.path) === realOrSelf(path));
const branchExists = (branch: string) => g(repoPath, 'branch', '--list', branch) !== '';
const removals = (id: string) => cardEventsFor(db, id).filter((e) => e.kind === 'worktree_removed');
const gone = async (c: { id: string; path: string }) =>
  getCard(db, c.id)!.worktreePath === null && !existsSync(c.path) && !(await listed(c.path));
const kept = async (c: { id: string; path: string }) =>
  getCard(db, c.id)!.worktreePath === c.path && existsSync(c.path) && (await listed(c.path));

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

const clean = await card('Merged and archived', { merged: true, archived: true });
const dirty = await card('Merged and archived, edited since', { merged: true, archived: true, dirty: true });
const live = await card('Merged, still on the board', { merged: true });
const unmerged = await card('Archived, never merged', { archived: true });
const busy = await card('Merged and archived, still running', { merged: true, archived: true });
runRegistry.register({ runId: 'fake-run', kind: 'shell', cardId: busy.id, stop: async () => {} });

await cleanUpArchivedWorktrees(db, writer);

check('merged and archived: worktree removed', await gone(clean));
check('its branch is kept', branchExists(clean.branch));
const cleanEvent = removals(clean.id)[0];
check('one worktree_removed event, reason archived', removals(clean.id).length === 1 && cleanEvent?.meta?.['reason'] === 'archived');
check('.reeve/ alone does not count as forced', cleanEvent?.meta?.['forced'] === false);
check('teardown ran as a shell run on the card', runsForCard(db, clean.id).some(
  (r) => r.kind === 'shell' && r.command === teardownCommand && r.status === 'succeeded'));
// By name: the tree is gone, so nothing can resolve /var to macOS's /private/var.
check('teardown ran inside the worktree', existsSync(teardownLog) &&
  readFileSync(teardownLog, 'utf8').split('\n').some((l) => l.endsWith(`/${basename(clean.path)}`)));

check('dirty: worktree removed anyway', await gone(dirty));
check('and its event says forced', removals(dirty.id)[0]?.meta?.['forced'] === true);

check('merged but still on the board: kept', await kept(live));
check('archived but never merged: kept', await kept(unmerged));
check('a card with a run is left for later', await kept(busy));
runRegistry.unregister('fake-run');
await cleanUpArchivedWorktrees(db, writer);
check('run gone, the next pass removes it', await gone(busy));

const diff = (await call<ApiDiff>('GET', `/api/cards/${clean.id}/diff`)).json;
const cleanNumber = getCard(db, clean.id)!.number;
check('/diff still lists the committed file', diff.files.some((f) => f.path === `${cleanNumber}.txt`) && diff.additions === 1);
const commits = (await call<Array<{ sha: string; subject: string }>>('GET', `/api/cards/${clean.id}/commits`)).json;
check('/commits still lists the commit', commits.length === 1 && commits[0]?.subject === 'Merged and archived');
const dirtyDiff = (await call<ApiDiff>('GET', `/api/cards/${dirty.id}/diff`)).json;
check('a forced card\'s diff is only what was committed', !dirtyDiff.files.some((f) => f.path === 'README.md'));

// Restored, a cleaned-up card cannot have a worktree made again: its branch
// is still there, and git would refuse. Nor can it be moved to another repo.
restoreCard(db, clean.id);
db.update(cardTable).set({ stage: 'in_progress' }).where(eq(cardTable.id, clean.id)).run();
const remake = await call<{ error: string; detail: string }>('POST', `/api/cards/${clean.id}/worktree`);
note('asking for a worktree again', `${remake.status} ${remake.json.error}: ${remake.json.detail}`);
check('refused with a 409 and a sentence', remake.status === 409 && remake.json.detail.length > 0);
const run = await call<{ error: string }>('POST', `/api/cards/${clean.id}/run`);
note('starting its stage', `${run.status} ${run.json.error}`);
check('starting its stage is refused the same way', run.status === 409 && run.json.error === 'already merged');
const refile = await call<{ error: string }>('PATCH', `/api/cards/${clean.id}`, { repoId: null });
check('moving it to another repo is refused', refile.status === 400);
db.update(cardTable).set({ stage: 'release' }).where(eq(cardTable.id, clean.id)).run();
archiveCard(db, clean.id);
await cleanUpArchivedWorktrees(db, writer);
check('archived again, nothing more happens', removals(clean.id).length === 1);

// By hand, through the route, the way the board archives a card.
const archived = await call<{ ok: boolean }>('POST', `/api/cards/${live.id}/archive`);
check('hand archive answers at once', archived.status === 200);
for (let i = 0; i < 100 && getCard(db, live.id)!.worktreePath !== null; i++) await new Promise((r) => setTimeout(r, 100));
check('hand archive removes the worktree within seconds', await gone(live));
check('and keeps the branch', branchExists(live.branch));

const byHand = await card('Removed by hand');
const removed = await call<{ ok: boolean; forced: boolean }>('DELETE', `/api/cards/${byHand.id}/worktree`);
check('DELETE /worktree still removes it', removed.status === 200 && await gone(byHand));
check('and now leaves an event, reason by_hand', removals(byHand.id)[0]?.meta?.['reason'] === 'by_hand');

rmSync(root, { recursive: true, force: true });
console.log(process.exitCode ? '\nSOME WORKTREE CLEAN-UP BEHAVIOURS FAILED' : '\nall worktree clean-up behaviours verified');
process.exit();
