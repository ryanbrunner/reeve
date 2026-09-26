/**
 * Drives the brief's rich text editor in a real browser: open it and leave
 * without typing and find the body untouched, type and find the Markdown
 * round-trips with nothing but the typing changed, bold a word from the
 * toolbar, and paste an image, leave before it has uploaded, and find it
 * stored, linked from the body, shown on the page and handed to Claude as a
 * file. Needs the built web app
 * (`npm run build`) and Playwright's chromium.
 *
 *   REEVE_DB=/tmp/reeve-brief.db npx tsx packages/server/src/spikes/brief-editor-check.ts
 *
 * With no REEVE_DB it makes its own under /tmp rather than opening
 * data/reeve.db, and pasted images go beside it rather than into data/assets.
 * Screenshots go there too.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ApiCard, CardDetail } from '@reeve/shared';

const scratch = mkdtempSync(join(tmpdir(), 'reeve-brief-'));
process.env.REEVE_DB ??= join(scratch, 'app.db');
process.env.REEVE_ASSETS ??= join(dirname(process.env.REEVE_DB), 'assets');

const { serve } = await import('@hono/node-server');
const { chromium } = await import('playwright');
const { config } = await import('../config.js');
const { createApp } = await import('../index.js');
const { createRepo, getCard } = await import('../db/queries.js');
const { stageContextFor } = await import('../runs/claude.js');

assert.ok(existsSync(config.webDist), 'build the web app first: npm run build');
const shots = dirname(config.dbFile);

// Written the way the editor writes, so a round trip that changes nothing
// comes back byte for byte.
const BODY = [
  'The cart forgets what a guest put in it.\nA second line, in the same paragraph.',
  '# What to change',
  'Keep **saved items** across a *reload*, in `localStorage`, as [the spec](https://example.com/spec) says: https://example.com/issue',
  '- Guests\n- Signed-in users\n  - on every device',
  'Then:',
  '3. Third\n4. Fourth',
  '> Quoted, as a person said it.',
  '```\nconst cart = load();\nsave(cart);\n```',
  '---',
  'Last paragraph',
].join('\n\n');

/**
 * A screenshot on the clipboard, as the browser hands it over: a file named
 * image.png. A string, because this package compiles without the DOM's types.
 */
const PASTE_IMAGE = `(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 120;
  const g = canvas.getContext('2d');
  g.fillStyle = '#0ea5e9';
  g.fillRect(0, 0, 320, 120);
  g.fillStyle = '#fff';
  g.font = '24px sans-serif';
  g.fillText('Pasted from the clipboard', 16, 68);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const data = new DataTransfer();
  data.items.add(new File([blob], 'image.png', { type: 'image/png' }));
  document.querySelector('[role="textbox"]')
    .dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
})()`;

const { app, db } = createApp();
const repo = createRepo(db, {
  name: `brief-${Date.now()}`, repoPath: '/tmp/brief', worktreeRoot: '/tmp/brief-worktrees', defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: '#6b8fb3',
});
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as T;
}
const card = await call<ApiCard>('POST', '/api/cards', { title: 'Keep the cart', repoId: repo.id });
await call('PATCH', `/api/cards/${card.id}`, { body: BODY });
const body = async () => (await call<CardDetail>('GET', `/api/cards/${card.id}/detail`)).card.body;
assert.equal(await body(), BODY);

const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise((r) => server.once('listening', r));
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const view = page.getByRole('tabpanel').getByTitle('Click to edit');
  const editor = page.getByRole('textbox', { name: 'What this card is for' });
  const away = () => page.getByText('Acceptance criteria').click();
  const saved = async (expected: (b: string) => boolean) => {
    for (let i = 0; i < 50; i++) {
      const b = await body();
      if (expected(b)) return b;
      await page.waitForTimeout(100);
    }
    throw new Error(`body never became what was expected:\n${await body()}`);
  };

  // Opened and left alone: nothing written, not even a normalised copy.
  await page.goto(`${base}/?card=${card.id}`);
  await view.click();
  await editor.waitFor();
  assert.equal(await editor.locator('h1').textContent(), 'What to change', 'a heading is a heading again');
  await page.screenshot({ path: join(shots, 'brief-editing.png') });
  await away();
  await view.waitFor();
  assert.equal(await body(), BODY);
  console.log('[reeve] opened and left: the body is untouched');

  // Typed at the end: the rest comes back exactly as it was.
  await view.click();
  await editor.waitFor();
  await page.keyboard.type(' and more');
  await away();
  const typed = await saved((b) => b !== BODY);
  assert.equal(typed, `${BODY} and more`);
  console.log('[reeve] typed: every block round-trips, and only the typing changed');

  // Bolded from the toolbar.
  await view.click();
  await editor.waitFor();
  await editor.locator('p', { hasText: 'Then:' }).selectText();
  await page.getByRole('button', { name: 'Bold (⌘B)' }).click();
  await page.keyboard.press('Escape');
  const bolded = await saved((b) => b !== typed);
  assert.equal(bolded, typed.replace('Then:', '**Then:**'));
  console.log('[reeve] bold from the toolbar, and Escape saves: **Then:**');

  // Pasted: stored, linked, shown, and pointed at for Claude.
  await view.click();
  await editor.waitFor();
  await page.route('**/assets', async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });
  await page.evaluate(PASTE_IMAGE);
  // Left while the upload is still under way, which the save has to wait for.
  await editor.locator('img[data-pending]').waitFor();
  await away();
  await page.unroute('**/assets');
  const pasted = await saved((b) => b.includes('!['));
  const link = /!\[Pasted image\]\((\/api\/assets\/[\w-]+)\)/.exec(pasted);
  assert.ok(link?.[1], `the body links the image: ${pasted}`);
  // At the caret, which opening the editor leaves at the end.
  assert.ok(pasted.endsWith(link[0]), 'where it was pasted');
  assert.equal(pasted.replace(link[0], '').trim(), bolded, 'and nothing else changed');
  const res = await app.request(link[1]);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  await view.locator(`img[src="${link[1]}"]`).waitFor();
  const detail = await call<CardDetail>('GET', `/api/cards/${card.id}/detail`);
  assert.deepEqual(detail.assets.map((a) => a.kind), ['pasted'], 'a pasted image, not a mockup');
  const brief = stageContextFor(db, { card: getCard(db, card.id)!, repo, worktreePath: '/tmp/brief' }).brief;
  assert.match(brief, new RegExp(`\`${link[1]}\` is \`${config.assetsDir}/${card.id}/[\\w-]+\\.png\``));
  await page.screenshot({ path: join(shots, 'brief-pasted.png') });
  console.log(`[reeve] pasted: stored at ${link[1]}, shown, and listed for Claude as a file`);
} finally {
  await browser.close();
  server.close();
}
console.log(`[reeve] brief editor check passed; screenshots in ${shots}`);
