/**
 * Checks suggested tasks end to end without spending API credit: each stage's
 * `onPersist` handed fake output, and what that leaves behind — the cards, the
 * column, repo and project they land in, the dedupe across reruns, the cap,
 * both ends of the link on the board and the detail, that no route can set or
 * change it, that output stored before the contract changed still parses, and
 * that board-wide VIBES MODE sweeps a suggested card on like any other.
 *
 *   REEVE_DB=/tmp/reeve-suggest.db npx tsx packages/server/src/spikes/suggestion-check.ts
 *
 * With no REEVE_DB it makes its own under /tmp rather than opening
 * data/reeve.db. The VIBES MODE half moves every Backlog card on the board it
 * is given, which is one more reason not to point it at a real one.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  implementationOutput,
  planningOutput,
  testingOutput,
  type ApiCard,
  type BoardResponse,
  type CardDetail,
} from '@reeve/shared';

const scratch = mkdtempSync(join(tmpdir(), 'reeve-suggest-'));
// Before anything reads config, which fixes the database path at import.
process.env.REEVE_DB ??= join(scratch, 'app.db');

const { config } = await import('../config.js');
const { createApp } = await import('../index.js');
const {
  cardEventsFor,
  cardsSuggestedBy,
  createCard,
  createRepo,
  getCard,
  getSettings,
  insertRun,
  archiveCard,
  updateSettings,
} = await import('../db/queries.js');
const { planningStage } = await import('../stages/planning.js');
const { inProgressStage } = await import('../stages/in_progress.js');
const { testingStage } = await import('../stages/testing.js');
const { stageContextFor } = await import('../runs/claude.js');
const { vibesSweep } = await import('../vibes/engine.js');

// --- the migration's place in the journal ----------------------------------
type Journal = { entries: Array<{ tag: string; when: number }> };
const journal = JSON.parse(readFileSync(join(config.migrationsFolder, 'meta/_journal.json'), 'utf8')) as Journal;
const at = journal.entries.findIndex((e) => e.tag === '0021_card_suggested_by');
assert.notEqual(at, -1, 'card_suggested_by is in the journal');
assert.ok(journal.entries.slice(0, at).every((e) => e.when < journal.entries[at]!.when), 'the entry would be skipped');

const { app, db, writer } = createApp();
const repo = createRepo(db, {
  name: `suggest-check-${Date.now()}`,
  repoPath: '/tmp/suggest-check', worktreeRoot: '/tmp/suggest-check-worktrees', defaultBranch: 'main',
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
const board = async () => (await call<BoardResponse>('GET', '/api/board')).json;
const onBoard = async (id: string) => (await board()).cards.find((c) => c.id === id);
const detail = async (id: string) => (await call<CardDetail>('GET', `/api/cards/${id}/detail`)).json;

/** The context a stage's hooks get, for a card made the way the board makes one. */
const ctxFor = (id: string) => stageContextFor(db, { card: getCard(db, id)!, repo, worktreePath: '/tmp/suggest-check' });
const runFor = (cardId: string, stage: 'planning' | 'in_progress' | 'testing') =>
  insertRun(db, { id: crypto.randomUUID(), cardId, kind: 'claude', stage, status: 'succeeded', cwd: '/tmp/x' }).id;
const tasks = (...titles: string[]) => titles.map((title) => ({ title, body: `Noticed while checking: ${title}.` }));

const PLAN = {
  summary: 's', risk: 'low', files_to_touch: [], details: [], steps: [],
  open_questions: [], acceptance_criteria: [], captures: [],
};
const IMPL = { summary: 's', commits: [], files_changed: [], deviations_from_plan: [] };
const TESTS = { passed: true, summary: 's', failures: [], fixes_applied: [], criteria: [], differences: [] };

// --- stored output from before the change still parses ----------------------
// The Plan and Changes tabs and Testing all read old runs back through these.
assert.deepEqual(planningOutput.parse(PLAN).suggested_tasks, []);
assert.deepEqual(testingOutput.parse(TESTS).suggested_tasks, []);
const old = implementationOutput.parse({ ...IMPL, follow_ups: ['e2e tests for guest persistence'] });
assert.deepEqual(old.suggested_tasks, []);
assert.ok(!('follow_ups' in old), 'follow_ups is dropped, not carried');
console.log('[reeve] output stored before suggested_tasks still parses');

