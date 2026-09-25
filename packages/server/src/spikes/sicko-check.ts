/**
 * Throwaway check on the SICKO MODE sweep: does it actually take the human out
 * of the loop, and does it say so honestly afterwards?
 *
 * Run it against a scratch database — `REEVE_DB=/tmp/sicko.db tsx
 * src/spikes/sicko-check.ts` — because the sweep is the one thing in Reeve that
 * moves real cards on a real board without being asked.
 *
 * No worktree and no GitHub here, so the runs the sweep tries to start fail
 * their way out at the worktree and the pull requests never open. What is being
 * checked is the part above that: the moving, the approving, the answering, and
 * who each of those is recorded as.
 */
import { createApp } from '../index.js';
import {
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
import { sickoSweep } from '../sicko/engine.js';
import { sickoState } from '../sicko/state.js';

const { db, writer } = createApp();

const repo = createRepo(db, {
  name: `sicko-check-${Date.now()}`,
  repoPath: '/tmp/x', worktreeRoot: '/tmp/x', defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null, maxBudgetUsd: null,
});

const PLAN = {
  summary: 's', risk: 'low', files_to_touch: [], details: [], steps: [],
  open_questions: [], acceptance_criteria: [], captures: [],
};

const succeeded = (cardId: string, stage: 'planning' | 'in_progress' | 'testing') => {
  const run = insertRun(db, {
    id: crypto.randomUUID(), cardId, kind: 'claude', stage, status: 'running', cwd: '/tmp/x',
  });
  setRunStatus(db, run.id, { status: 'succeeded', structuredOutput: PLAN, totalCostUsd: 0.25 });
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
await sickoSweep(db, writer);
const stayedPut = getCard(db, asleep.id)!.stage;

updateSettings(db, { sicko: true });

// --- backlog --------------------------------------------------------------
// Nobody is going to drag this, and nobody is going to plan it either.
await sickoSweep(db, writer);
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
await sickoSweep(db, writer);
const unnamedStage = getCard(db, unnamed.id)!.stage;
updateCard(db, unnamed.id, { title: 'Gift notes at checkout' });
await sickoSweep(db, writer);
const namedStage = getCard(db, unnamed.id)!.stage;

// --- the review gate ------------------------------------------------------
// A plan waiting to be read is approved without being read, and the card
// advances — the same three things the Approve button does.
const waiting = createCard(db, { title: 'waiting', repoId: repo.id, stage: 'planning' });
succeeded(waiting.id, 'planning');
await sickoSweep(db, writer);
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
await sickoSweep(db, writer);
const answers = questionsForRun(db, askRun.id).map((q) => q.answer);
const answeredBy = actorsOf(asking.id, 'answered');

// --- the scoreboard -------------------------------------------------------
const state = sickoState(db)!;

// --- off again ------------------------------------------------------------
updateSettings(db, { sicko: false });
const parked = createCard(db, { title: 'parked', repoId: repo.id, stage: 'backlog' });
await sickoSweep(db, writer);
const afterOff = getCard(db, parked.id)!.stage;

const ok = (label: string, got: unknown, want: unknown) =>
  console.log(`${JSON.stringify(got) === JSON.stringify(want) ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}`);

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

console.log('\n--- the scoreboard ---');
ok('human approvals', state.humanApprovals, 0);
ok('reviews skipped', state.reviewsSkipped, 1);
ok('questions self-answered', state.questionsSelfAnswered, 1);
ok('moves', state.moves, 4);
ok('spend counts the runs since', state.spendUsd, 0.5);
console.log('log:');
for (const line of state.log) console.log(`  ◆ ${line}`);

process.exit(0);
