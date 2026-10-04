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
    // Vite owns the port Reeve tracks, so Testing and Preview get HMR instead
    // of whatever `dist` a build last produced; the tsx API server moves to a
    // port of its own, found by asking the OS for a free one, with
    // REEVE_DEV_API_PORT pointing Vite's `/api` proxy at it. `{{port}}` on
    // Vite's own command, rather than just the `REEVE_PORT` env it already
    // gets, puts the row's url on from the start (see `devServer.ts`'s
    // `known`), so nothing has to pick the right line out of two servers
    // racing to announce themselves (see AGENTS.md's Worktrees section).
    serverCommand:
      'API=$(node -e "const{createServer}=require(\'node:net\');const s=createServer();s.listen(0,\'127.0.0.1\',()=>{console.log(s.address().port);s.close()})"); REEVE_PORT=$API npm run dev -w @reeve/server & REEVE_DEV_API_PORT=$API npm run dev -w @reeve/web -- --port {{port}} --strictPort --host 127.0.0.1',
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
