/**
 * Drives the card detail's "Depends on" section in a real browser: add a
 * dependency from the picker, reload and find it still there, see it from the
 * other side under "Needed by", get a refusal with its reason for a loop the
 * picker cannot see (it runs through an archived card), and remove one with its
 * ✕ for good. Needs the built web app (`npm run build`) and Playwright's
 * chromium.
 *
 *   REEVE_DB=/tmp/reeve-deps-ui.db npx tsx packages/server/src/spikes/dependency-ui-check.ts
 *
 * With no REEVE_DB it makes its own under /tmp rather than opening
 * data/reeve.db. Screenshots go beside that database.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ApiCard, CardDetail } from '@reeve/shared';

process.env.REEVE_DB ??= join(mkdtempSync(join(tmpdir(), 'reeve-deps-ui-')), 'app.db');

const { serve } = await import('@hono/node-server');
const { chromium } = await import('playwright');
const { config } = await import('../config.js');
const { createApp } = await import('../index.js');
const { createRepo } = await import('../db/queries.js');

assert.ok(existsSync(config.webDist), 'build the web app first: npm run build');
const shots = dirname(config.dbFile);

const { app, db } = createApp();
const repo = createRepo(db, {
  name: `deps-ui-${Date.now()}`, repoPath: '/tmp/deps-ui', worktreeRoot: '/tmp/deps-ui-worktrees', defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: '#b36b6b',
});
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as T;
}
const make = (title: string) => call<ApiCard>('POST', '/api/cards', { title, repoId: repo.id });
// Ids: the card's `dependsOn` names each dependency now, and what these
// assertions are about is which ones are linked.
const dependsOn = async (id: string) =>
  (await call<CardDetail>('GET', `/api/cards/${id}/detail`)).card.dependsOn.map((d) => d.id);

const a = await make('Card A');
const b = await make('Card B');
const c = await make('Card C');
const x = await make('Card X');
// C → X → A, then X archived: from A the board cannot see that C waits on it.
await call('POST', `/api/cards/${x.id}/dependencies`, { dependsOnId: a.id });
await call('POST', `/api/cards/${c.id}/dependencies`, { dependsOnId: x.id });
await call('POST', `/api/cards/${x.id}/archive`);

const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise((r) => server.once('listening', r));
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const rail = page.locator('aside[aria-label="Card facts"]');
  const picker = rail.getByLabel('Add a card this one depends on');
  const row = (title: string) => rail.locator('button', { hasText: title });

  // Add, from the picker.
  await page.goto(`${base}/?card=${a.id}`);
  await picker.waitFor();
  const offered = await picker.locator('option').allTextContents();
  assert.ok(!offered.some((o) => o.includes('Card A')), 'the card itself is not offered');
  await picker.selectOption(b.id);
  await row('Card B').waitFor();
  assert.match((await row('Card B').textContent()) ?? '', new RegExp(`#${b.number}\\s*Card B`));
  await page.screenshot({ path: join(shots, 'deps-added.png') });

  // Still there after a reload.
  await page.reload();
  await row('Card B').waitFor();
  assert.deepEqual(await dependsOn(a.id), [b.id]);
  console.log(`[reeve] added and reloaded: "${await row('Card B').textContent()}"`);

  // From the other side.
  await row('Card B').click();
  await page.waitForURL(new RegExp(`card=${b.id}`));
  await rail.getByText('Needed by').waitFor();
  await row('Card A').waitFor();
  assert.match((await row('Card A').textContent()) ?? '', new RegExp(`#${a.number}\\s*Card A`));
  await page.screenshot({ path: join(shots, 'deps-needed-by.png') });
  console.log(`[reeve] needed by: "${await row('Card A').textContent()}"`);

  // A loop the picker could not see is refused with the reason, and nothing saved.
  await page.goto(`${base}/?card=${a.id}`);
  await picker.waitFor();
  await picker.selectOption(c.id);
  const refusal = rail.getByText('that would make a cycle');
  await refusal.waitFor();
  const message = await refusal.textContent();
  assert.equal(message, `that would make a cycle: #${c.number} already depends on #${a.number}, through #${x.number}`);
  assert.deepEqual(await dependsOn(a.id), [b.id]);
  await page.screenshot({ path: join(shots, 'deps-refused.png') });
  console.log(`[reeve] refused: "${message}"`);

  // Removed with its ✕, and gone after a reload.
  await page.reload();
  await row('Card B').hover();
  await rail.getByRole('button', { name: `Stop depending on #${b.number}` }).click();
  await row('Card B').waitFor({ state: 'detached' });
  await page.reload();
  await picker.waitFor();
  assert.equal(await row('Card B').count(), 0);
  assert.deepEqual(await dependsOn(a.id), []);
  await page.screenshot({ path: join(shots, 'deps-removed.png') });
} finally {
  await browser.close();
  server.close();
}
console.log(`[reeve] dependency UI check passed; screenshots in ${shots}`);
