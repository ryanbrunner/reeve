/**
 * Throwaway check on the rule that Testing and Done need a card implemented
 * first: a forward move there is refused until the card has a finished In
 * Progress run, and nothing else is — not a reorder, not a move backwards.
 *
 * Run it against a scratch database, since the VIBES MODE case at the end
 * sweeps whatever board it is given:
 *
 *   REEVE_DB=/tmp/implemented.db npx tsx packages/server/src/spikes/implemented-check.ts
 *
 * Most cards here have no repo, so entering a column starts nothing and opens
 * no pull request, and what is checked is the answer the route gives. The
 * approval cases need the repo the review route insists on.
 */
import { isImplementationRun, type ApiCard, type ApiRunSummary, type BoardResponse } from '@reeve/shared';
import { createApp } from '../index.js';
import {
  cardEventsFor,
  createCard,
  createRepo,
  getCard,
  insertRun,
  setRunStatus,
  updateSettings,
} from '../db/queries.js';
import { vibesSweep } from '../vibes/engine.js';

const { app, db, writer } = createApp();

const repo = createRepo(db, {
  name: `implemented-check-${Date.now()}`,
  repoPath: '/tmp/x', worktreeRoot: '/tmp/x', defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null,
});

const succeeded = (cardId: string, stage: 'in_progress' | 'testing', task: string | null = null) => {
  const run = insertRun(db, {
    id: crypto.randomUUID(), cardId, kind: 'claude', stage, status: 'running', cwd: '/tmp/x', task,
  });
  setRunStatus(db, run.id, { status: 'succeeded' });
  return run;
};

