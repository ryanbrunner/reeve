import { createApp } from '../index.js';
import { createCard, createProject, listProjects } from './queries.js';

const { db } = createApp();
if (listProjects(db).length === 0) {
  const p = createProject(db, {
    name: 'reeve',
    repoPath: '/Users/ryan/code/reeve',
    worktreeRoot: '/Users/ryan/code/.reeve-worktrees',
    defaultBranch: 'main',
    setupCommand: 'npm install',
    testCommand: 'npm run typecheck',
    serverCommand: 'npm run dev',
    teardownCommand: null,
    finishCommand: null,
    laneColor: '#6b7db3',
    maxBudgetUsd: 5,
  });
  createCard(db, { title: 'Wire the Planning stage end to end', projectId: p.id, stage: 'planning', body: 'First runnable stage.' });
  createCard(db, { title: 'Server supervisor: port allocation + start/stop', projectId: p.id, stage: 'backlog' });
  createCard(db, { title: 'Backlog triage run', projectId: p.id, stage: 'backlog' });
  createCard(db, { title: 'Diff artifact for In Progress', projectId: p.id, stage: 'ready_for_planning' });
  console.log('[reeve] seeded 1 project, 4 cards');
} else {
  console.log('[reeve] already seeded');
}
