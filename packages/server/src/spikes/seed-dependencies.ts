/**
 * Seeds a board whose cards wait on each other, so the blocked chips, the
 * satisfied ones, the "needed by" count and the chain traced on hover can all
 * be looked at without spending API credit — calm, and under VIBES MODE.
 *
 * What it lays out:
 *   - a chain that crosses columns, lanes and repos, so hovering any card in
 *     it lights the rest, and one dependency is named `storefront#N`
 *   - a card waiting on one that merged and was archived, which must read as
 *     done rather than as missing or blocked
 *   - a card whose only dependency is in Done with no pull request: satisfied,
 *     not blocked
 *   - a card whose dependency is in Done with a pull request not yet merged:
 *     blocked, and its tooltip says so
 *   - a card waiting on five, which names three and says +2
 *   - cards with several dependents
 *
 * Nothing in the app writes dependencies yet, so the rows go straight in.
 * Seed a scratch database rather than your own:
 *
 *   REEVE_DB=/tmp/reeve-deps.db npx tsx packages/server/src/spikes/seed-dependencies.ts
 *   REEVE_DB=/tmp/reeve-deps.db npm run dev
 */
import { eq } from 'drizzle-orm';
import type { BoardResponse, Stage } from '@reeve/shared';
import { createApp } from '../index.js';
import { archiveCard, createCard, createRepo, listRepos } from '../db/queries.js';
import { card, cardDependency } from '../db/schema.js';

const { app, db } = createApp();

function repo(name: string, laneColor: string) {
  return (
    listRepos(db).find((r) => r.name === name) ??
    createRepo(db, {
      name, repoPath: `/tmp/${name}`, worktreeRoot: `/tmp/${name}-worktrees`, defaultBranch: 'main',
      setupCommand: null, testCommand: null, serverCommand: null,
      teardownCommand: null, finishCommand: null, laneColor,
    })
  );
}

const web = repo('storefront', '#6b7db3');
const api = repo('orders-api', '#b3866b');

const task = (title: string, stage: Stage, repoId: string, projectId: string | null = null) =>
  createCard(db, { title, stage, repoId, projectId, body: `Seeded by seed-dependencies: ${title.toLowerCase()}.` });

function waits(on: { id: string }[], who: { id: string }) {
  for (const d of on) db.insert(cardDependency).values({ cardId: who.id, dependsOnId: d.id }).run();
}

const saved = createCard(db, { title: 'Saved for later', kind: 'project', repoId: web.id });
const checkout = createCard(db, { title: 'Faster checkout', kind: 'project', repoId: api.id });

// Landed, and swept off the board as a merged card is ten minutes later.
const schema = task('Add a saved_for_later flag to cart lines', 'done', api.id);
db.update(card).set({ mergedAt: new Date(Date.now() - 3_600_000) }).where(eq(card.id, schema.id)).run();
archiveCard(db, schema.id, { reason: 'merged' });

const store = task('Store saved items per customer', 'in_progress', api.id, saved.id);
const button = task('Save for later button on cart lines', 'planning', web.id, saved.id);
const list = task('Saved list under the cart', 'backlog', web.id, saved.id);
const onePage = task('One-page checkout layout', 'testing', web.id, checkout.id);
const address = task('Remember the last shipping address', 'backlog', api.id, checkout.id);
const launch = task('Announce saved for later', 'backlog', web.id, saved.id);

waits([schema], store);
waits([store], button);
waits([store, button], list);
waits([button], onePage);
waits([list], address);
waits([store, button, list, onePage, address], launch);

const cdn = task('Bump the image CDN client', 'done', web.id);
const lazy = task('Lazy-load product images', 'backlog', web.id);
waits([cdn], lazy);

// In Done, but its pull request has not merged, so what builds on it waits:
// the chip names it and its tooltip says "PR not merged".
const retries = task('Retry failed payment webhooks', 'done', api.id, checkout.id);
db.update(card).set({ prUrl: 'https://github.com/example/orders-api/pull/41', prNumber: 41 })
  .where(eq(card.id, retries.id)).run();
const receipts = task('Email a receipt once payment settles', 'backlog', api.id, checkout.id);
waits([retries], receipts);

task('Fix the flaky tax rounding test', 'backlog', api.id);

// What the board will say, read back through the route the browser polls.
const board = (await (await app.request('/api/board')).json()) as BoardResponse;
for (const c of board.cards) {
  const on = c.dependsOn
    .map((d) => `${d.repoName}#${d.number}${d.done ? ' done' : d.awaitingMerge ? ' PR not merged' : ''}`)
    .join(', ');
  const blocked = c.dependsOn.some((d) => !d.done);
  console.log(
    `#${c.number} ${c.title} [${c.stage}]`,
    on ? `${blocked ? 'BLOCKED on' : 'satisfied:'} ${on}` : '',
    c.dependents.length ? `needed by ${c.dependents.length}` : '',
  );
}
