/**
 * Throwaway check on the VIBES MODE sweep: does it actually take the human out
 * of the loop, and does it say so honestly afterwards?
 *
 * Run it against a scratch database — `REEVE_DB=/tmp/vibes.db tsx
 * src/spikes/vibes-check.ts` — because the sweep is the one thing in Reeve that
 * moves real cards on a real board without being asked.
 *
 * No worktree and no GitHub here, so the runs the sweep tries to start fail
 * their way out at the worktree and the pull requests never open. What is being
 * checked is the part above that: the moving, the approving, the answering, and
 * who each of those is recorded as.
 *
 * Exits 1 if any check fails, so it can be run for its exit code alone.
 */
import { createApp } from '../index.js';
import {
  boardCards,
  cardEventsFor,
  createCard,
  createRepo,
  getCard,
  insertRun,
  questionsForRun,
  replaceQuestions,
  runsForCard,
  setRunStatus,
  updateCard,
  updateSettings,
} from '../db/queries.js';
import { PLACEHOLDER_TITLE } from '@reeve/shared';
import { vibesSweep } from '../vibes/engine.js';
import { vibesState } from '../vibes/state.js';

const { db, writer } = createApp();

// An empty board or nothing. With the switch on the sweep takes every card on
// the board, not just the ones made below, so a second run on the same database
// moves and approves the first run's leftovers and the scoreboard counts them
// ("reviews skipped" 3, "moves" 8). On `data/reeve.db`, which is what an unset
// `REEVE_DB` opens, those leftovers are somebody's real cards.
const already = boardCards(db).length;
if (already > 0) {
  console.error(`vibes-check wants an empty board and this one has ${already} cards. Give it a fresh REEVE_DB.`);
  process.exit(1);
}

const repo = createRepo(db, {
  name: `vibes-check-${Date.now()}`,
  repoPath: '/tmp/x', worktreeRoot: '/tmp/x', defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null,
});

const PLAN = {
  summary: 's', risk: 'low', files_to_touch: [], details: [], steps: [],
  open_questions: [], acceptance_criteria: [], captures: [],
};

/**
 * Two models, as a run with a subagent has, and a heap of cache reads. A run
 * counts 33,100: input, output and cache writes across both, reads left out.
 */
const USAGE = {
  'claude-opus-5-5': { inputTokens: 100, outputTokens: 2_000, cacheCreationInputTokens: 30_000, cacheReadInputTokens: 500_000 },
  'claude-haiku-4-5': { inputTokens: 900, outputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 4_000 },
};

const succeeded = (cardId: string, stage: 'planning' | 'in_progress' | 'testing') => {
  const run = insertRun(db, {
    id: crypto.randomUUID(), cardId, kind: 'claude', stage, status: 'running', cwd: '/tmp/x',
  });
  setRunStatus(db, run.id, { status: 'succeeded', structuredOutput: PLAN, totalCostUsd: 0.25, modelUsageJson: USAGE });
  return run;
};

const actorsOf = (cardId: string, kind: string) =>
  cardEventsFor(db, cardId).filter((e) => e.kind === kind).map((e) => e.actor);

// --- off ------------------------------------------------------------------
// Nothing happens while the switch is off, however ready the card looks.
const asleep = createCard(db, { title: 'asleep', repoId: repo.id, stage: 'backlog' });
// Made now, before anything else is in Planning: the questions case below
// leaves its card there with a failed run, and a later sweep would move that
// on too.
const stranded = createCard(db, { title: 'stranded', repoId: repo.id, stage: 'planning' });
await vibesSweep(db, writer);
const stayedPut = getCard(db, asleep.id)!.stage;

updateSettings(db, { vibes: true });

// --- backlog --------------------------------------------------------------
// Nobody is going to drag this, and nobody is going to plan it either.
await vibesSweep(db, writer);
const movedTo = getCard(db, asleep.id)!.stage;
const movedBy = actorsOf(asleep.id, 'moved');

// --- planning, with nothing in it -----------------------------------------
// A card already in Planning when the switch went on, with no plan started, is
// moved on without one rather than planned.
const strandedTo = getCard(db, stranded.id)!.stage;
const plansStarted = [asleep, stranded].flatMap((c) => runsForCard(db, c.id)).filter((r) => r.stage === 'planning');

// --- the card nobody has named yet ----------------------------------------
// Add makes a card called "Untitled" and opens it for the details. Planning
// that is guaranteed waste, and taking it away mid-sentence is the difference
// between the switch being fun and the switch being a trap.
const unnamed = createCard(db, { title: PLACEHOLDER_TITLE, repoId: repo.id, stage: 'backlog' });
await vibesSweep(db, writer);
const unnamedStage = getCard(db, unnamed.id)!.stage;
updateCard(db, unnamed.id, { title: 'Gift notes at checkout' });
await vibesSweep(db, writer);
const namedStage = getCard(db, unnamed.id)!.stage;

