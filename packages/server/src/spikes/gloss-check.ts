/**
 * Throwaway check on a review in Gloss: that only an explicit `approved: true`
 * approves, that a round of comments becomes revision notes with each one's
 * page and selector, and that every other ending is recorded as no verdict.
 *
 * Gloss itself is not needed. A fake `gloss` goes first on PATH: it logs each
 * call, and `gloss wait` blocks until this script writes the verdict it should
 * print. The repo is not a git repo, so an approval's next stage and a
 * revision both fail to start, and no Claude run is ever made.
 *
 *   REEVE_DB=/tmp/gloss-check.db npx tsx packages/server/src/spikes/gloss-check.ts
 *
 * Not covered: the rounds after a revision (`gloss working`, `ready`, the next
 * wait), which need a real revision run to finish.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '../index.js';
import { cardEventsFor, createCard, createRepo, getCard, insertRun, reviewsForCard, setRunStatus } from '../db/queries.js';
import { card as cardTable, type Repo } from '../db/schema.js';
import { startGlossReview } from '../gloss.js';
import { runRegistry } from '../runs/registry.js';

const dir = mkdtempSync(join(tmpdir(), 'gloss-check-'));
writeFileSync(join(dir, 'gloss'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(args) + '\\n');
const name = args[args.indexOf('--name') + 1];
if (args[0] === 'status') { console.log(JSON.stringify({ running: false })); process.exit(1); }
if (args[0] !== 'wait') process.exit(0);
const file = path.join(dir, name + '.wait');
const poll = setInterval(() => {
  if (!fs.existsSync(file)) return;
  clearInterval(poll);
  const { exit, stdout } = JSON.parse(fs.readFileSync(file, 'utf8'));
  process.stdout.write(stdout);
  process.exit(exit);
}, 50);
`);
chmodSync(join(dir, 'gloss'), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;

const { db, writer } = createApp();

const withServer = (name: string, serverCommand: string | null) =>
  createRepo(db, {
    name: `${name}-${Date.now()}`,
    // Not a git repo: whatever an approval or a revision would start next is refused.
    repoPath: dir, worktreeRoot: dir, defaultBranch: 'main',
    setupCommand: null, testCommand: null, serverCommand,
    teardownCommand: null, finishCommand: null, laneColor: null,
  });
const repo = withServer('gloss-check', `node -e "require('http').createServer((q,s)=>s.end('ok')).listen({{port}})"`);

/** An In Progress card whose build is waiting for review. */
function built(title: string, r: Repo = repo) {
  const card = createCard(db, { title, repoId: r.id, stage: 'in_progress' });
  db.update(cardTable).set({ worktreePath: dir }).where(eq(cardTable.id, card.id)).run();
  const run = insertRun(db, {
    id: crypto.randomUUID(), cardId: card.id, kind: 'claude', stage: 'in_progress', status: 'running', cwd: dir,
  });
  setRunStatus(db, run.id, { status: 'succeeded', structuredOutput: { summary: 's', files_changed: [] } });
  return { card: getCard(db, card.id)!, run };
}

const sessionName = (cardId: string) => `reeve-${cardId.slice(0, 8)}-in_progress`;
const answer = (cardId: string, exit: number, stdout: string) =>
  writeFileSync(join(dir, `${sessionName(cardId)}.wait`), JSON.stringify({ exit, stdout }));
const verdict = (v: Record<string, unknown>) => JSON.stringify({ version: 1, round: 1, page: null, comments: [], ...v }, null, 2);
const calls = () => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
const glossEvent = (cardId: string) => cardEventsFor(db, cardId).find((e) => e.kind === 'gloss_reviewed');
const reviewed = (cardId: string) => cardEventsFor(db, cardId).find((e) => e.kind === 'reviewed');

async function settle(runId: string) {
  while (runRegistry.get(runId)) await new Promise((r) => setTimeout(r, 50));
  // The verdict is applied after the run ends, over a few awaits.
  await new Promise((r) => setTimeout(r, 500));
}

async function open(c: ReturnType<typeof built>) {
  const started = await startGlossReview(db, writer, c.card, repo, dir, c.run);
  if (!started.ok) throw new Error(`${c.card.title}: ${started.error} (${started.detail})`);
  return started;
}

// Approving in Gloss approves the stage and closes the window.
const approved = built('approved');
const a = await open(approved);
const again = await startGlossReview(db, writer, approved.card, repo, dir, approved.run);
answer(approved.card.id, 0, verdict({ approved: true }));
await settle(a.runId);

// A closed window is no verdict, and moves nothing.
const closed = built('closed');
const b = await open(closed);
answer(closed.card.id, 1, '');
await settle(b.runId);

