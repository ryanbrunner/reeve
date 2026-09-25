/**
 * Checks projects end to end without spending API credit: numbering, the
 * board's lanes, moving a card between them, the guards that keep a project
 * out of the columns, and what a split's output turns into. The split itself
 * is fed canned output rather than run.
 *
 *   REEVE_DB=/tmp/reeve-projects.db npx tsx packages/server/src/spikes/project-check.ts
 */
import assert from 'node:assert/strict';
import type { ApiCard, BoardResponse } from '@reeve/shared';
import { createApp } from '../index.js';
import { cardEventsFor, createRepo, criteriaFor, getCard, listRepos, runsForCard, tasksInProject } from '../db/queries.js';
import { splitProjectTask } from '../stages/split_project.js';
import type { StageContext } from '../stages/types.js';

const { app, db } = createApp();

const repo = (name: string) =>
  listRepos(db).find((r) => r.name === name) ??
  createRepo(db, {
    name, repoPath: `/tmp/${name}`, worktreeRoot: `/tmp/${name}-worktrees`, defaultBranch: 'main',
    setupCommand: null, testCommand: null, serverCommand: null,
    teardownCommand: null, finishCommand: null, laneColor: '#6b7db3', maxBudgetUsd: null,
  });
const web = repo(`check-web-${Date.now()}`);
const api = repo(`check-api-${Date.now()}`);

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

// A project takes no number, so the repo's sequence carries on past it.
const first = (await call<ApiCard>('POST', '/api/cards', { title: 'first', repoId: web.id })).json;
const project = (await call<ApiCard>('POST', '/api/cards', { title: 'Project', kind: 'project', repoId: web.id })).json;
const second = (await call<ApiCard>('POST', '/api/cards', { title: 'second', repoId: web.id, projectId: project.id })).json;
assert.equal(project.number, 0);
assert.equal(second.number, first.number + 1);
assert.equal(second.projectId, project.id);

// Changing a project's repo does not spend a number either.
await call('PATCH', `/api/cards/${project.id}`, { repoId: api.id });
assert.equal(getCard(db, project.id)?.number, 0);

// Projects do not nest, and a task cannot go under something that is not one.
assert.equal((await call('POST', '/api/cards', { title: 'x', kind: 'project', projectId: project.id })).status, 400);
assert.equal((await call('POST', '/api/cards', { title: 'x', projectId: first.id })).status, 400);

// The board: the project is a lane, never a card.
let board = (await call<BoardResponse>('GET', '/api/board')).json;
assert.ok(board.projects.some((p) => p.id === project.id && p.taskCount === 1));
assert.ok(!board.cards.some((c) => c.id === project.id));

// Into the project's lane, and back out again.
await call('POST', `/api/cards/${first.id}/move`, { stage: 'backlog', index: 0, projectId: project.id });
assert.equal(getCard(db, first.id)?.projectId, project.id);
await call('POST', `/api/cards/${first.id}/move`, { stage: 'backlog', index: 0, projectId: null });
assert.equal(getCard(db, first.id)?.projectId, null);
// Absent leaves it where it is.
await call('POST', `/api/cards/${second.id}/move`, { stage: 'backlog', index: 0 });
assert.equal(getCard(db, second.id)?.projectId, project.id);
// A project is not moved, and not moved into.
assert.equal((await call('POST', `/api/cards/${project.id}/move`, { stage: 'planning', index: 0 })).status, 400);
assert.equal((await call('POST', `/api/cards/${first.id}/move`, { stage: 'backlog', index: 0, projectId: second.id })).status, 400);

// A project with no repo saves its brief, and refuses the split with a reason.
const bare = (await call<ApiCard>('POST', '/api/cards', { title: 'Bare', kind: 'project', repoId: null })).json;
assert.equal((await call('PATCH', `/api/cards/${bare.id}`, { body: 'Do a thing' })).status, 200);
assert.equal(runsForCard(db, bare.id).length, 0);
const refused = await call<{ error: string }>('POST', `/api/cards/${bare.id}/split`);
assert.equal(refused.status, 400);
assert.equal(refused.json.error, 'project has no repo');

// What a split's output becomes: cards under the project, in the named repo or
// the project's own, made by Claude, with their criteria — and nothing twice.
const stored = getCard(db, project.id)!;
const ctx = { card: stored, repo: api, worktreePath: api.repoPath } as StageContext;
splitProjectTask.onPersist!(db, ctx, {
  tasks: [
    { title: 'Web task', body: 'b', repo: web.name, criteria: ['one', 'two'] },
    { title: 'Default task', body: 'b', repo: null, criteria: [] },
    { title: 'Unknown repo task', body: 'b', repo: 'nope', criteria: [] },
    { title: 'SECOND', body: 'b', repo: null, criteria: [] },
  ],
}, 'run');
const made = tasksInProject(db, project.id);
const named = (t: string) => made.find((c) => c.title === t)!;
assert.equal(made.length, 4, 'three new, and "second" already there');
assert.equal(named('Web task').repoId, web.id);
assert.equal(named('Default task').repoId, api.id);
assert.equal(named('Unknown repo task').repoId, api.id);
assert.deepEqual(criteriaFor(db, named('Web task').id).map((c) => [c.text, c.source]), [['one', 'claude'], ['two', 'claude']]);
assert.equal(cardEventsFor(db, named('Web task').id).find((e) => e.kind === 'created')?.actor, 'claude');
assert.equal(named('Web task').stage, 'backlog');

board = (await call<BoardResponse>('GET', '/api/board')).json;
assert.equal(board.projects.find((p) => p.id === project.id)?.taskCount, 4);

console.log('[reeve] projects check passed');
