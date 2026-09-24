/** Throwaway check: approving a stage records a verdict and moves nothing. */
import type { BoardResponse } from '@reeve/shared';
import { createApp } from '../index.js';
import { createCard, createProject, getCard, insertRun, setRunStatus } from '../db/queries.js';

const { app, db } = createApp();

const project = createProject(db, {
  name: `review-check-${Date.now()}`,
  repoPath: '/tmp/x', worktreeRoot: '/tmp/x', defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null, maxBudgetUsd: null,
});

const card = createCard(db, { title: 'probe', projectId: project.id, stage: 'planning' });
const run = insertRun(db, {
  id: crypto.randomUUID(), cardId: card.id, kind: 'claude',
  stage: 'planning', status: 'running', cwd: '/tmp/x',
});
setRunStatus(db, run.id, {
  status: 'succeeded',
  structuredOutput: { plan_markdown: '# plan', summary: 's', files_to_touch: [], open_questions: [], risk: 'low' },
});

const before = getCard(db, card.id)!.stage;
const res = await app.fetch(new Request(`http://x/api/cards/${card.id}/review`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ decision: 'approved', notes: 'looks good' }),
}));
const body = await res.json();
const after = getCard(db, card.id)!.stage;

const get = async <T,>(path: string): Promise<T> =>
  (await app.fetch(new Request(`http://x${path}`))).json() as Promise<T>;

const reviews = await get<Array<{ decision: string }>>(`/api/cards/${card.id}/reviews`);
const board = await get<BoardResponse>('/api/board');
const onBoard = board.cards.find((c) => c.id === card.id);

const checks: Array<[string, boolean, string]> = [
  ['review accepted', res.status === 200, `HTTP ${res.status} ${JSON.stringify(body)}`],
  ['card did not move', before === after, `${before} -> ${after}`],
  ['verdict recorded', reviews.length === 1 && reviews[0]?.decision === 'approved', JSON.stringify(reviews)],
  ['still green for the human to drag', onBoard?.activity === 'needs_review', String(onBoard?.activity)],
];

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (${detail})`);
}
console.log(failed === 0 ? '\napproval is a verdict, not a move' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
