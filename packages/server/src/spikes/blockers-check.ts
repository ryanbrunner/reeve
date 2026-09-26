/**
 * Throwaway check on the rule the board exists for: a card does not start, or
 * move on, until what it depends on has cleared — reached Done with its pull
 * request merged, or with none. The drag, approval, the Run button and VIBES
 * MODE should all refuse the same card, only ever let it go back to Backlog,
 * and let it go on the moment its dependency clears.
 *
 * Run it against a scratch database, and a fresh one each time — the VIBES MODE
 * half sweeps every card on the board it is given:
 *
 *   REEVE_DB=/tmp/reeve-blockers.db npx tsx packages/server/src/spikes/blockers-check.ts
 *
 * No worktree and no GitHub here, so the stages the cards are let into fail at
 * the worktree, as in `vibes-check.ts`. What is being checked is whether they
 * are let in at all. The one case it cannot reach is a dependency whose pull
 * request is still being opened, which needs a real push: `pr-check.ts` has the
 * worktree for that.
 */
import { eq } from 'drizzle-orm';
import type { ApiCard } from '@reeve/shared';
import { createApp } from '../index.js';
import {
  addDependency,
  archiveCard,
  cardEventsFor,
  createCard,
  createRepo,
  getCard,
  insertRun,
  moveCard,
  reviewsForCard,
  runsForCard,
  setRunStatus,
  updateSettings,
} from '../db/queries.js';
import { card as cardTable } from '../db/schema.js';
import { vibesSweep } from '../vibes/engine.js';
import { startStage } from '../startStage.js';

const { app, db, writer } = createApp();

const repo = createRepo(db, {
  name: `dependency-check-${Date.now()}`,
  repoPath: '/tmp/x', worktreeRoot: '/tmp/x', defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null,
});

async function post(path: string, body: unknown) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { error?: string; detail?: string } };
}
const move = (id: string, stage: string, index = 0) => post(`/api/cards/${id}/move`, { stage, index });
const approve = (id: string) => post(`/api/cards/${id}/review`, { decision: 'approved' });
const boardCard = async (id: string) => (await (await app.request(`/api/cards/${id}`)).json()) as ApiCard;
const setPr = (id: string, prUrl: string | null, mergedAt: Date | null) =>
  db.update(cardTable).set({ prUrl, mergedAt }).where(eq(cardTable.id, id)).run();

// A plan waiting for review, so Approve has something to approve.
function succeededPlan(cardId: string) {
  const run = insertRun(db, {
    id: crypto.randomUUID(), cardId, kind: 'claude',
    stage: 'planning', status: 'running', cwd: '/tmp/x',
  });
  setRunStatus(db, run.id, { status: 'succeeded' });
}

// Already in In Progress, so the sweep has nothing to move it on to. No repo,
// so the sweep passes it over altogether: in Done with a pull request it would
// otherwise try to land it, and there is no GitHub here to ask.
const dep = createCard(db, { title: 'Lay the foundations', repoId: null, stage: 'in_progress' });
const waiter = createCard(db, { title: 'Build on them', repoId: repo.id, stage: 'backlog' });
addDependency(db, waiter.id, dep.id);
const blockedBy = `#${dep.number} Lay the foundations (In Progress)`;

// --- the drag -------------------------------------------------------------
const dragged = await move(waiter.id, 'planning');
const draggedStage = getCard(db, waiter.id)!.stage;
const reorder = await move(waiter.id, 'backlog', 0);

// --- a card already past Backlog ------------------------------------------
// Given a dependency after it left. It keeps its column, but can only go back
// to Backlog: forwards and backwards past it are both refused.
const planned = createCard(db, { title: 'Planned early', repoId: repo.id, stage: 'planning' });
addDependency(db, planned.id, dep.id);
succeededPlan(planned.id);
const plannedForward = await Promise.all(['in_progress', 'testing', 'done'].map((s) => move(planned.id, s)));
const plannedReorder = await move(planned.id, 'planning', 0);
const approved = await approve(planned.id);
const afterApprove = getCard(db, planned.id)!.stage;
const approveReviews = reviewsForCard(db, planned.id).length;

