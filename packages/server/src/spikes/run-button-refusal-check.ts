/**
 * Presses the board's Run and Retry on cards whose start waits on a setup and
 * is then refused, and checks that each card turns to starting… without
 * waiting for the board's poll, and that the refusal is said under the button
 * once the card stops starting. Since #81 the card hides its Run button while
 * it starts, so the button that comes back is a fresh one, and before the
 * refusal was read off the mutation cache it never showed.
 *
 * No API credit: the concurrency cap is set to 0 behind the settings route's
 * back, so each start is refused with a 429 once the setup is done and Claude
 * never runs. Needs the built web app (`npm run build`) and Playwright's
 * chromium.
 *
 *   REEVE_DB=/tmp/reeve-run-refusal.db npx tsx packages/server/src/spikes/run-button-refusal-check.ts
 *
 * With no REEVE_DB it makes its own under /tmp rather than opening
 * data/reeve.db. Screenshots go beside that database.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

process.env.REEVE_DB ??= join(mkdtempSync(join(tmpdir(), 'reeve-run-refusal-')), 'app.db');

const { serve } = await import('@hono/node-server');
const { chromium } = await import('playwright');
const { config } = await import('../config.js');
const { createApp } = await import('../index.js');
const { createCard, createRepo, insertRun, moveCard, updateSettings } = await import('../db/queries.js');

assert.ok(existsSync(config.webDist), 'build the web app first: npm run build');
const shots = dirname(config.dbFile);

const scratch = mkdtempSync(join(tmpdir(), 'reeve-run-refusal-repo-'));
const repoPath = join(scratch, 'repo');
execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
writeFileSync(join(repoPath, 'README.md'), '# refusal\n');
execFileSync('git', ['-C', repoPath, 'add', 'README.md']);
execFileSync('git', ['-C', repoPath, '-c', 'user.name=spike', '-c', 'user.email=spike@example.com', 'commit', '-qm', 'init']);

// Longer than the board's idle poll, so a card seen starting sooner than this
// was seen by the button's own refetch.
const SETUP = 'sleep 8';
const REFUSAL = 'too many concurrent runs: limit is 0';
const { app, db } = createApp();
// The guarantee that no run spends credit: every start is refused at the cap.
updateSettings(db, { maxConcurrentRuns: 0 });
const repo = createRepo(db, {
  name: `run-refusal-${Date.now()}`, repoPath, worktreeRoot: join(scratch, 'worktrees'), defaultBranch: 'main',
  setupCommand: SETUP, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: '#6b8bb3',
});

const ago = (s: number) => new Date(Date.now() - s * 1000);
// One whose run failed, for Retry, and one that never ran, for Run.
const failed = createCard(db, { title: 'Retry me into a refusal', repoId: repo.id });
moveCard(db, failed.id, 'planning', 0);
insertRun(db, {
  id: crypto.randomUUID(), cardId: failed.id, kind: 'claude', stage: 'planning', status: 'failed',
  sessionId: crypto.randomUUID(), cwd: '/tmp/x', createdAt: ago(120), startedAt: ago(120), finishedAt: ago(60),
  errorMessage: 'the spike says so',
});
const fresh = createCard(db, { title: 'Run me into a refusal', repoId: repo.id });
moveCard(db, fresh.id, 'planning', 1);

const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise((r) => server.once('listening', r));
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(base);
  const face = (title: string) => page.locator('[data-card-id], article, li').filter({ hasText: title }).last();

  for (const [title, name] of [[failed.title, 'Retry'], [fresh.title, 'Run']] as const) {
    await face(title).getByRole('button', { name, exact: true }).click();
    const t0 = Date.now();
    await face(title).getByText('starting…', { exact: true }).waitFor({ timeout: 3_000 });
    console.log(`[reeve] ${name}: card read as starting ${Date.now() - t0}ms after the press`);
    assert.equal(await face(title).getByRole('button', { name: /^(Run|Retry|Starting)/ }).count(), 0, `${name} hidden while starting`);
    await page.screenshot({ path: join(shots, `run-refusal-${name.toLowerCase()}-starting.png`) });

    // The setup ends, the cap refuses the start, and the button that comes
    // back says so.
    await face(title).getByText('starting…', { exact: true }).waitFor({ state: 'detached', timeout: 30_000 });
    await face(title).getByRole('button', { name, exact: true }).waitFor();
    await face(title).getByText(REFUSAL).waitFor({ timeout: 5_000 });
    console.log(`[reeve] ${name}: refusal said ${Date.now() - t0}ms after the press`);
    await page.screenshot({ path: join(shots, `run-refusal-${name.toLowerCase()}-refused.png`) });
  }

  // Outlives the board's next polls. A second press is not checked for
  // clearing it: the worktree is reused and its setup already succeeded, so
  // the cap refuses that start before the card is ever seen starting.
  await new Promise((r) => setTimeout(r, 6_000));
  assert.equal(await face(failed.title).getByText(REFUSAL).count(), 1, 'refusal kept across polls');
} finally {
  await browser.close();
  server.close();
}
console.log(`[reeve] run button refusal check passed; screenshots in ${shots}`);