// --- the review gate ------------------------------------------------------
// A plan waiting to be read is approved without being read, and the card
// advances — the same three things the Approve button does.
const waiting = createCard(db, { title: 'waiting', repoId: repo.id, stage: 'planning' });
succeeded(waiting.id, 'planning');
await vibesSweep(db, writer);
const afterReview = getCard(db, waiting.id)!.stage;
const reviewedBy = actorsOf(waiting.id, 'reviewed');

// --- the questions --------------------------------------------------------
// Claude's own first suggestion goes back to it as the answer.
const asking = createCard(db, { title: 'asking', repoId: repo.id, stage: 'planning' });
const askRun = succeeded(asking.id, 'planning');
setRunStatus(db, askRun.id, {
  structuredOutput: { ...PLAN, open_questions: [{ question: 'Which way?', suggestions: ['Left', 'Right'] }] },
});
replaceQuestions(db, asking.id, askRun.id, 'planning', [
  { question: 'Which way?', suggestions: ['Left', 'Right'] },
]);
await vibesSweep(db, writer);
const answers = questionsForRun(db, askRun.id).map((q) => q.answer);
const answeredBy = actorsOf(asking.id, 'answered');

// --- the scoreboard -------------------------------------------------------
const state = vibesState(db)!;

// --- off again ------------------------------------------------------------
updateSettings(db, { vibes: false });
const parked = createCard(db, { title: 'parked', repoId: repo.id, stage: 'backlog' });
await vibesSweep(db, writer);
const afterOff = getCard(db, parked.id)!.stage;

// --- one card on its own --------------------------------------------------
// The board's switch stays off. Flagged cards go, and the one beside each of
// them that nobody flagged waits for a person as it always has. They go the way
// the whole board does, over Planning: the flag and the switch share
// `vibesNext`, so a flagged card is not planned either.
const solo = createCard(db, { title: 'solo', repoId: repo.id, stage: 'backlog' });
const bystander = createCard(db, { title: 'bystander', repoId: repo.id, stage: 'backlog' });
const soloWaiting = createCard(db, { title: 'solo waiting', repoId: repo.id, stage: 'planning' });
succeeded(soloWaiting.id, 'planning');
const bystanderWaiting = createCard(db, { title: 'bystander waiting', repoId: repo.id, stage: 'planning' });
succeeded(bystanderWaiting.id, 'planning');
// Flagged the moment after Add, before anything is typed into it.
const soloUnnamed = createCard(db, { title: PLACEHOLDER_TITLE, repoId: repo.id, stage: 'backlog' });
updateCard(db, solo.id, { vibes: true });
updateCard(db, soloWaiting.id, { vibes: true });
updateCard(db, soloUnnamed.id, { vibes: true });
await vibesSweep(db, writer);
const soloUnnamedStage = getCard(db, soloUnnamed.id)!.stage;
const soloStage = getCard(db, solo.id)!.stage;
const soloMovedBy = actorsOf(solo.id, 'moved');
const bystanderStage = getCard(db, bystander.id)!.stage;
const parkedStage = getCard(db, parked.id)!.stage;
const soloWaitingStage = getCard(db, soloWaiting.id)!.stage;
const soloReviews = cardEventsFor(db, soloWaiting.id)
  .filter((e) => e.kind === 'reviewed')
  .map((e) => ({ actor: e.actor, body: e.body }));
const bystanderWaitingStage = getCard(db, bystanderWaiting.id)!.stage;
const bystanderReviews = actorsOf(bystanderWaiting.id, 'reviewed');

// Turned off again, the card that just moved itself stops where it is, however
// many sweeps go by — with its implementation waiting for review, which the
// next sweep would otherwise approve into Testing.
updateCard(db, solo.id, { vibes: false });
succeeded(solo.id, 'in_progress');
await vibesSweep(db, writer);
await vibesSweep(db, writer);
const soloStageAfterOff = getCard(db, solo.id)!.stage;
const soloReviewsAfterOff = actorsOf(solo.id, 'reviewed');