// A document from a later version is no verdict, whatever it says.
const future = built('future');
const f = await open(future);
answer(future.card.id, 0, JSON.stringify({ version: 2, approved: true, round: 1, comments: [] }));
await settle(f.runId);

// Comments send the build back, with where each was written.
const commented = built('commented');
const c = await open(commented);
answer(commented.card.id, 0, verdict({
  approved: false, round: 3, page: 'http://localhost:9999/cart',
  comments: [
    { id: 'c1', kind: 'pinned', body: 'Shipping before the total.', page: 'http://localhost:9999/cart?x=1', createdAt: 1, sentIn: 3, target: { selector: '.summary > li' } },
    { id: 'c2', kind: 'general', body: '  Too much padding.  ', page: null, createdAt: 2, sentIn: 3, target: null },
  ],
}));
await settle(c.runId);
const rejection = reviewsForCard(db, commented.card.id)[0];

// A card approved with the buttons while Gloss was open is not approved twice.
const raced = built('raced');
const r = await open(raced);
const { approveStage } = await import('../review.js');
approveStage(db, writer, raced.card, repo, raced.run);
answer(raced.card.id, 0, verdict({ approved: true }));
await settle(r.runId);

// Stop from Reeve ends the round and closes the window.
const stopped = built('stopped');
const s = await open(stopped);
await runRegistry.get(s.runId)?.stop('cancelled_by_user');
await settle(s.runId);

// A repo with no dev server has nothing to open.
const bare = withServer('gloss-bare', null);
const noServer = built('no server', bare);
const refused = await startGlossReview(db, writer, noServer.card, bare, dir, noServer.run);

for (const r of runRegistry.all().filter((r) => r.kind === 'server')) await r.stop('cancelled_by_user');
const log = calls();
const closedBy = (cardId: string) => log.some((l) => l[0] === 'close' && l.includes(sessionName(cardId)));

const checks: Array<[string, boolean, string]> = [
  ['approval moves the card on', getCard(db, approved.card.id)?.stage === 'testing', String(getCard(db, approved.card.id)?.stage)],
  ['...as a verdict given in Gloss', reviewed(approved.card.id)?.meta?.['via'] === 'gloss', JSON.stringify(reviewed(approved.card.id)?.meta)],
  ['...and closes the window', closedBy(approved.card.id), ''],
  ['a second click answers with the same round', again.ok && again.reused && again.runId === a.runId, JSON.stringify(again)],
  ['the window is opened on the dev server', log.some((l) => l[0] === 'open' && /^http:\/\/localhost:\d+/.test(l[1] ?? '')), JSON.stringify(log.find((l) => l[0] === 'open'))],
  ['a closed window moves nothing', getCard(db, closed.card.id)?.stage === 'in_progress' && !reviewed(closed.card.id), ''],
  ['...and is recorded as no verdict', glossEvent(closed.card.id)?.meta?.['outcome'] === 'failed', JSON.stringify(glossEvent(closed.card.id)?.meta)],
  ['version 2 is not approval', getCard(db, future.card.id)?.stage === 'in_progress' && !reviewed(future.card.id), ''],
  ['comments send the build back', rejection?.decision === 'rejected' && getCard(db, commented.card.id)?.stage === 'in_progress', String(rejection?.decision)],
  ['...with the page and selector', rejection?.notes === '**On /cart?x=1, at `.summary > li`**\nShipping before the total.\n\n**On /cart**\nToo much padding.', JSON.stringify(rejection?.notes)],
  ['...and says the revision did not start', /^Sent back from Gloss, but the revision did not start/.test(glossEvent(commented.card.id)?.body ?? ''), String(glossEvent(commented.card.id)?.body)],
  ['...to the window too', log.some((l) => l[0] === 'ready' && l.includes(sessionName(commented.card.id))), ''],
  ['a late approval is not applied', reviewsForCard(db, raced.card.id).length === 1 && glossEvent(raced.card.id)?.meta?.['outcome'] === 'not_applied', String(glossEvent(raced.card.id)?.body)],
  ['...and its window is closed', closedBy(raced.card.id), ''],
  ['Stop is recorded as stopped', glossEvent(stopped.card.id)?.meta?.['outcome'] === 'cancelled', JSON.stringify(glossEvent(stopped.card.id)?.meta)],
  ['...and closes the window', closedBy(stopped.card.id), ''],
  ['no server command is refused', !refused.ok && refused.status === 400, JSON.stringify(refused)],
  ['the fake was on PATH', existsSync(join(dir, 'calls.log')), dir],
];

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}
console.log(failed === 0 ? '\nonly approved: true approves' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
