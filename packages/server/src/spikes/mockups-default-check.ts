/**
 * Checks that a new card starts with Generate mockups off, however it is made:
 * from the board, straight through `createCard`, or by splitting a project.
 * The column's own default is still true (see schema.ts), so each of these
 * would read true again if `createCard` stopped writing the value. The split is
 * fed canned output rather than run.
 *
 *   REEVE_DB=/tmp/reeve-mockups-default.db npx tsx packages/server/src/spikes/mockups-default-check.ts
 */
import assert from 'node:assert/strict';
import type { ApiCard } from '@reeve/shared';
import { createApp } from '../index.js';
import { createCard, createRepo, getCard, tasksInProject } from '../db/queries.js';
import { splitProjectTask } from '../stages/split_project.js';
import type { StageContext } from '../stages/types.js';

const { app, db } = createApp();

const name = `check-mockups-${Date.now()}`;
const repo = createRepo(db, {
  name, repoPath: `/tmp/${name}`, worktreeRoot: `/tmp/${name}-worktrees`, defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: '#6b7db3', maxBudgetUsd: null,
});

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

// From the board, which leaves the field out.
const plain = (await call<ApiCard>('POST', '/api/cards', { title: 'plain', repoId: repo.id })).json;
assert.equal(plain.generateMockups, false);
assert.equal(getCard(db, plain.id)?.generateMockups, false);

// Asking for it still gets it.
const asked = (await call<ApiCard>('POST', '/api/cards', { title: 'asked', repoId: repo.id, generateMockups: true })).json;
assert.equal(asked.generateMockups, true);

// The Brief's checkbox, both ways.
assert.equal((await call('PATCH', `/api/cards/${plain.id}`, { generateMockups: true })).status, 200);
assert.equal(getCard(db, plain.id)?.generateMockups, true);
assert.equal((await call('PATCH', `/api/cards/${plain.id}`, { generateMockups: false })).status, 200);
assert.equal(getCard(db, plain.id)?.generateMockups, false);

// Straight through the query, as the seed and the other spikes do.
assert.equal(createCard(db, { title: 'direct', repoId: repo.id }).generateMockups, false);

// Tasks made by splitting a project.
const project = (await call<ApiCard>('POST', '/api/cards', { title: 'Project', kind: 'project', repoId: repo.id })).json;
const ctx = { card: getCard(db, project.id)!, repo, worktreePath: repo.repoPath } as StageContext;
splitProjectTask.onPersist!(db, ctx, {
  tasks: [
    // `dependsOn` since the split began proposing links between its tasks.
    { title: 'One', body: 'b', repo: null, criteria: [], dependsOn: [] },
    { title: 'Two', body: 'b', repo: null, criteria: [], dependsOn: [] },
  ],
}, 'run');
const made = tasksInProject(db, project.id);
assert.equal(made.length, 2);
assert.ok(made.every((c) => !c.generateMockups), 'split tasks start with mockups off');

console.log('[reeve] mockups default check passed');
