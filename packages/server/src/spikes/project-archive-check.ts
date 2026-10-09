/**
 * Checks archiving and restoring a project without spending API credit: the
 * refusals, what happens to its Release and open cards, and which cards restoring
 * it brings back. Tasks are made straight into their columns with
 * `createCard`, because the route refuses Testing and Release without a build and
 * would start a run in Planning or In Progress.
 *
 *   REEVE_DB=/tmp/reeve-project-archive.db npx tsx packages/server/src/spikes/project-archive-check.ts
 */
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import type { ApiCard, ArchiveCardResponse, BoardResponse } from '@reeve/shared';
import { createApp } from '../index.js';
import { card } from '../db/schema.js';
import {
  archiveCard,
  cardEventsFor,
  createCard,
  createRepo,
  getCard,
  listRepos,
  mergedCardsDueForArchive,
} from '../db/queries.js';
import { runRegistry } from '../runs/registry.js';

const { app, db } = createApp();

const name = `check-archive-${Date.now()}`;
const repo =
  listRepos(db).find((r) => r.name === name) ??
  createRepo(db, {
    name, repoPath: `/tmp/${name}`, worktreeRoot: `/tmp/${name}-worktrees`, defaultBranch: 'main',
    setupCommand: null, testCommand: null, serverCommand: null,
    teardownCommand: null, finishCommand: null, laneColor: '#6b7db3',
  });

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

const project = (await call<ApiCard>('POST', '/api/cards', { title: 'Checkout redesign', kind: 'project', repoId: repo.id })).json;
const task = (title: string, stage: 'backlog' | 'planning' | 'in_progress' | 'testing' | 'release') =>
  createCard(db, { title, repoId: repo.id, projectId: project.id, stage });
const backlog = task('Backlog task', 'backlog');
const planning = task('Planning task', 'planning');
const building = task('In Progress task', 'in_progress');
const testing = task('Testing task', 'testing');
const done = task('Release task', 'release');
const retired = task('Retired task', 'release');
archiveCard(db, retired.id);
const retiredBefore = getCard(db, retired.id)!;
const retiredEvents = cardEventsFor(db, retired.id).length;
const open = [backlog, planning, building, testing];

// Merged long ago, so restoring it later puts it in reach of the merge sweep.
db.update(card).set({ mergedAt: new Date(0) }).where(eq(card.id, done.id)).run();

const untouched = () => {
  assert.equal(getCard(db, project.id)?.archivedAt, null);
  assert.equal(getCard(db, done.id)?.archivedAt, null);
  for (const t of open) assert.equal(getCard(db, t.id)?.projectId, project.id, `${t.title} kept its project`);
};

// Open cards, and nobody has said to move them: refused, naming them.
const refused = await call<{ error: string; detail: string }>('POST', `/api/cards/${project.id}/archive`);
assert.equal(refused.status, 409);
assert.equal(refused.json.error, 'project has open cards');
assert.match(refused.json.detail, /^4 cards are not in Release/);
assert.ok(refused.json.detail.includes(`#${backlog.number} Backlog task`), refused.json.detail);
assert.ok(refused.json.detail.includes('and 1 more'), refused.json.detail);
untouched();
console.log(`[reeve] refused: ${refused.json.detail}`);

// A Release card with something running would carry on out of sight.
runRegistry.register({ runId: 'check-run', kind: 'server', cardId: done.id, stop: async () => {} });
const running = await call<{ error: string }>('POST', `/api/cards/${project.id}/archive`, { detachOpen: true });
runRegistry.unregister('check-run');
assert.equal(running.status, 409);
assert.equal(running.json.error, 'card is running');
untouched();

// A bad body is the caller's mistake, not a silent archive.
assert.equal((await call('POST', `/api/cards/${project.id}/archive`, { detachOpen: 'yes' })).status, 400);
untouched();

// An open card with a run stays on the board, so it does not hold the project up.
runRegistry.register({ runId: 'check-open-run', kind: 'claude', cardId: building.id, stop: async () => {} });
const archived = await call<ArchiveCardResponse>('POST', `/api/cards/${project.id}/archive`, { detachOpen: true });
runRegistry.unregister('check-open-run');
assert.equal(archived.status, 200);
assert.deepEqual(archived.json, { ok: true, archived: 1, detached: 4 });