// --- Planning ---------------------------------------------------------------
const project = createCard(db, { title: 'Suggest check project', kind: 'project', repoId: repo.id });
const suggester = (await call<ApiCard>('POST', '/api/cards', {
  title: 'Suggester', repoId: repo.id, projectId: project.id,
})).json;
planningStage.onPersist!(
  db, ctxFor(suggester.id),
  planningOutput.parse({ ...PLAN, suggested_tasks: tasks('Index the cart query', 'Rename cart_items.qty') }),
  runFor(suggester.id, 'planning'),
);
let made = cardsSuggestedBy(db, suggester.id);
assert.deepEqual(made.map((c) => c.title), ['Index the cart query', 'Rename cart_items.qty']);
for (const c of made) {
  assert.equal(c.stage, 'backlog');
  assert.equal(c.repoId, repo.id);
  assert.equal(c.projectId, project.id, 'under the suggester’s project');
  assert.equal(c.kind, 'task');
  assert.equal(c.vibes, false, 'the suggester’s own flag is not inherited');
  assert.deepEqual(cardEventsFor(db, c.id).map((e) => [e.kind, e.actor]), [['created', 'claude']]);
}
console.log('[reeve] Planning: two suggestions, two Backlog cards in the same repo and project');

// Run again, as after a rejection: a title already made, in another case, is
// skipped, and only the new one lands.
planningStage.onPersist!(
  db, ctxFor(suggester.id),
  planningOutput.parse({ ...PLAN, suggested_tasks: tasks('index the CART query ', 'Drop the legacy wishlist table') }),
  runFor(suggester.id, 'planning'),
);
made = cardsSuggestedBy(db, suggester.id);
assert.equal(made.length, 3, 'a rerun adds only what is new');

// One archived is still one it made, and is not made again.
const archived = made.find((c) => c.title === 'Rename cart_items.qty')!;
archiveCard(db, archived.id);
planningStage.onPersist!(
  db, ctxFor(suggester.id),
  planningOutput.parse({ ...PLAN, suggested_tasks: tasks('Rename cart_items.qty') }),
  runFor(suggester.id, 'planning'),
);
assert.equal(cardsSuggestedBy(db, suggester.id).length, 3, 'an archived suggestion is not remade');
console.log('[reeve] a rerun skips titles already suggested, archived ones included');

// --- In Progress: the cap ---------------------------------------------------
const builder = (await call<ApiCard>('POST', '/api/cards', { title: 'Builder', repoId: repo.id })).json;
inProgressStage.onPersist!(
  db, ctxFor(builder.id),
  implementationOutput.parse({ ...IMPL, suggested_tasks: tasks('One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven') }),
  runFor(builder.id, 'in_progress'),
);
const capped = cardsSuggestedBy(db, builder.id);
assert.deepEqual(capped.map((c) => c.title), ['One', 'Two', 'Three', 'Four', 'Five'], 'five a run, in the order given');
assert.ok(capped.every((c) => c.projectId === null), 'no project, as its suggester has none');
console.log('[reeve] In Progress: seven suggestions, five cards');

// --- Testing ----------------------------------------------------------------
const tester = (await call<ApiCard>('POST', '/api/cards', { title: 'Tester', repoId: repo.id })).json;
testingStage.onPersist!(
  db, ctxFor(tester.id),
  testingOutput.parse({ ...TESTS, suggested_tasks: tasks('Fix the flaky tax rounding test') }),
  runFor(tester.id, 'testing'),
);
assert.deepEqual(cardsSuggestedBy(db, tester.id).map((c) => c.stage), ['backlog']);
console.log('[reeve] Testing: one suggestion, one card');

// --- both ends, on the board and the detail --------------------------------
const index = made.find((c) => c.title === 'Index the cart query')!;
const top = (await onBoard(suggester.id))!;
assert.equal(top.suggestedBy, null);
// Live ones only: the archived suggestion is not on the board to light up.
assert.deepEqual(new Set(top.suggestions), new Set(made.filter((c) => c.id !== archived.id).map((c) => c.id)));
const child = (await onBoard(index.id))!;
assert.deepEqual(
  child.suggestedBy && [child.suggestedBy.id, child.suggestedBy.number, child.suggestedBy.title],
  [suggester.id, suggester.number, 'Suggester'],
);
assert.deepEqual(child.suggestions, []);

const d = await detail(suggester.id);
assert.equal(d.suggestions.suggestedBy, null);
assert.equal(d.suggestions.suggested.length, 3, 'the detail keeps the archived one');
assert.ok(d.suggestions.suggested.find((c) => c.id === archived.id)?.archivedAt, 'and says it is archived');
assert.equal((await detail(index.id)).suggestions.suggestedBy?.id, suggester.id);