const tester = createCard(db, { title: 'Tested early', repoId: repo.id, stage: 'testing' });
addDependency(db, tester.id, dep.id);
const testerBack = await Promise.all(['planning', 'in_progress'].map((s) => move(tester.id, s)));
const testerToBacklog = await move(tester.id, 'backlog');
const testerStage = getCard(db, tester.id)!.stage;

// --- the Run button ---------------------------------------------------------
// A card that left Backlog before its dependency was added keeps its column,
// but may not run there until the dependency is done.
const latecomer = createCard(db, { title: 'Got in early', repoId: repo.id, stage: 'in_progress' });
addDependency(db, latecomer.id, dep.id);
const run = await startStage(db, writer, latecomer, repo);

// --- an archived dependency -----------------------------------------------
// Taken off the board on purpose, so nothing waits on it any more — with a
// pull request that never merged, too.
const dropped = createCard(db, { title: 'Dropped idea', repoId: repo.id, stage: 'testing' });
const orphan = createCard(db, { title: 'Was waiting on it', repoId: repo.id, stage: 'backlog' });
addDependency(db, orphan.id, dropped.id);
const beforeArchive = await move(orphan.id, 'planning');
archiveCard(db, dropped.id);
const afterArchive = await move(orphan.id, 'planning');

const abandoned = createCard(db, { title: 'Abandoned PR', repoId: null, stage: 'done' });
setPr(abandoned.id, 'https://example.invalid/pull/1', null);
const orphanOfPr = createCard(db, { title: 'Was waiting on that', repoId: repo.id, stage: 'backlog' });
addDependency(db, orphanOfPr.id, abandoned.id);
const beforePrArchive = await move(orphanOfPr.id, 'planning');
archiveCard(db, abandoned.id);
const afterPrArchive = await move(orphanOfPr.id, 'planning');

// --- a dependency in Done with no pull request -------------------------------
const noPr = createCard(db, { title: 'Nothing to push', repoId: null, stage: 'done' });
const afterNoPr = createCard(db, { title: 'Follows it', repoId: repo.id, stage: 'backlog' });
addDependency(db, afterNoPr.id, noPr.id);
const noPrMove = await move(afterNoPr.id, 'planning');

// --- VIBES MODE -------------------------------------------------------------
// A Planning card with no plan in flight, which the sweep moves on without one.
const idlePlanner = createCard(db, { title: 'Never planned', repoId: repo.id, stage: 'planning' });
addDependency(db, idlePlanner.id, dep.id);

updateSettings(db, { vibes: true });
await vibesSweep(db, writer);
await vibesSweep(db, writer);
const vibesStage = getCard(db, waiter.id)!.stage;
const vibesPlanned = getCard(db, planned.id)!.stage;
const vibesIdlePlanner = getCard(db, idlePlanner.id)!.stage;
const latecomerRuns = runsForCard(db, latecomer.id).length;
const latecomerStage = getCard(db, latecomer.id)!.stage;

// In Done with its pull request open: still in the way.
moveCard(db, dep.id, 'done', 0);
setPr(dep.id, 'https://example.invalid/pull/2', null);
await vibesSweep(db, writer);
const openPrStage = getCard(db, waiter.id)!.stage;
const openPrPlanned = getCard(db, planned.id)!.stage;
const openPrLink = (await boardCard(waiter.id)).dependsOn[0];
const openPrStart = await startStage(db, writer, getCard(db, latecomer.id)!, repo);
const openPrMove = await move(idlePlanner.id, 'in_progress');

// Merged: the next sweep lets everything go.
setPr(dep.id, 'https://example.invalid/pull/2', new Date());
const mergedLink = (await boardCard(waiter.id)).dependsOn[0];
await vibesSweep(db, writer);
const releasedStage = getCard(db, waiter.id)!.stage;
const releasedBy = cardEventsFor(db, waiter.id).filter((e) => e.kind === 'moved').map((e) => e.actor);
const releasedPlanned = getCard(db, planned.id)!.stage;
const releasedIdlePlanner = getCard(db, idlePlanner.id)!.stage;
const unblockedRun = await startStage(db, writer, getCard(db, latecomer.id)!, repo);
updateSettings(db, { vibes: false });