assert.ok(getCard(db, project.id)?.archivedAt);
const doneAfter = getCard(db, done.id)!;
assert.ok(doneAfter.archivedAt, 'the Release card went with it');
assert.equal(doneAfter.projectId, project.id, 'and still belongs to it');
assert.deepEqual(cardEventsFor(db, done.id).find((e) => e.kind === 'archived')?.meta, { reason: 'project', projectId: project.id });

for (const t of open) {
  const after = getCard(db, t.id)!;
  assert.equal(after.archivedAt, null, `${t.title} stays on the board`);
  assert.equal(after.projectId, null, `${t.title} is under No project`);
  assert.equal(after.stage, t.stage, `${t.title} kept its column`);
  const left = cardEventsFor(db, t.id).find((e) => e.kind === 'left_project');
  assert.deepEqual(left?.meta, { projectId: project.id, projectTitle: 'Checkout redesign' });
}

// Archived before the project, and left exactly as it was.
assert.deepEqual(getCard(db, retired.id), retiredBefore);
assert.equal(cardEventsFor(db, retired.id).length, retiredEvents);

let board = (await call<BoardResponse>('GET', '/api/board')).json;
assert.ok(!board.projects.some((p) => p.id === project.id), 'the lane is gone');
assert.ok(!board.cards.some((c) => c.id === done.id), 'the Release card is off the board');
for (const t of open) assert.equal(board.cards.find((c) => c.id === t.id)?.projectId, null);

const archive = (await call<ApiCard[]>('GET', '/api/cards/archived')).json;
assert.ok(archive.some((c) => c.id === project.id && c.kind === 'project'));
assert.ok(archive.some((c) => c.id === done.id && c.projectId === project.id));

// Archiving it again is not an error, and does nothing.
assert.deepEqual((await call('POST', `/api/cards/${project.id}/archive`)).json, { ok: true });

// Restoring brings back the project and the Release card that went with it, and
// nothing else: not the card archived on its own, not the cards moved out.
const restored = await call<ApiCard>('POST', `/api/cards/${project.id}/restore`);
assert.equal(restored.status, 200);
assert.equal(restored.json.id, project.id);
assert.equal(restored.json.archivedAt, null);
assert.equal(getCard(db, done.id)?.archivedAt, null, 'the Release card is back');
assert.equal(getCard(db, done.id)?.stage, 'release');
assert.ok(getCard(db, retired.id)?.archivedAt, 'the card archived on its own is not');
for (const t of open) assert.equal(getCard(db, t.id)?.projectId, null, `${t.title} stays under No project`);

board = (await call<BoardResponse>('GET', '/api/board')).json;
assert.equal(board.projects.find((p) => p.id === project.id)?.taskCount, 1);
assert.equal(board.cards.find((c) => c.id === done.id)?.projectId, project.id);

// The risk the plan named: the restored card never had a `merged` archive, so
// the next sweep takes it off again. Shown rather than hidden.
const due = mergedCardsDueForArchive(db, new Date()).some((c) => c.id === done.id);
assert.ok(due);
console.log('[reeve] note: a merged Release card restored with its project is due for the merge sweep again');

// A project with nothing open archives with no confirmation.
const quiet = (await call<ApiCard>('POST', '/api/cards', { title: 'Search v2', kind: 'project', repoId: repo.id })).json;
const quietDone = createCard(db, { title: 'Quiet done', repoId: repo.id, projectId: quiet.id, stage: 'release' });
const quietArchived = await call<ArchiveCardResponse>('POST', `/api/cards/${quiet.id}/archive`);
assert.equal(quietArchived.status, 200);
assert.deepEqual(quietArchived.json, { ok: true, archived: 1, detached: 0 });
assert.ok(getCard(db, quietDone.id)?.archivedAt);

// A task archives as it always did.
const loose = createCard(db, { title: 'Loose', repoId: repo.id, stage: 'backlog' });
assert.deepEqual((await call('POST', `/api/cards/${loose.id}/archive`)).json, { ok: true });

console.log('[reeve] project archive check passed');