// The suggester archived too, as a merged card is: still named from its child.
archiveCard(db, suggester.id);
assert.equal((await onBoard(index.id))!.suggestedBy?.title, 'Suggester');
console.log('[reeve] both ends read back on the board and the detail, archived suggester included');

// --- nobody can set it by hand ---------------------------------------------
const patched = await call<ApiCard>('PATCH', `/api/cards/${index.id}`, { suggestedById: builder.id, title: 'Index it' });
assert.equal(patched.status, 200);
assert.equal(getCard(db, index.id)!.suggestedById, suggester.id, 'PATCH ignores suggestedById');
assert.equal(patched.json.suggestedBy?.id, suggester.id);
const cleared = await call<ApiCard>('PATCH', `/api/cards/${index.id}`, { suggestedById: null });
assert.equal(cleared.status, 200);
assert.equal(getCard(db, index.id)!.suggestedById, suggester.id, 'nor can it clear one');
const posted = await call<ApiCard>('POST', '/api/cards', { title: 'Sneaky', repoId: repo.id, suggestedById: builder.id });
assert.equal(posted.status, 201);
assert.equal(getCard(db, posted.json.id)!.suggestedById, null, 'POST ignores it too');
assert.equal(posted.json.suggestedBy, null);
console.log('[reeve] no route sets or changes who suggested a card');

// --- the suggest-tasks switch ------------------------------------------------
assert.equal(getSettings(db).suggestTasks, true, 'a fresh database suggests follow-up cards by default');

updateSettings(db, { suggestTasks: false });
const quiet = (await call<ApiCard>('POST', '/api/cards', { title: 'Quiet', repoId: repo.id })).json;
planningStage.onPersist!(
  db, ctxFor(quiet.id),
  planningOutput.parse({ ...PLAN, suggested_tasks: tasks('Should not land') }),
  runFor(quiet.id, 'planning'),
);
inProgressStage.onPersist!(
  db, ctxFor(quiet.id),
  implementationOutput.parse({ ...IMPL, suggested_tasks: tasks('Should not land either') }),
  runFor(quiet.id, 'in_progress'),
);
testingStage.onPersist!(
  db, ctxFor(quiet.id),
  testingOutput.parse({ ...TESTS, suggested_tasks: tasks('Nor this') }),
  runFor(quiet.id, 'testing'),
);
assert.equal(cardsSuggestedBy(db, quiet.id).length, 0, 'suggestions off: no stage makes a card');
console.log('[reeve] suggestions off: Planning, In Progress and Testing make no cards');

// The prompt built for each stage, with the switch off, leaves out the aside
// and tells Claude to leave suggested_tasks empty.
const quietCtx = ctxFor(quiet.id);
assert.equal(quietCtx.suggestTasks, false, 'stageContextFor reads the switch off the settings row');
for (const prompt of [
  planningStage.buildPrompt(quietCtx, {}),
  inProgressStage.buildPrompt(quietCtx, {}),
  testingStage.buildPrompt(quietCtx, {}),
]) {
  assert.ok(!prompt.includes('Things you notice along the way'), 'the aside section is left out');
  assert.ok(prompt.includes('Leave `suggested_tasks`'), 'Claude is told to leave it empty');
}
console.log('[reeve] suggestions off: no built prompt carries the aside section');

// What the switch was on for stays: it only stops new ones.
assert.ok(cardsSuggestedBy(db, suggester.id).length > 0, 'cards suggested while it was on are left alone');
updateSettings(db, { suggestTasks: true });
console.log('[reeve] suggestions off only stops new ones; earlier suggestions keep their Accept / Reject buttons');

// --- board-wide VIBES MODE takes a suggested card like any other -------------
// No worktree here, so the stage it starts fails at the worktree. What is being
// checked is that the sweep picked the card up and moved it on.
const swept = capped[0]!;
updateSettings(db, { vibes: true });
await vibesSweep(db, writer);
updateSettings(db, { vibes: false });
const after = getCard(db, swept.id)!;
assert.equal(after.stage, 'in_progress', 'the sweep moved the suggested card out of Backlog');
assert.deepEqual(
  cardEventsFor(db, swept.id).filter((e) => e.kind === 'moved').map((e) => [e.toStage, e.actor]),
  [['in_progress', 'claude']],
);
console.log('[reeve] board-wide VIBES MODE sweeps a suggested card on from Backlog');

console.log('[reeve] suggestion-check passed');
process.exit(0);
