/**
 * Drives a card that is starting in a real browser, which no seed can show:
 * `startingStage` lives only in the server's memory, for the seconds between a
 * start and its run. A repo whose setup command is `sleep` holds Planning
 * cards there — one whose last run failed, one ready for review — and the
 * board and the open card are checked for the Starting band, the "starting…"
 * chip, and no Retry, Mark reviewed, Send back or Run to press meanwhile. The
 * open card has to turn to starting on its own, by its poll, when the start is
 * made somewhere else; and Retry on another failed card has to show the band
 * while its POST is still waiting on the setup.
 *
 * No API credit: the concurrency cap is set to 0 behind the settings route's
 * back, so each start is refused with a 429 once the setup is done and Claude
 * never runs. Needs the built web app (`npm run build`) and Playwright's
 * chromium.
 *
 *   REEVE_DB=/tmp/reeve-starting-ui.db npx tsx packages/server/src/spikes/starting-ui-check.ts
 *
 * With no REEVE_DB it makes its own under /tmp rather than opening
 * data/reeve.db. Screenshots go beside that database.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CardDetail } from '@reeve/shared';

process.env.REEVE_DB ??= join(mkdtempSync(join(tmpdir(), 'reeve-starting-ui-')), 'app.db');

const { serve } = await import('@hono/node-server');
const { chromium } = await import('playwright');
const { config } = await import('../config.js');
const { createApp } = await import('../index.js');
const { createCard, createRepo, insertRun, moveCard, updateSettings } = await import('../db/queries.js');

assert.ok(existsSync(config.webDist), 'build the web app first: npm run build');
const shots = dirname(config.dbFile);

const scratch = mkdtempSync(join(tmpdir(), 'reeve-starting-repo-'));
const repoPath = join(scratch, 'repo');
execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
writeFileSync(join(repoPath, 'README.md'), '# starting\n');
execFileSync('git', ['-C', repoPath, 'add', 'README.md']);
execFileSync('git', ['-C', repoPath, '-c', 'user.name=spike', '-c', 'user.email=spike@example.com', 'commit', '-qm', 'init']);

const SETUP = 'sleep 20';
const { app, db } = createApp();
// The guarantee that no run spends credit: every start is refused at the cap.
updateSettings(db, { maxConcurrentRuns: 0 });
const repo = createRepo(db, {
  name: `starting-ui-${Date.now()}`, repoPath, worktreeRoot: join(scratch, 'worktrees'), defaultBranch: 'main',
  setupCommand: SETUP, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: '#6b8bb3',
});

const ago = (s: number) => new Date(Date.now() - s * 1000);
// Enough of a plan for the Plan tab to render, and with it the Crit gate.
const PLAN = {
  summary: 'A plan to review while its revision starts.',
  details: [{ heading: 'Approach', body: 'Nothing, carefully.' }],
  steps: [{ title: 'Do nothing', detail: 'Carefully.', files: ['README.md'], blocked_on_question: null }],
  open_questions: [],
  acceptance_criteria: ['Nothing changes'],
  captures: [],
  files_to_touch: ['README.md'],
  risk: 'low' as const,
};
function planningCard(title: string, status: 'failed' | 'succeeded') {
  const card = createCard(db, { title, repoId: repo.id });
  moveCard(db, card.id, 'planning', 0);
  insertRun(db, {
    id: crypto.randomUUID(), cardId: card.id, kind: 'claude', stage: 'planning', status,
    sessionId: crypto.randomUUID(), cwd: '/tmp/x', createdAt: ago(120), startedAt: ago(120), finishedAt: ago(60),
    ...(status === 'failed' ? { errorMessage: 'the spike says so' } : { structuredOutput: PLAN }),
  });
  return card;
}
const failed = planningCard('Retry me while I start', 'failed');
const ready = planningCard('Review me while I start', 'succeeded');
const approved = planningCard('Approve me into a start', 'succeeded');
// Its own card, not `failed` again: that one's worktree has had its setup by
// the time Retry is pressed, so its start would be refused at once.
const retried = planningCard('Press my Retry and wait', 'failed');

async function detail(id: string) {
  return (await (await app.request(`/api/cards/${id}/detail`)).json()) as CardDetail;
}
assert.equal((await detail(failed.id)).card.activity, 'error');
assert.equal((await detail(ready.id)).card.activity, 'needs_review');
assert.equal((await detail(retried.id)).card.activity, 'error');

const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise((r) => server.once('listening', r));
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const dialog = page.getByRole('dialog');
  const button = (name: string) => dialog.getByRole('button', { name, exact: true });

  // Before: the buttons the start must take away are there.
  await page.goto(`${base}/?card=${failed.id}`);
  await button('Retry').waitFor();
  await page.screenshot({ path: join(shots, 'starting-before-failed.png') });
  await page.goto(`${base}/?card=${ready.id}`);
  await button('Mark reviewed').waitFor();
  await page.screenshot({ path: join(shots, 'starting-before-ready.png') });

  // Start both, not awaited: each holds `starting` through the setup.
  const t0 = Date.now();
  const starts = [failed, ready].map(async (c) => {
    const r = await app.request(`/api/cards/${c.id}/run`, { method: 'POST' });
    return { status: r.status, body: (await r.json()) as unknown };
  });

  // A start from outside the page — the CLI, a sweep — is not pushed, so the
  // open card has only its own 3s poll to notice it by. No reload: that would
  // pass whether the poll does or not.
  await dialog.getByText('Starting Planning').waitFor({ timeout: 4_000 })
    .catch(() => assert.fail('the open card did not turn to starting on its own within 4s of an outside start'));
  assert.ok((await detail(ready.id)).card.startingStage);
  console.log(`[reeve] open card read as starting ${Date.now() - t0}ms after the start`);
  await dialog.getByText(`Waiting on the repo’s setup, ${SETUP}, before Claude starts.`).waitFor({ timeout: 10_000 });
  for (const name of ['Mark reviewed', 'Send back', 'Retry']) assert.equal(await button(name).count(), 0, `${name} while starting`);
  await page.screenshot({ path: join(shots, 'starting-open-ready.png') });

  // The Plan tab's Crit gate, the plan's other approve/reject.
  await dialog.getByRole('tab', { name: /^Plan/ }).click();
  await dialog.getByText('Claude is starting on the plan. Wait for it to finish.').waitFor();
  assert.ok(await dialog.getByRole('button', { name: 'Review with Crit' }).isDisabled(), 'Crit held while starting');
  await page.screenshot({ path: join(shots, 'starting-plan-tab.png') });

  await page.goto(`${base}/?card=${failed.id}`);
  await dialog.getByText('Starting Planning').waitFor();
  for (const name of ['Retry', 'Mark reviewed', 'Send back']) assert.equal(await button(name).count(), 0, `${name} while starting`);
  await page.screenshot({ path: join(shots, 'starting-open-failed.png') });

  // The board: both cards glow, say starting…, and offer no Run.
  await page.goto(base);
  const face = (title: string) => page.locator('[data-card-id], article, li').filter({ hasText: title }).last();
  for (const title of [failed.title, ready.title]) {
    await face(title).getByText('starting…').waitFor();
    assert.equal(await face(title).getByRole('button', { name: /^Run/ }).count(), 0, `Run on ${title} while starting`);
    assert.equal(await face(title).locator('.card-rail').count(), 1, `rail on ${title} while starting`);
    assert.equal(await face(title).getByText('Starting', { exact: true }).count(), 1, `sr label on ${title}`);
  }
  await page.screenshot({ path: join(shots, 'starting-board.png') });

  // The setup ends, the cap refuses the start, and the card is what it was.
  const results = await Promise.all(starts);
  console.log(`[reeve] starts ended after ${Date.now() - t0}ms: ${JSON.stringify(results)}`);
  for (const r of results) assert.equal(r.status, 429, 'refused at the cap, so Claude never ran');
  for (const title of [failed.title, ready.title]) {
    await face(title).getByText('starting…').waitFor({ state: 'detached', timeout: 10_000 });
  }
  await page.screenshot({ path: join(shots, 'starting-board-after.png') });
  await page.goto(`${base}/?card=${failed.id}`);
  await button('Retry').waitFor();
  await page.screenshot({ path: join(shots, 'starting-after-failed.png') });

  // Retry from the open card. Its POST answers only once the new worktree's
  // setup is done, and the band is not to wait on it: the card reads as
  // starting from the moment the server takes the request.
  await page.goto(`${base}/?card=${retried.id}`);
  let answered = false;
  const retriedStart = page.waitForResponse((r) =>
    r.url().endsWith(`/api/cards/${retried.id}/run`) && r.request().method() === 'POST', { timeout: 40_000 });
  void retriedStart.then(() => { answered = true; });
  await button('Retry').click();
  const t2 = Date.now();
  await dialog.getByText('Starting Planning').waitFor({ timeout: 4_000 })
    .catch(() => assert.fail('Retry did not turn the card to starting within 4s'));
  assert.ok(!answered, 'the Starting band waited on the POST');
  console.log(`[reeve] retried card read as starting ${Date.now() - t2}ms after Retry, before its POST returned`);
  for (const name of ['Retry', 'Mark reviewed', 'Send back']) assert.equal(await button(name).count(), 0, `${name} while starting`);
  await page.screenshot({ path: join(shots, 'starting-open-retried.png') });
  // The cap refuses it once the setup is done, and the Failed band that comes
  // back says why, though it is not the one Retry was pressed on.
  assert.equal((await retriedStart).status(), 429, 'refused at the cap, so Claude never ran');
  console.log(`[reeve] retried start refused ${Date.now() - t2}ms after Retry`);
  await button('Retry').waitFor({ timeout: 10_000 });
  await dialog.getByText('too many concurrent runs: limit is 0').waitFor();
  await page.screenshot({ path: join(shots, 'starting-after-retried.png') });

  // The path a person takes: Mark reviewed on the open card approves it into
  // In Progress, which starts it behind the new worktree's setup. The band
  // turns without a reload, since the approval refetches the card.
  await page.goto(`${base}/?card=${approved.id}`);
  await button('Mark reviewed').click();
  const t1 = Date.now();
  await dialog.getByText('Starting In Progress').waitFor({ timeout: 10_000 });
  console.log(`[reeve] approved card read as starting ${Date.now() - t1}ms after Mark reviewed`);
  for (const name of ['Mark reviewed', 'Send back', 'Retry']) assert.equal(await button(name).count(), 0, `${name} while starting`);
  await dialog.getByText(/Waiting on the repo’s setup|Making the worktree|Claude starts in a moment/).waitFor();
  console.log(`[reeve] approved band: "${await dialog.getByText(/Waiting on the repo’s setup|Making the worktree|Claude starts in a moment/).textContent()}"`);
  // The worktree is made in a moment, and the band moves on to the setup by
  // its own poll.
  await dialog.getByText(`Waiting on the repo’s setup, ${SETUP}, before Claude starts.`).waitFor({ timeout: 10_000 });
  console.log(`[reeve] approved band moved on to the setup ${Date.now() - t1}ms after Mark reviewed`);
  await page.screenshot({ path: join(shots, 'starting-open-approved.png') });
  // It goes back to idle once the cap refuses the start, and with no reload.
  await dialog.getByText('Starting In Progress').waitFor({ state: 'detached', timeout: 40_000 });
  console.log(`[reeve] approved card stopped starting ${Date.now() - t1}ms after Mark reviewed`);
  await page.screenshot({ path: join(shots, 'starting-open-approved-after.png') });
} finally {
  await browser.close();
  server.close();
}
console.log(`[reeve] starting UI check passed; screenshots in ${shots}`);
