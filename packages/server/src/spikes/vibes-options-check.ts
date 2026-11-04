/**
 * Throwaway check on Settings' VIBES MODE options: does the sweep plan when
 * Planning is kept, step over Testing when it is skipped, and leave a pull
 * request alone when merging is off?
 *
 * Run it against a scratch database, as vibes-check.ts is —
 * `REEVE_DB=/tmp/vibes-options.db npx tsx packages/server/src/spikes/vibes-options-check.ts`
 * — because the sweep moves every card on the board it is given.
 *
 * No worktree and no GitHub here, so the runs the sweep starts fail their way
 * out at the worktree and `gh` refuses the made-up pull request. What is
 * checked is the part above that: which column each card is sent to, and
 * whether a merge was even attempted.
 *
 * Exits 1 if any check fails.
 */
import { createApp } from '../index.js';
import {
  boardCards,
  cardEventsFor,
  createCard,
  createRepo,
  getCard,
  getSettings,
  insertRun,
  runsForCard,
  setRunStatus,
  updateCard,
  updateSettings,
} from '../db/queries.js';
import { vibesSweep } from '../vibes/engine.js';

const { db, writer } = createApp();

const already = boardCards(db).length;
if (already > 0) {
  console.error(`vibes-options-check wants an empty board and this one has ${already} cards. Give it a fresh REEVE_DB.`);
  process.exit(1);
}

const repo = createRepo(db, {
  name: `vibes-options-check-${Date.now()}`,
  repoPath: '/tmp/x', worktreeRoot: '/tmp/x', defaultBranch: 'main',
  setupCommand: null, testCommand: null, focusedTestCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null,
});

const succeeded = (cardId: string, stage: 'planning' | 'in_progress' | 'testing' | 'release', output: unknown = {}) => {
  const run = insertRun(db, {
    id: crypto.randomUUID(), cardId, kind: 'claude', stage, status: 'running', cwd: '/tmp/x',
  });
  setRunStatus(db, run.id, { status: 'succeeded', structuredOutput: output, totalCostUsd: 0.25 });
  return run;
};

let failures = 0;
const check = (label: string, ok: boolean, got: unknown) => {
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}`);
  if (!ok) failures++;
};

// --- the defaults ----------------------------------------------------------
const defaults = getSettings(db).vibesOptions;
check('a board with no settings row skips Planning, runs Testing and merges', JSON.stringify(defaults) === JSON.stringify({ skipPlanning: true, skipTesting: false, autoMerge: true }), defaults);

// Cards flagged on their own, so the board's switch (and its ideas) stays out of it.
const flagged = (title: string, stage: 'backlog' | 'planning' | 'in_progress' | 'testing' | 'release') => {
  const c = createCard(db, { title, repoId: repo.id, stage, vibes: true });
  return c;
};
check('createCard takes the vibes flag', flagged('flag probe', 'backlog').vibes === true, true);
updateCard(db, boardCards(db)[0]!.card.id, { vibes: false });

// --- Planning kept ---------------------------------------------------------
console.log('\n--- Planning kept ---');
updateSettings(db, { vibesOptions: { skipPlanning: false } });
const kept = getSettings(db).vibesOptions;
check('saving one option leaves the others as they were', kept.skipPlanning === false && kept.skipTesting === false && kept.autoMerge === true, kept);
const toPlan = flagged('to plan', 'backlog');
await vibesSweep(db, writer);
check('a backlog card goes to Planning, not over it', getCard(db, toPlan.id)!.stage === 'planning', getCard(db, toPlan.id)!.stage);
const idlePlan = flagged('idle plan', 'planning');
await vibesSweep(db, writer);
await new Promise((r) => setTimeout(r, 1500));
const planRuns = runsForCard(db, idlePlan.id).filter((r) => r.stage === 'planning').length;
check('an idle Planning card is started there rather than moved on', getCard(db, idlePlan.id)!.stage === 'planning', { stage: getCard(db, idlePlan.id)!.stage, planRuns, events: cardEventsFor(db, idlePlan.id).map((e) => e.kind) });

// --- Testing skipped -------------------------------------------------------
console.log('\n--- Testing skipped ---');
updateSettings(db, { vibesOptions: { skipPlanning: true, skipTesting: true } });
const built = flagged('built', 'in_progress');
succeeded(built.id, 'in_progress');
// A branch and a tree on record, or arriving in Release has nothing to push
// and tries nothing. Neither exists, so the attempt is refused on the record.
db.$client.prepare("UPDATE card SET branch_name = 'reeve/built', worktree_path = '/tmp/x/nowhere', base_sha = 'abc' WHERE id = ?").run(built.id);
await vibesSweep(db, writer);
// The pull request is opened in the background; give the refusal time to land.
await new Promise((r) => setTimeout(r, 3000));
const builtEvents = cardEventsFor(db, built.id);
check('approved In Progress goes straight to Release', getCard(db, built.id)!.stage === 'release', getCard(db, built.id)!.stage);
check('and the review says it went to Release', builtEvents.some((e) => e.kind === 'moved' && e.toStage === 'release' && e.fromStage === 'in_progress'), builtEvents.filter((e) => e.kind === 'moved').map((e) => `${e.fromStage}→${e.toStage}`));
check('and entering Release tried to open its pull request', builtEvents.some((e) => e.kind === 'pr_failed' || e.kind === 'pr_opened'), builtEvents.map((e) => e.kind));

const sittingInTesting = flagged('sitting in testing', 'testing');
succeeded(sittingInTesting.id, 'in_progress');
await vibesSweep(db, writer);
check('a built card idle in Testing is moved on to Release', getCard(db, sittingInTesting.id)!.stage === 'release', getCard(db, sittingInTesting.id)!.stage);

const neverBuilt = flagged('never built', 'testing');
await vibesSweep(db, writer);
check('one that was never built stays for a person', getCard(db, neverBuilt.id)!.stage === 'testing', getCard(db, neverBuilt.id)!.stage);

const fromBacklog = flagged('from backlog', 'backlog');
await vibesSweep(db, writer);
check('Backlog still goes over Planning to In Progress', getCard(db, fromBacklog.id)!.stage === 'in_progress', getCard(db, fromBacklog.id)!.stage);

// --- merging ---------------------------------------------------------------
// A Release card with a pull request on record and its conversation done.
// `gh` cannot merge a made-up URL, so an attempt shows as `merge_failed`.
console.log('\n--- merging ---');
const releasing = (title: string) => {
  const c = flagged(title, 'release');
  db.$client.prepare('UPDATE card SET pr_url = ? WHERE id = ?').run(`https://github.com/example/nothing/pull/${c.number}`, c.id);
  succeeded(c.id, 'release');
  return c;
};
updateSettings(db, { vibesOptions: { autoMerge: false } });
const held = releasing('held');
await vibesSweep(db, writer);
const heldKinds = cardEventsFor(db, held.id).map((e) => e.kind);
check('with merging off, no merge is attempted', !heldKinds.includes('merge_failed') && !heldKinds.includes('merged'), heldKinds);

updateSettings(db, { vibesOptions: { autoMerge: true } });
const landed = releasing('landed');
await vibesSweep(db, writer);
const landedKinds = cardEventsFor(db, landed.id).map((e) => e.kind);
check('with merging on, it is', landedKinds.includes('merge_failed') || landedKinds.includes('merged'), landedKinds);

console.log(failures ? `\n${failures} check(s) failed` : '\nall VIBES MODE option checks pass');
process.exit(failures ? 1 : 0);