const ok = (label: string, got: unknown, want: unknown) =>
  console.log(`${JSON.stringify(got) === JSON.stringify(want) ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}`);

console.log('\n--- the drag ---');
ok('leaving Backlog is refused with a 409', dragged.status, 409);
ok('naming the blocking card', dragged.json.detail, blockedBy);
ok('and the card stays in Backlog', draggedStage, 'backlog');
ok('a reorder within Backlog is still allowed', reorder.status, 200);

console.log('\n--- a card already past Backlog ---');
ok('Planning → In Progress, Testing and Done are refused', plannedForward.map((r) => r.status), [409, 409, 409]);
ok('for the dependency, not for being unbuilt', plannedForward.map((r) => r.json.error),
  Array(3).fill('waiting on unfinished cards'));
ok('a reorder within Planning is allowed', plannedReorder.status, 200);
ok('approving it is refused with a 409', approved.status, 409);
ok('naming the blocking card', approved.json.detail, blockedBy);
ok('leaving it in Planning', afterApprove, 'planning');
ok('with no approval recorded', approveReviews, 0);
ok('Testing → Planning and In Progress are refused too', testerBack.map((r) => r.status), [409, 409]);
ok('but Testing → Backlog is allowed', testerToBacklog.status, 200);
ok('and it lands there', testerStage, 'backlog');

console.log('\n--- the Run button ---');
ok('startStage refuses a card whose dependency is not done', run.ok ? 'started' : run.status, 409);
ok('naming the blocking card', run.ok ? null : run.detail, blockedBy);

console.log('\n--- an archived dependency ---');
ok('blocks while it is on the board', beforeArchive.status, 409);
ok('and stops blocking once archived', afterArchive.status, 200);
ok('one with an unmerged pull request blocks too', beforePrArchive.status, 409);
ok('labelled as waiting on the merge', beforePrArchive.json.detail, `#${abandoned.number} Abandoned PR (Done, PR not merged)`);
ok('and also stops once archived', afterPrArchive.status, 200);

console.log('\n--- a dependency in Done with no pull request ---');
ok('does not block', noPrMove.status, 200);

console.log('\n--- VIBES MODE ---');
ok('the sweep leaves a blocked card in Backlog', vibesStage, 'backlog');
ok('does not approve a blocked card waiting for review', vibesPlanned, 'planning');
ok('nor move on a blocked Planning card with no plan', vibesIdlePlanner, 'planning');
ok('and does not run the one already past Backlog', latecomerRuns, 0);
ok('which keeps its column', latecomerStage, 'in_progress');

console.log('\n--- a dependency in Done with its pull request open ---');
ok('the sweep still leaves the card in Backlog', openPrStage, 'backlog');
ok('and still does not approve the Planning card', openPrPlanned, 'planning');
ok('the chip reads it as not done', openPrLink?.done, false);
ok('and as waiting on the merge', openPrLink?.awaitingMerge, true);
ok('the move route still refuses', openPrMove.status, 409);
ok('saying the pull request has not merged', openPrMove.json.detail,
  `#${dep.number} Lay the foundations (Done, PR not merged)`);
ok('and startStage still refuses', openPrStart.ok ? 'started' : openPrStart.status, 409);

console.log('\n--- once it merges ---');
ok('the chip reads it as done', mergedLink?.done, true);
ok('no longer waiting on anything', mergedLink?.awaitingMerge, false);
ok('the next sweep moves the Backlog card', releasedStage, 'in_progress');
ok('in one move, recorded as Claude', releasedBy, ['claude']);
ok('approves the Planning card on', releasedPlanned, 'in_progress');
ok('and moves on the one with no plan', releasedIdlePlanner, 'in_progress');
// Refused for another reason now — there is no repo at /tmp/x to make a
// worktree in — and that is the point: it got past the dependency.
ok('and the card past Backlog is no longer refused for it', unblockedRun.ok ? null : unblockedRun.error, 'could not create the worktree');

process.exit(0);
