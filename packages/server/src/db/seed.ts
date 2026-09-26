import { createApp } from '../index.js';
import { createCard, createRepo, listRepos } from './queries.js';

const { db } = createApp();
if (listRepos(db).length === 0) {
  const p = createRepo(db, {
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
  });
  createCard(db, { title: 'Wire the Planning stage end to end', repoId: p.id, stage: 'planning', body: 'First runnable stage.' });
  createCard(db, { title: 'Server supervisor: port allocation + start/stop', repoId: p.id, stage: 'backlog' });
  createCard(db, { title: 'Backlog triage run', repoId: p.id, stage: 'backlog' });
  createCard(db, { title: 'Diff artifact for In Progress', repoId: p.id, stage: 'backlog' });
  console.log('[reeve] seeded 1 repo, 4 cards');
} else {
  console.log('[reeve] already seeded');
}
