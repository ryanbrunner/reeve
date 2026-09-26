/**
 * Seeds two projects with tasks across stages and repos, beside a few cards
 * that belong to none, so the lanes, the Backlog ghost card, a drag between
 * lanes and a project's modal can all be tried without spending API credit.
 *
 * The first project reads as though it was split: its tasks were made by
 * Claude, with criteria, and it carries a finished split run.
 *
 *   REEVE_DB=data/reeve.db npx tsx packages/server/src/spikes/seed-projects.ts
 */
import type { Stage } from '@reeve/shared';
import { createApp } from '../index.js';
import { addCriterion, createCard, createRepo, insertRun, listRepos, setRunStatus, updateCard } from '../db/queries.js';

const { db } = createApp();

function repo(name: string, laneColor: string) {
  return (
    listRepos(db).find((r) => r.name === name) ??
    createRepo(db, {
      name, repoPath: `/tmp/${name}`, worktreeRoot: `/tmp/${name}-worktrees`, defaultBranch: 'main',
      setupCommand: null, testCommand: null, serverCommand: null,
      teardownCommand: null, finishCommand: null, laneColor, maxBudgetUsd: null,
    })
  );
}

const web = repo('storefront', '#6b7db3');
const api = repo('orders-api', '#b3866b');

function project(title: string, body: string, repoId: string) {
  const p = createCard(db, { title, kind: 'project', repoId });
  // Through updateCard, as the brief is, rather than at creation.
  updateCard(db, p.id, { body });
  return p;
}

function task(
  title: string,
  stage: Stage,
  repoId: string,
  projectId: string | null,
  opts: { claude?: boolean; criteria?: string[] } = {},
) {
  const c = createCard(db, {
    title, stage, repoId, projectId,
    body: `Seeded by seed-projects: ${title.toLowerCase()}.`,
    actor: opts.claude ? 'claude' : 'human',
  });
  for (const text of opts.criteria ?? []) addCriterion(db, c.id, text, opts.claude ? 'claude' : 'human');
  return c;
}

const saved = project(
  'Saved for later',
  'Let a shopper move a cart line to a saved list and back, so it survives the session and shows on every device they sign in on.',
  web.id,
);
const split = insertRun(db, {
  id: crypto.randomUUID(), cardId: saved.id, kind: 'claude', stage: 'backlog',
  status: 'running', task: 'split_project', cwd: web.repoPath, startedAt: new Date(Date.now() - 95_000),
});
setRunStatus(db, split.id, {
  status: 'succeeded', stopReason: 'completed', totalCostUsd: 0.214, finishedAt: new Date(),
  modelUsageJson: {
    'claude-opus-5-5': { inputTokens: 60, outputTokens: 6_400, cacheCreationInputTokens: 41_900, cacheReadInputTokens: 318_000 },
  },
});

task('Store saved items per customer', 'in_progress', api.id, saved.id, {
  claude: true,
  criteria: ['A saved item is still there after signing out and back in', 'Saving the same item twice keeps one'],
});
task('Save for later button on cart lines', 'planning', web.id, saved.id, {
  claude: true,
  criteria: ['Each cart line offers Save for later', 'A saved line leaves the cart total'],
});
task('Saved list under the cart', 'backlog', web.id, saved.id, {
  claude: true,
  criteria: ['The saved list shows beneath the cart', 'Move to cart puts the line back'],
});

const checkout = project(
  'Faster checkout',
  'Cut the checkout to one page, and stop asking returning shoppers for an address we already have.',
  api.id,
);
task('Remember the last shipping address', 'backlog', api.id, checkout.id);
task('One-page checkout layout', 'testing', web.id, checkout.id);

task('Fix the flaky tax rounding test', 'backlog', api.id, null);
task('Bump the image CDN client', 'done', web.id, null);
task('Typo in the footer', 'planning', web.id, null);

console.log('[reeve] seeded two projects and their tasks, plus three cards under no project');