// --- a project ------------------------------------------------------------
// The board's switch still off. A project's switch takes every task in its
// lane without any of them being flagged, and nothing outside it — least of
// all the project itself, which is a lane and not a stage to run.
const lane = createCard(db, { title: 'lane', kind: 'project', repoId: repo.id });
const laneTask = createCard(db, { title: 'lane task', repoId: repo.id, stage: 'backlog', projectId: lane.id });
const laneWaiting = createCard(db, { title: 'lane waiting', repoId: repo.id, stage: 'planning', projectId: lane.id });
succeeded(laneWaiting.id, 'planning');
const otherLane = createCard(db, { title: 'other lane', kind: 'project', repoId: repo.id });
const outsider = createCard(db, { title: 'outsider', repoId: repo.id, stage: 'backlog', projectId: otherLane.id });
updateCard(db, lane.id, { vibes: true });
await vibesSweep(db, writer);
const laneTaskStage = getCard(db, laneTask.id)!.stage;
const laneTaskMovedBy = actorsOf(laneTask.id, 'moved');
const laneWaitingStage = getCard(db, laneWaiting.id)!.stage;
const laneReviews = actorsOf(laneWaiting.id, 'reviewed');
const outsiderStage = getCard(db, outsider.id)!.stage;
const laneMoves = actorsOf(lane.id, 'moved');
const laneRuns = runsForCard(db, lane.id).length;

// Switched off, the lane's tasks wait for a person again, a plan written for
// one of them included.
updateCard(db, lane.id, { vibes: false });
const laneLater = createCard(db, { title: 'lane later', repoId: repo.id, stage: 'planning', projectId: lane.id });
succeeded(laneLater.id, 'planning');
await vibesSweep(db, writer);
await vibesSweep(db, writer);
const laneLaterStage = getCard(db, laneLater.id)!.stage;
const laneLaterReviews = actorsOf(laneLater.id, 'reviewed');

// Counted, not just printed: two ✗ lines in the single-card section went
// unnoticed across several merges while this always exited 0.
let failed = 0;
const ok = (label: string, got: unknown, want: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failed++;
  console.log(`${pass ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${pass ? '' : ` (wanted ${JSON.stringify(want)})`}`);
};

console.log('\n--- with the switch off ---');
ok('a backlog card is left alone', stayedPut, 'backlog');
ok('and is still left alone after it has been on and off', afterOff, 'backlog');

console.log('\n--- with the switch on ---');
ok('backlog moves itself over planning into in progress', movedTo, 'in_progress');
ok('in one move, recorded as Claude, not as you', movedBy, ['claude']);
ok('a planning card with no plan is moved on', strandedTo, 'in_progress');
ok('and no planning run is started for either', plansStarted.length, 0);
ok('a card nobody has named yet is left where it is', unnamedStage, 'backlog');
ok('and goes the moment it is named', namedStage, 'in_progress');
ok('a plan waiting for review is approved', reviewedBy, ['claude']);
ok('and the card advances', afterReview, 'in_progress');
ok('a question is answered with Claude’s own first suggestion', answers, ['Left']);
ok('and the answer is recorded as Claude', answeredBy, ['claude']);

console.log('\n--- one card on its own, with the switch off ---');
ok('a flagged backlog card moves itself over planning into in progress', soloStage, 'in_progress');
ok('and the move is recorded as Claude', soloMovedBy, ['claude']);
ok('the unflagged backlog card beside it stays put', bystanderStage, 'backlog');
ok('and so does the one parked earlier', parkedStage, 'backlog');
ok('a flagged card nobody has named yet is left where it is', soloUnnamedStage, 'backlog');
ok('a flagged plan waiting for review is approved without being read', soloReviews, [
  { actor: 'claude', body: 'Approved by VIBES MODE. Nobody read this.' },
]);
ok('and the card advances', soloWaitingStage, 'in_progress');
ok('an unflagged plan waiting for review is not approved', bystanderReviews, []);
ok('and stays in planning', bystanderWaitingStage, 'planning');
ok('unflagged, its waiting implementation is not approved', soloReviewsAfterOff, []);
ok('and it stays in progress', soloStageAfterOff, 'in_progress');

console.log('\n--- a project, with the switch off ---');
ok('an unflagged backlog task in the lane moves itself over planning', laneTaskStage, 'in_progress');
ok('and the move is recorded as Claude', laneTaskMovedBy, ['claude']);
ok('a plan waiting in the lane is approved without being read', laneReviews, ['claude']);
ok('and the card advances', laneWaitingStage, 'in_progress');
ok('a task in another project stays put', outsiderStage, 'backlog');
ok('the project itself is never moved', laneMoves, []);
ok('nor run', laneRuns, 0);
ok('switched off, a plan waiting in the lane is not approved', laneLaterReviews, []);
ok('and stays in planning', laneLaterStage, 'planning');

console.log('\n--- the scoreboard ---');
ok('human approvals', state.humanApprovals, 0);
ok('reviews skipped', state.reviewsSkipped, 1);
ok('questions self-answered', state.questionsSelfAnswered, 1);
ok('moves', state.moves, 4);
ok('tokens count the runs since, without cache reads', state.spendTokens, 66_200);
console.log('log:');
for (const line of state.log) console.log(`  ◆ ${line}`);

console.log(failed === 0 ? '\nall VIBES MODE checks pass' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
