/**
 * Drives the repo pickers in a real browser: the one every new card asks
 * from, the card header's chip, and VIBES MODE's Ship it. + always asks and
 * makes nothing until a row is picked, even with one repo; in a lane whose
 * project has a repo that repo comes first, tagged, and still not picked; with
 * none it offers Add a repo. Needs the built web app (`npm run build`) and
 * Playwright's chromium.
 *
 *   REEVE_DB=/tmp/reeve-repo-picker.db npx tsx packages/server/src/spikes/repo-picker-check.ts
 *
 * With no REEVE_DB it makes its own under /tmp rather than opening
 * data/reeve.db. It wants a board with no repos of its own, and archives the
 * two it makes along the way. Screenshots go beside that database.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BoardResponse } from '@reeve/shared';

process.env.REEVE_DB ??= join(mkdtempSync(join(tmpdir(), 'reeve-repo-picker-')), 'app.db');

const { serve } = await import('@hono/node-server');
const { chromium } = await import('playwright');
const { eq } = await import('drizzle-orm');
const { config } = await import('../config.js');
const { createApp } = await import('../index.js');
const { createCard, createRepo, listRepos } = await import('../db/queries.js');
const { repo: repoTable } = await import('../db/schema.js');

assert.ok(existsSync(config.webDist), 'build the web app first: npm run build');
const shots = dirname(config.dbFile);

const { app, db } = createApp();
assert.equal(listRepos(db).length, 0, 'give it a board with no repos: a fresh REEVE_DB');
const repo = (name: string, laneColor: string) =>
  createRepo(db, {
    name, repoPath: `/tmp/${name}`, worktreeRoot: `/tmp/${name}-worktrees`, defaultBranch: 'main',
    setupCommand: null, testCommand: null, serverCommand: null,
    teardownCommand: null, finishCommand: null, laneColor,
  });
const storefront = repo('storefront', '#6b7db3');
const ordersApi = repo('orders-api', '#b3866b');
const filed = createCard(db, { title: 'Filed project', kind: 'project', repoId: storefront.id });
const unfiled = createCard(db, { title: 'Unfiled project', kind: 'project', repoId: null });
createCard(db, { title: 'Tidy the settings pane', repoId: storefront.id });
const setArchived = (id: string, archived: boolean) =>
  db.update(repoTable).set({ archivedAt: archived ? new Date() : null }).where(eq(repoTable.id, id)).run();

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as T;
}
const cards = async () => (await call<BoardResponse>('GET', '/api/board')).cards;

const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise((r) => server.once('listening', r));
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const ghost = (lane: string) => page.locator(`#lane-${lane}`).getByRole('button', { name: 'Add a card' });
  const picker = page.getByRole('listbox', { name: 'Repo for the new card' });
  const dialog = page.getByRole('dialog');
  const hasNew = () => new URL(page.url()).searchParams.has('new');
  // The button rather than Escape: a new card arrives with its title focused,
  // and Escape there only leaves the title.
  const closeCard = async () => {
    await dialog.getByRole('button', { name: 'Close card details' }).click();
    await dialog.waitFor({ state: 'detached' });
  };

  // + in No project asks, and makes nothing.
  await page.goto(base);
  const before = (await cards()).length;
  await ghost('none').click();
  await page.locator('#lane-none').getByRole('listbox').waitFor();
  assert.equal((await cards()).length, before, 'opening the picker made a card');
  assert.equal(new URL(page.url()).searchParams.get('new'), 'none');
  assert.equal(await picker.getAttribute('aria-activedescendant'), null, 'a row was active on opening');
  assert.equal(await picker.locator('[aria-selected="true"]').count(), 0, 'a row was selected on opening');
  const offered = await picker.getByRole('option').allTextContents();
  assert.equal(offered.length, 2);
  assert.ok(!offered.some((o) => o.includes('No repo')), 'the new-card picker offered No repo');
  await page.screenshot({ path: join(shots, 'repo-picker-open.png') });

  // Enter before a row is chosen does nothing.
  await page.keyboard.press('Enter');
  assert.equal((await cards()).length, before, 'Enter with no row made a card');
  assert.ok(await picker.isVisible());

  // Escape, Cancel and a press elsewhere all shut it, with nothing made.
  await page.keyboard.press('ArrowDown');
  assert.notEqual(await picker.getAttribute('aria-activedescendant'), null);
  await page.keyboard.press('Escape');
  await picker.waitFor({ state: 'detached' });
  assert.ok(!hasNew(), 'Escape left ?new');
  await ghost('none').click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await picker.waitFor({ state: 'detached' });
  assert.ok(!hasNew(), 'Cancel left ?new');
  await ghost('none').click();
  await page.locator('h1').click();
  await picker.waitFor({ state: 'detached' });
  assert.ok(!hasNew(), 'a press elsewhere left ?new');
  assert.equal((await cards()).length, before, 'cancelling made a card');
  console.log('[reeve] picker opens empty-handed, and Escape, Cancel and a press elsewhere shut it');

  // A link to the picker opens it.
  await page.goto(`${base}/?new=none`);
  await page.locator('#lane-none').getByRole('listbox').waitFor();

  // Picking makes the card, filed where picked, open with its title selected.
  await picker.getByRole('option', { name: /orders-api/ }).click();
  await dialog.waitFor();
  await page.locator('#card-title:focus').waitFor();
  assert.ok(!hasNew(), 'the new card carried ?new');
  const made = (await cards()).find((c) => !c.projectId && c.repoId === ordersApi.id);
  assert.ok(made, 'no card was made under orders-api');
  const chip = dialog.getByRole('button', { name: /^Repo: / });
  assert.equal(await chip.getAttribute('aria-label'), 'Repo: orders-api');
  assert.equal(await dialog.locator('header select').count(), 0, 'the header still has a native select');
  console.log(`[reeve] picked orders-api: #${made.number} made and opened`);

  // The header's chip: Escape shuts the list and leaves the card open.
  await chip.click();
  const headerList = dialog.getByRole('listbox', { name: 'Repo' });
  await headerList.waitFor();
  assert.ok((await headerList.getByRole('option').allTextContents()).some((o) => o.includes('No repo')));
  await page.keyboard.press('Escape');
  await headerList.waitFor({ state: 'detached' });
  assert.ok(await dialog.isVisible(), 'Escape in the list closed the card');

  // It refiles, and with no repo it asks for one.
  await chip.click();
  await headerList.getByRole('option', { name: /storefront/ }).click();
  await dialog.getByRole('button', { name: 'Repo: storefront' }).waitFor();
  assert.equal((await cards()).find((c) => c.id === made.id)?.repoId, storefront.id);
  await dialog.getByRole('button', { name: 'Repo: storefront' }).click();
  await headerList.getByRole('option', { name: /No repo/ }).click();
  await dialog.getByRole('button', { name: 'Repo: Pick a repo' }).waitFor();
  assert.equal((await cards()).find((c) => c.id === made.id)?.repoId, null);
  await page.screenshot({ path: join(shots, 'repo-picker-header.png') });
  await closeCard();
  console.log('[reeve] header chip refiles, and Escape shuts only the list');

  // A project with a repo still asks: its repo first and tagged, not picked.
  // orders-api sorts first by name, so storefront coming first is the project.
  await ghost(filed.id).click();
  const filedList = page.locator(`#lane-${filed.id}`).getByRole('listbox');
  await filedList.waitFor();
  assert.equal(new URL(page.url()).searchParams.get('new'), filed.id);
  assert.ok(!(await cards()).some((c) => c.projectId === filed.id), 'a project with a repo made a card unasked');
  assert.equal(await filedList.getAttribute('aria-activedescendant'), null, 'the project repo was active');
  assert.equal(await filedList.locator('[aria-selected="true"]').count(), 0, 'the project repo was selected');
  const filedRows = await filedList.getByRole('option').allTextContents();
  assert.equal(filedRows.length, 2);
  assert.match(filedRows[0] ?? '', /^storefront\s*project/, `the project repo was not first and tagged: ${filedRows}`);
  assert.ok(!filedRows[1]?.includes('project'), 'another repo carried the project tag');
  await page.screenshot({ path: join(shots, 'repo-picker-project.png') });
  await page.keyboard.press('Enter');
  assert.ok(!(await cards()).some((c) => c.projectId === filed.id), 'Enter picked the project repo');
  await filedList.getByRole('option', { name: /storefront/ }).click();
  await dialog.waitFor();
  assert.equal((await cards()).find((c) => c.projectId === filed.id)?.repoId, storefront.id);
  await closeCard();

  // A project with none asks too, with no row tagged.
  await ghost(unfiled.id).click();
  const unfiledList = page.locator(`#lane-${unfiled.id}`).getByRole('listbox');
  await unfiledList.waitFor();
  assert.equal(new URL(page.url()).searchParams.get('new'), unfiled.id);
  assert.ok(!(await cards()).some((c) => c.projectId === unfiled.id));
  assert.ok(!(await unfiledList.getByRole('option').allTextContents()).some((o) => o.includes('project')));
  await page.keyboard.press('Escape');
  console.log('[reeve] a project lane asks, its repo first and tagged but not picked');

  // One repo: still a question, and a link to it is kept.
  setArchived(ordersApi.id, true);
  await page.goto(`${base}/?new=none`);
  await page.locator('#lane-none').getByRole('listbox').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('new'), 'none', 'a one-repo ?new was dropped');
  assert.equal(await picker.getAttribute('aria-activedescendant'), null);
  assert.equal(await picker.locator('[aria-selected="true"]').count(), 0);
  await page.keyboard.press('Escape');
  const count = (await cards()).length;
  await ghost('none').click();
  await picker.waitFor();
  assert.equal((await cards()).length, count, 'one repo: + made a card without asking');
  await picker.getByRole('option', { name: /storefront/ }).click();
  await dialog.waitFor();
  const only = await cards();
  assert.equal(only.length, count + 1);
  assert.ok(only.some((c) => !c.projectId && c.repoId === storefront.id && c.title === 'Untitled'));
  await closeCard();
  console.log('[reeve] one repo: + still asks, and ?new is kept');

  // No repos: it says so, and Add a repo opens the new-repo form.
  setArchived(storefront.id, true);
  await page.goto(base);
  await ghost('none').click();
  const lane = page.locator('#lane-none');
  await lane.getByText('No repos yet').waitFor();
  await lane.getByRole('button', { name: 'Add a repo' }).click();
  await page.getByRole('dialog').getByText('New repo').waitFor();
  assert.ok(!hasNew(), 'Add a repo left ?new');
  await page.screenshot({ path: join(shots, 'repo-picker-none.png') });
  console.log('[reeve] no repos: Add a repo opens Settings on the new-repo form');

  // VIBES MODE, one repo: even the only one waits to be picked.
  setArchived(storefront.id, false);
  await call('PATCH', '/api/settings', { vibes: true });
  await page.goto(base);
  const ship = page.getByRole('button', { name: 'Ship it' });
  await ship.waitFor();
  await page.getByRole('button', { name: 'Repo for the new card: Pick a repo' }).waitFor();
  await page.locator('#new-idea').fill('Ship an idea');
  assert.ok(await ship.isDisabled(), 'Ship it took the only repo without a pick');

  // Two repos: Ship it waits for a pick, and keeps it.
  setArchived(ordersApi.id, false);
  await page.goto(base);
  await ship.waitFor();
  assert.equal(await page.locator('header select').count(), 0, 'Ship it still has a native select');
  await page.locator('#new-idea').fill('Ship an idea');
  assert.ok(await ship.isDisabled(), 'Ship it went without a repo');
  await page.getByRole('button', { name: 'Repo for the new card: Pick a repo' }).click();
  const shipList = page.getByRole('listbox', { name: 'Repo for the new card' });
  assert.ok(!(await shipList.getByRole('option').allTextContents()).some((o) => o.includes('No repo')));
  await page.screenshot({ path: join(shots, 'repo-picker-vibes-open.png') });
  await shipList.getByRole('option', { name: /orders-api/ }).click();
  assert.ok(await ship.isEnabled());
  await ship.click();
  // A string, because this package compiles without the DOM's types.
  await page.waitForFunction(`document.querySelector('#new-idea')?.value === ''`);
  assert.equal((await cards()).find((c) => c.title === 'Ship an idea')?.repoId, ordersApi.id);
  await page.getByRole('button', { name: 'Repo for the new card: orders-api' }).waitFor();
  await page.locator('#new-idea').fill('Ship another');
  assert.ok(await ship.isEnabled(), 'the pick was not kept for the next idea');
  await page.screenshot({ path: join(shots, 'repo-picker-vibes.png') });
  console.log('[reeve] VIBES MODE: Ship it waits for a repo, and keeps it for the next idea');
} finally {
  await call('PATCH', '/api/settings', { vibes: false });
  await browser.close();
  server.close();
}
console.log(`[reeve] repo picker check passed; screenshots in ${shots}`);
