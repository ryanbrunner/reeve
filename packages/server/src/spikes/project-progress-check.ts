/**
 * Checks the count behind a lane's progress bar without spending API credit:
 * `archivedDoneCount` counts a project's tasks archived from Done and nothing
 * else, and `taskCount` still counts only live ones. Tasks are made straight
 * into their columns with `createCard`, as in project-archive-check.ts.
 *
 *   REEVE_DB=/tmp/reeve-progress.db npx tsx packages/server/src/spikes/project-progress-check.ts
 */
import assert from 'node:assert/strict';
import type { ApiCard, ApiProject, BoardResponse, Stage } from '@reeve/shared';
import { createApp } from '../index.js';
import { archiveCard, createCard, createRepo, listRepos, moveCard } from '../db/queries.js';

const { app, db } = createApp();

const name = `check-progress-${Date.now()}`;
const repo =
  listRepos(db).find((r) => r.name === name) ??
  createRepo(db, {
    name, repoPath: `/tmp/${name}`, worktreeRoot: `/tmp/${name}-worktrees`, defaultBranch: 'main',
    setupCommand: null, testCommand: null, serverCommand: null,
    teardownCommand: null, finishCommand: null, laneColor: '#6b7db3',
  });

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(res.ok, `${method} ${path} answered ${res.status}`);
  return (await res.json()) as T;
}

async function lane(id: string): Promise<ApiProject> {
  const board = await call<BoardResponse>('GET', '/api/board');
  const found = board.projects.find((p) => p.id === id);
  assert.ok(found, `project ${id} is on the board`);
  return found;
}

const project = await call<ApiCard>('POST', '/api/cards', { title: 'Saved for later', kind: 'project', repoId: repo.id });
const other = await call<ApiCard>('POST', '/api/cards', { title: 'Faster checkout', kind: 'project', repoId: repo.id });
const task = (title: string, stage: Stage, projectId = project.id) =>
  createCard(db, { title, repoId: repo.id, projectId, stage });

// Nothing archived yet: a number, not a missing join's null.
let saved = await lane(project.id);
assert.equal(saved.taskCount, 0);
assert.equal(saved.archivedDoneCount, 0);

const backlog = task('Backlog task', 'backlog');
const planning = task('Planning task', 'planning');
task('Done and still on the board', 'done');
const finished = task('Done and swept', 'done');
const dropped = task('Dropped from Backlog', 'backlog');

// A live Done task is the board's to count, not this one's.
saved = await lane(project.id);
assert.equal(saved.taskCount, 5);
assert.equal(saved.archivedDoneCount, 0);

// Archived from Done: finished, so it still counts, and leaves `taskCount`.
archiveCard(db, finished.id);
saved = await lane(project.id);
assert.equal(saved.archivedDoneCount, 1);
assert.equal(saved.taskCount, 4);

// Archived from any other column: dropped on purpose, counted nowhere.
archiveCard(db, dropped.id);
saved = await lane(project.id);
assert.equal(saved.archivedDoneCount, 1);
assert.equal(saved.taskCount, 3);

// Another project's archived Done task is not this one's.
archiveCard(db, task('Finished elsewhere', 'done', other.id).id);
assert.equal((await lane(project.id)).archivedDoneCount, 1);
assert.equal((await lane(other.id)).archivedDoneCount, 1);

// A task dragged to another lane leaves this project's bar and joins that one's.
moveCard(db, planning.id, 'planning', 0, 'human', other.id);
saved = await lane(project.id);
assert.equal(saved.taskCount, 2);
const board = await call<BoardResponse>('GET', '/api/board');
assert.equal(board.projects.find((p) => p.id === other.id)?.taskCount, 1);
assert.deepEqual(
  board.cards.filter((c) => c.projectId === project.id).map((c) => c.stage).sort(),
  ['backlog', 'done'],
);
assert.equal(board.cards.find((c) => c.id === backlog.id)?.projectId, project.id);
assert.equal(board.cards.find((c) => c.id === planning.id)?.projectId, other.id);

console.log(
  `[reeve] ${saved.title}: ${saved.taskCount} live, ${saved.archivedDoneCount} archived from Done — so the bar reads 2/3`,
);
console.log('[reeve] project progress check passed');
