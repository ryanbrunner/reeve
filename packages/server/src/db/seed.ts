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
    seedCommand: null,
    // Not `npm run dev`: that leaves Vite serving the live board's own API
    // (hardcoded to 4317 in `vite.config.ts`) from whatever port it picks for
    // itself, while the worktree's own tsx server quietly answers the port
    // Reeve actually tracks, serving `packages/web/dist` built as of whenever
    // it was last built — stale next to the card's own changes. Building
    // before every start keeps what Testing and Preview see current, at the
    // cost of the reload a running Vite would give a person clicking around.
    serverCommand: 'npm run build && npm start',
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