const send = (method: string, path: string, body?: unknown) =>
  app.fetch(new Request(`http://127.0.0.1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));

const move = (id: string, stage: string, index = 0) => send('POST', `/api/cards/${id}/move`, { stage, index });
const stageOf = (id: string) => getCard(db, id)!.stage;
const onBoard = async (id: string) =>
  ((await (await send('GET', '/api/board')).json()) as BoardResponse).cards.find((c) => c.id === id);

// --- forward, unimplemented ----------------------------------------------
const fresh = createCard(db, { title: 'fresh' });
const toTesting = await move(fresh.id, 'testing');
const refusedBody = (await toTesting.json()) as { error?: string; detail?: string };
const toDone = await move(fresh.id, 'done');
const planning = createCard(db, { title: 'planning', stage: 'planning' });
const planningToDone = await move(planning.id, 'done');
const toPlanning = await move(fresh.id, 'planning');

const createdInTesting = await send('POST', '/api/cards', { title: 'born in testing', stage: 'testing' });
const createdInDone = await send('POST', '/api/cards', { title: 'born in done', stage: 'done' });
const createdInBacklog = await send('POST', '/api/cards', { title: 'born in backlog', stage: 'backlog' });

// --- already there, from before the rule --------------------------------
// Put there directly, the way a card from before this change got there.
const legacyA = createCard(db, { title: 'legacy a', stage: 'testing' });
createCard(db, { title: 'legacy b', stage: 'testing' });
const reorder = await move(legacyA.id, 'testing', 1);
const legacyDone = createCard(db, { title: 'legacy done', stage: 'done' });
const doneToTesting = await move(legacyDone.id, 'testing');
const testingToDone = await move(legacyDone.id, 'done');
const testingToBacklog = await move(legacyA.id, 'backlog');

// --- only the stage's own run counts -------------------------------------
const suggested = createCard(db, { title: 'suggested' });
succeeded(suggested.id, 'in_progress', 'suggest_criteria');
const suggestedToTesting = await move(suggested.id, 'testing');

// --- implemented ---------------------------------------------------------
const built = createCard(db, { title: 'built' });
const unbuiltOnBoard = await onBoard(built.id);
succeeded(built.id, 'in_progress');
const builtOnBoard = await onBoard(built.id);
const builtToTesting = await move(built.id, 'testing');
const builtRuns = (await (await send('GET', `/api/cards/${built.id}/runs`)).json()) as ApiRunSummary[];
const moved = (await builtToTesting.clone().json()) as ApiCard;

// --- approval ------------------------------------------------------------
// A Testing card with a Testing run to review but nothing built under it.
const unbuiltTesting = createCard(db, { title: 'unbuilt testing', repoId: repo.id, stage: 'testing' });
succeeded(unbuiltTesting.id, 'testing');
const approveUnbuilt = await send('POST', `/api/cards/${unbuiltTesting.id}/review`, { decision: 'approved' });
const approveUnbuiltBody = (await approveUnbuilt.json()) as { error?: string; detail?: string };
const afterApprove = stageOf(unbuiltTesting.id);

const builtTesting = createCard(db, { title: 'built testing', repoId: repo.id, stage: 'testing' });
succeeded(builtTesting.id, 'in_progress');
succeeded(builtTesting.id, 'testing');
const approveBuilt = await send('POST', `/api/cards/${builtTesting.id}/review`, { decision: 'approved' });

// --- VIBES MODE ----------------------------------------------------------
// The same unbuilt card still reads as waiting for review. With nobody
// watching, the sweep must leave it for a person rather than push it to Done.
updateSettings(db, { vibes: true });
await vibesSweep(db, writer);
updateSettings(db, { vibes: false });
const vibesReviews = cardEventsFor(db, unbuiltTesting.id).filter((e) => e.kind === 'reviewed');

const checks: Array<[string, boolean, string]> = [
  ['backlog -> testing refused', toTesting.status === 409, `HTTP ${toTesting.status}`],
  ['...with a reason', refusedBody.error === 'not implemented' && Boolean(refusedBody.detail), JSON.stringify(refusedBody)],
  ['backlog -> done refused', toDone.status === 409, `HTTP ${toDone.status}`],
  ['planning -> done refused', planningToDone.status === 409, `HTTP ${planningToDone.status}`],
  ['...and the cards stay put', stageOf(planning.id) === 'planning', stageOf(planning.id)],
  ['backlog -> planning still allowed', toPlanning.status === 200, `HTTP ${toPlanning.status}`],
  ['created in testing refused', createdInTesting.status === 409, `HTTP ${createdInTesting.status}`],
  ['created in done refused', createdInDone.status === 409, `HTTP ${createdInDone.status}`],
  ['created in backlog allowed', createdInBacklog.status === 201, `HTTP ${createdInBacklog.status}`],
  ['reorder within testing allowed', reorder.status === 200, `HTTP ${reorder.status}`],
  ['done -> testing allowed', doneToTesting.status === 200, `HTTP ${doneToTesting.status}`],
  ['testing -> done refused', testingToDone.status === 409, `HTTP ${testingToDone.status}`],
  ['testing -> backlog allowed', testingToBacklog.status === 200, `HTTP ${testingToBacklog.status}`],
  ['a Suggest run does not count', suggestedToTesting.status === 409, `HTTP ${suggestedToTesting.status}`],
  ['board says unimplemented before', unbuiltOnBoard?.implemented === false, String(unbuiltOnBoard?.implemented)],
  ['board says implemented after', builtOnBoard?.implemented === true, String(builtOnBoard?.implemented)],
  ['implemented card -> testing allowed', builtToTesting.status === 200 && moved.stage === 'testing', `HTTP ${builtToTesting.status} ${moved.stage}`],
  ['query agrees with the shared predicate', moved.implemented === builtRuns.some(isImplementationRun), JSON.stringify(builtRuns.map((r) => [r.stage, r.status, r.task]))],
  ['approving unbuilt testing refused', approveUnbuilt.status === 409 && approveUnbuiltBody.error === 'not implemented', `HTTP ${approveUnbuilt.status} ${JSON.stringify(approveUnbuiltBody)}`],
  ['...and it stays in testing', afterApprove === 'testing', afterApprove],
  ['approving built testing moves it to done', approveBuilt.status === 200 && stageOf(builtTesting.id) === 'done', `HTTP ${approveBuilt.status} ${stageOf(builtTesting.id)}`],
  ['VIBES leaves the unbuilt card in testing', stageOf(unbuiltTesting.id) === 'testing', stageOf(unbuiltTesting.id)],
  ['...without approving it', vibesReviews.length === 0, `${vibesReviews.length} reviewed events`],
];

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (${detail})`);
}
console.log(failed === 0 ? '\nnothing reaches testing or done unbuilt' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
