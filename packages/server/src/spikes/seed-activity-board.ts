/** Throwaway: a board showing one card per sub-state, for eyeballing the colours. */
import { createApp } from '../index.js';
import { createCard, createProject, insertRun, listProjects, setRunStatus } from '../db/queries.js';
import type { RunStatus, Stage } from '@reeve/shared';

const { db } = createApp();
const project =
  listProjects(db)[0] ??
  createProject(db, {
    name: 'reeve', repoPath: '/tmp/x', worktreeRoot: '/tmp/x', defaultBranch: 'main',
    setupCommand: null, testCommand: null, serverCommand: null,
    teardownCommand: null, finishCommand: null, laneColor: '#6b7db3', maxBudgetUsd: null,
  });

const plan = (questions: string[]) => ({
  plan_markdown: '# plan', summary: 's', files_to_touch: [], open_questions: questions, risk: 'low',
});

function card(title: string, stage: Stage, run?: { status: RunStatus; questions?: string[]; cost?: number }) {
  const c = createCard(db, { title, projectId: project.id, stage });
  if (!run) return;
  const r = insertRun(db, {
    id: crypto.randomUUID(), cardId: c.id, kind: 'claude', stage, status: 'running', cwd: '/tmp/x',
  });
  setRunStatus(db, r.id, {
    status: run.status,
    totalCostUsd: run.cost ?? null,
    structuredOutput: plan(run.questions ?? []),
  });
}

card('Backlog triage run', 'backlog');
card('Diff artifact for In Progress', 'backlog');
card('Plan the worktree service', 'planning', { status: 'running', cost: 0.412 });
card('Wire the Planning stage end to end', 'planning', { status: 'succeeded', cost: 1.204 });
card('Server supervisor: ports + start/stop', 'planning', { status: 'succeeded', questions: ['Reuse ports across cards?'], cost: 0.883 });
card('Budget accounting per project', 'planning', { status: 'failed', cost: 0.071 });
card('SSE reconnect on page reload', 'planning', { status: 'cancelled', cost: 0.019 });
card('Card detail drawer', 'in_progress', { status: 'running', cost: 2.15 });
card('Fractional index renormalisation', 'done');
console.log('[reeve] seeded a board covering every card sub-state');
