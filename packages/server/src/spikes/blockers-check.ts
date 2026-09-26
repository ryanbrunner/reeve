/**
 * Throwaway check on the rule the board exists for: a card does not start until
 * what it depends on is done. The drag, the Run button and SICKO MODE should all
 * refuse the same card, and let it go the moment its dependency reaches Done.
 *
 * Run it against a scratch database, and a fresh one each time — the SICKO MODE
 * half sweeps every card on the board it is given:
 *
 *   REEVE_DB=/tmp/reeve-blockers.db npx tsx packages/server/src/spikes/blockers-check.ts
 *
 * No worktree and no GitHub here, so the stages the cards are let into fail at
 * the worktree, as in `sicko-check.ts`. What is being checked is whether they
 * are let in at all.
 */
import { createApp } from '../index.js';
import {
  addDependency,
  archiveCard,
  cardEventsFor,
  createCard,
  createRepo,
  getCard,
  moveCard,
  runsForCard,
  updateSettings,
} from '../db/queries.js';
import { sickoSweep } from '../sicko/engine.js';
import { startStage } from '../startStage.js';

const { app, db, writer } = createApp();

const repo = createRepo(db, {
  name: `dependency-check-${Date.now()}`,
  repoPath: '/tmp/x', worktreeRoot: '/tmp/x', defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null,
});

async function move(id: string, stage: string, index = 0) {
  const res = await app.request(`/api/cards/${id}/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stage, index }),
  });
  return { status: res.status, json: (await res.json()) as { error?: string; detail?: string } };
}

// Already in In Progress, so the sweep has nothing to move it on to. It tries
// to start it, fails at the worktree, and leaves it where it is.
const dep = createCard(db, { title: 'Lay the foundations', repoId: repo.id, stage: 'in_progress' });
const waiter = createCard(db, { title: 'Build on them', repoId: repo.id, stage: 'backlog' });
addDependency(db, waiter.id, dep.id);

// --- the drag -------------------------------------------------------------
const dragged = await move(waiter.id, 'planning');
const draggedStage = getCard(db, waiter.id)!.stage;
const reorder = await move(waiter.id, 'backlog', 0);

// --- the Run button ---------------------------------------------------------
// A card that left Backlog before its dependency was added keeps its column,
// but may not run there until the dependency is done.
const latecomer = createCard(db, { title: 'Got in early', repoId: repo.id, stage: 'in_progress' });
addDependency(db, latecomer.id, dep.id);
const run = await startStage(db, writer, latecomer, repo);

// --- an archived dependency -----------------------------------------------
// Taken off the board on purpose, so nothing waits on it any more.
const dropped = createCard(db, { title: 'Dropped idea', repoId: repo.id, stage: 'testing' });
const orphan = createCard(db, { title: 'Was waiting on it', repoId: repo.id, stage: 'backlog' });
addDependency(db, orphan.id, dropped.id);
const beforeArchive = await move(orphan.id, 'planning');
archiveCard(db, dropped.id);
const afterArchive = await move(orphan.id, 'planning');

// --- SICKO MODE -------------------------------------------------------------
updateSettings(db, { sicko: true });
await sickoSweep(db, writer);
await sickoSweep(db, writer);
const sickoStage = getCard(db, waiter.id)!.stage;
const latecomerRuns = runsForCard(db, latecomer.id).length;
const latecomerStage = getCard(db, latecomer.id)!.stage;

moveCard(db, dep.id, 'done', 0);
await sickoSweep(db, writer);
const releasedStage = getCard(db, waiter.id)!.stage;
const releasedBy = cardEventsFor(db, waiter.id).filter((e) => e.kind === 'moved').map((e) => e.actor);
const unblockedRun = await startStage(db, writer, getCard(db, latecomer.id)!, repo);
updateSettings(db, { sicko: false });

const ok = (label: string, got: unknown, want: unknown) =>
  console.log(`${JSON.stringify(got) === JSON.stringify(want) ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}`);

console.log('\n--- the drag ---');
ok('leaving Backlog is refused with a 409', dragged.status, 409);
ok('naming the blocking card', dragged.json.detail, `#${dep.number} Lay the foundations (In Progress)`);
ok('and the card stays in Backlog', draggedStage, 'backlog');
ok('a reorder within Backlog is still allowed', reorder.status, 200);

console.log('\n--- the Run button ---');
ok('startStage refuses a card whose dependency is not done', run.ok ? 'started' : run.status, 409);
ok('naming the blocking card', run.ok ? null : run.detail, `#${dep.number} Lay the foundations (In Progress)`);

console.log('\n--- an archived dependency ---');
ok('blocks while it is on the board', beforeArchive.status, 409);
ok('and stops blocking once archived', afterArchive.status, 200);

console.log('\n--- SICKO MODE ---');
ok('the sweep leaves a blocked card in Backlog', sickoStage, 'backlog');
ok('and does not run the one already past it', latecomerRuns, 0);
ok('which keeps its column', latecomerStage, 'in_progress');
ok('once the dependency is Done, the next sweep moves the card', releasedStage, 'in_progress');
ok('in one move, recorded as Claude', releasedBy, ['claude']);
// Refused for another reason now — there is no repo at /tmp/x to make a
// worktree in — and that is the point: it got past the dependency.
ok('and the card past Backlog is no longer refused for it', unblockedRun.ok ? null : unblockedRun.error, 'could not create the worktree');

process.exit(0);
