/**
 * Throwaway check on the board's one movement rule: Claude never moves a card,
 * a human action does. Approving is a human action, so it advances; a run
 * finishing on its own is not, so it doesn't.
 */
import type { BoardResponse } from '@reeve/shared';
import { createApp } from '../index.js';
import { createCard, createRepo, getCard, insertRun, setRunStatus } from '../db/queries.js';

const { app, db } = createApp();

const repo = createRepo(db, {
  name: `review-check-${Date.now()}`,
  repoPath: '/tmp/x', worktreeRoot: '/tmp/x', defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null,
});

const succeededPlan = (cardId: string) => {
  const run = insertRun(db, {
    id: crypto.randomUUID(), cardId, kind: 'claude',
    stage: 'planning', status: 'running', cwd: '/tmp/x',
  });
  setRunStatus(db, run.id, {
    status: 'succeeded',
    structuredOutput: {
      summary: 's', risk: 'low', files_to_touch: [], details: [], steps: [],
      open_questions: [], acceptance_criteria: [], captures: [],
    },
  });
  return run;
};

const get = async <T,>(path: string): Promise<T> =>
  (await app.fetch(new Request(`http://x${path}`))).json() as Promise<T>;

const review = (cardId: string, body: unknown) =>
  app.fetch(new Request(`http://x/api/cards/${cardId}/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));

// A run that merely succeeded must leave the card exactly where it is.
const untouched = createCard(db, { title: 'untouched', repoId: repo.id, stage: 'planning' });
succeededPlan(untouched.id);
const board = await get<BoardResponse>('/api/board');
const onBoard = board.cards.find((c) => c.id === untouched.id);

// The same card, once a human approves it, moves on by one.
const approved = createCard(db, { title: 'approved', repoId: repo.id, stage: 'planning' });
succeededPlan(approved.id);
const before = getCard(db, approved.id)!.stage;
const res = await review(approved.id, { decision: 'approved', notes: 'looks good' });
const body = (await res.json()) as { fromStage?: string; toStage?: string; moved?: boolean };
const after = getCard(db, approved.id)!.stage;
const reviews = await get<Array<{ decision: string }>>(`/api/cards/${approved.id}/reviews`);

// Rejecting is not a verdict that the work is good, so it moves nothing. (No
// worktree here, so the forked revision run is refused after the row is written
// — the review is recorded either way, which is what this checks.)
const rejected = createCard(db, { title: 'rejected', repoId: repo.id, stage: 'planning' });
succeededPlan(rejected.id);
await review(rejected.id, { decision: 'rejected', notes: 'try again' });
const rejectedStage = getCard(db, rejected.id)!.stage;

// A dev server started after the last Claude run must not make the card
// unreviewable. It once did: the stage's newest run was a `vite` process.
const served = createCard(db, { title: 'served', repoId: repo.id, stage: 'planning' });
succeededPlan(served.id);
insertRun(db, {
  id: crypto.randomUUID(), cardId: served.id, kind: 'server', stage: 'planning',
  status: 'running', cwd: '/tmp/x', port: 5174,
});
const servedRes = await review(served.id, { decision: 'approved' });
const servedStage = getCard(db, served.id)!.stage;

const checks: Array<[string, boolean, string]> = [
  ['a succeeded run moves nothing', onBoard?.stage === 'planning', String(onBoard?.stage)],
  ['...and still reads as needing review', onBoard?.activity === 'needs_review', String(onBoard?.activity)],
  ['approval accepted', res.status === 200, `HTTP ${res.status} ${JSON.stringify(body)}`],
  ['approval advances one stage', before === 'planning' && after === 'in_progress', `${before} -> ${after}`],
  ['both stages recorded', body.fromStage === 'planning' && body.toStage === 'in_progress' && body.moved === true, JSON.stringify(body)],
  ['verdict recorded', reviews.length === 1 && reviews[0]?.decision === 'approved', JSON.stringify(reviews)],
  ['rejection moves nothing', rejectedStage === 'planning', rejectedStage],
  ['a running dev server does not block review', servedRes.status === 200, `HTTP ${servedRes.status}`],
  ['...and the card still advances', servedStage === 'in_progress', servedStage],
];

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (${detail})`);
}
console.log(failed === 0 ? '\nonly a human moves a card, and approving is one' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
