/**
 * Throwaway check: drives every card sub-state through the real board query,
 * and asserts that approving a plan leaves the card in its column.
 */
import { createApp } from '../index.js';
import { toBoardCard } from '../board.js';
import { createCard, createRepo, getCard, insertRun, setRunStatus } from '../db/queries.js';
import type { RunStatus } from '@reeve/shared';

const { db } = createApp();

const repo = createRepo(db, {
  name: `activity-check-${Date.now()}`,
  repoPath: '/tmp/x', worktreeRoot: '/tmp/x', defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null, maxBudgetUsd: null,
});

// A minimal plan the current contract accepts. If this stops parsing, awaitsInput
// quietly returns false and the questions case below is what catches it.
const plan = {
  summary: 's', details: [], steps: [], acceptance_criteria: [], captures: [],
  files_to_touch: [], risk: 'low',
  open_questions: [] as Array<{ question: string; suggestions: string[] }>,
};

function activityOf(opts: {
  stage?: 'backlog' | 'planning';
  status?: RunStatus;
  kind?: 'claude' | 'server';
  questions?: string[];
  /** A Suggest run in the same stage, newer than the stage's own. */
  suggest?: RunStatus;
}) {
  const c = createCard(db, { title: 'probe', repoId: repo.id, stage: opts.stage ?? 'planning' });
  if (opts.status) {
    const r = insertRun(db, {
      id: crypto.randomUUID(), cardId: c.id, kind: opts.kind ?? 'claude',
      stage: 'planning', status: 'running', cwd: '/tmp/x',
    });
    setRunStatus(db, r.id, {
      status: opts.status,
      structuredOutput: {
        ...plan,
        open_questions: (opts.questions ?? []).map((question) => ({ question, suggestions: [] })),
      },
    });
  }
  if (opts.suggest) {
    // Stamped a second on, so it is the newest run by more than a tie.
    const s = insertRun(db, {
      id: crypto.randomUUID(), cardId: c.id, kind: 'claude', task: 'suggest_criteria',
      stage: 'planning', status: 'running', cwd: '/tmp/x', createdAt: new Date(Date.now() + 1_000),
    });
    setRunStatus(db, s.id, { status: opts.suggest });
  }
  return toBoardCard(db, getCard(db, c.id)!, null, null).activity;
}

const cases: Array<[string, string, string]> = [
  ['no run yet', activityOf({}), 'idle'],
  ['backlog, never runnable', activityOf({ stage: 'backlog' }), 'idle'],
  ['claude working', activityOf({ status: 'running' }), 'running'],
  ['queued', activityOf({ status: 'queued' }), 'running'],
  ['plan done, no questions', activityOf({ status: 'succeeded' }), 'needs_review'],
  ['plan done, with questions', activityOf({ status: 'succeeded', questions: ['which db?'] }), 'needs_input'],
  ['run failed', activityOf({ status: 'failed' }), 'error'],
  ['orphaned by restart', activityOf({ status: 'interrupted' }), 'error'],
  ['stopped on purpose', activityOf({ status: 'cancelled' }), 'idle'],
  ['dev server running is not Claude', activityOf({ status: 'running', kind: 'server' }), 'idle'],
  ['suggest finished after the plan', activityOf({ status: 'succeeded', suggest: 'succeeded' }), 'needs_review'],
  ['suggest failed after the plan', activityOf({ status: 'succeeded', suggest: 'failed' }), 'needs_review'],
  ['suggest running, no plan yet', activityOf({ suggest: 'running' }), 'idle'],
];

let failed = 0;
for (const [name, got, want] of cases) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (wanted ${want})`}`);
}
console.log(failed === 0 ? '\nall activity cases pass' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
