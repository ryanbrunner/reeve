/**
 * Throwaway check on a review in Crit: that an empty round approves the stage
 * through the same `approveStage` the button uses, that Crit's own
 * `approved: false` line vetoes an otherwise-empty approval, that comments
 * format with their file, line and anchor and are delivered into the card's
 * conversation, that a second round does not resend a comment id a prior
 * round already recorded, that a verdict read back after the card has
 * already moved is filed as not applied, and that stopping the review from
 * Reeve is recorded as cancelled.
 *
 * Crit itself is not needed. A fake `crit` goes first on PATH: it logs each
 * call, blocks the review command (`crit plan …`) until this script writes
 * the verdict it should print, and answers `crit comments --json` from a file
 * this script writes for the session's slug. The repo is not a git repo, so
 * an approval's next stage never actually starts a run, and no Claude run is
 * ever made — delivering comments is modelled by registering a fake "Claude
 * is listening" run directly in `runRegistry`, the same thing a live session
 * looks like to `sendToCard`, rather than by paying for a real one. Costs
 * nothing to run.
 *
 *   REEVE_DB=/tmp/crit-check.db npx tsx packages/server/src/spikes/crit-check.ts
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '../index.js';
import { cardEventsFor, createCard, createRepo, eventsSince, getCard, insertRun, setRunStatus } from '../db/queries.js';
import { card as cardTable, type Repo } from '../db/schema.js';
import { startCritReview } from '../crit.js';
import { approveStage } from '../review.js';
import { runRegistry } from '../runs/registry.js';

// Mirrors crit.ts's own PLAN_PATH, which is not exported: there is nothing to
// import, just a place in the worktree every plan review reads from.
const PLAN_PATH = '.reeve/plan.md';

const dir = mkdtempSync(join(tmpdir(), 'crit-check-'));
mkdirSync(join(dir, '.reeve'), { recursive: true });
writeFileSync(join(dir, PLAN_PATH), '# Plan\n\nShip it.\n');

writeFileSync(join(dir, 'crit'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(args) + '\\n');

if (args[0] === '--version') process.exit(0);

if (args[0] === 'comments') {
  const key = args.includes('--plan') ? args[args.indexOf('--plan') + 1] : args[args.indexOf('--session') + 1];
  const file = path.join(dir, key + '.comments.json');
  process.stdout.write(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '[]');
  process.exit(0);
}

// \`crit plan --name <slug> <path>\`: blocks until this script writes the
// verdict it should print, same shape as the fake gloss's wait file.
const name = args[args.indexOf('--name') + 1];
console.log(\`Started crit daemon at http://127.0.0.1:4100 (session \${name})\`);
const file = path.join(dir, name + '.finish');
const poll = setInterval(() => {
  if (!fs.existsSync(file)) return;
  clearInterval(poll);
  const { exit, approved } = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (approved !== undefined) console.log(\`approved: \${approved}\`);
  process.exit(exit);
}, 50);
`);
chmodSync(join(dir, 'crit'), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;

const { db, writer } = createApp();

const repo = createRepo(db, {
  name: `crit-check-${Date.now()}`,
  // Not a git repo: whatever an approval would start next fails to start, and
  // no Claude run is ever made.
  repoPath: dir, worktreeRoot: dir, defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null,
});

/** A Planning card whose plan is waiting for review. */
function built(title: string) {
  const card = createCard(db, { title, repoId: repo.id, stage: 'planning' });
  db.update(cardTable).set({ worktreePath: dir }).where(eq(cardTable.id, card.id)).run();
  const run = insertRun(db, {
    id: crypto.randomUUID(), cardId: card.id, kind: 'claude', stage: 'planning', status: 'running', cwd: dir,
  });
  setRunStatus(db, run.id, { status: 'succeeded', structuredOutput: { summary: 's', questions: [] } });
  return { card: getCard(db, card.id)!, run };
}

/**
 * Registers a fake "Claude is listening" run, the same shape `sendToCard`
 * finds for a live session, without starting a real one: a running row with
 * no task, so `liveStageRun` reads it, and a `send` in `runRegistry` that
 * always accepts, so delivery succeeds without a worktree or an SDK call.
 */
function listening(cardId: string) {
  const run = insertRun(db, { id: crypto.randomUUID(), cardId, kind: 'claude', stage: 'planning', status: 'running', cwd: dir });
  runRegistry.register({ runId: run.id, kind: 'claude', cardId, send: () => true, stop: async () => {} });
  return run.id;
}

const calls = () => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
/** The slug the last `crit plan --name <slug> …` call opened, read back rather than recomputed. */
function lastSlug(): string {
  const log = calls();
  const call = log.filter((l) => l[0] === 'plan').at(-1);
  if (!call) throw new Error('no plan call logged');
  return call[call.indexOf('--name') + 1]!;
}
const finish = (slug: string, body: { exit: number; approved?: boolean }) =>
  writeFileSync(join(dir, `${slug}.finish`), JSON.stringify(body));
const comments = (slug: string, body: unknown) => writeFileSync(join(dir, `${slug}.comments.json`), JSON.stringify(body));
const critEvents = (cardId: string) => cardEventsFor(db, cardId).filter((e) => e.kind === 'crit_reviewed');
const reviewed = (cardId: string) => cardEventsFor(db, cardId).find((e) => e.kind === 'reviewed');
const userMessages = (runId: string) => eventsSince(db, runId, 0).filter((e) => e.kind === 'user_message').map((e) => (JSON.parse(e.payload) as { text: string }).text);

async function settle(runId: string) {
  while (runRegistry.get(runId)) await new Promise((r) => setTimeout(r, 50));
  // The verdict is applied after the run ends, over a few awaits.
  await new Promise((r) => setTimeout(r, 500));
}

// An empty round approves the plan, the same way the Approve button does.
const approved = built('approved');
const a = await startCritReview(db, writer, approved.card, dir, 'plan');
if (!a.ok) throw new Error(`approved: ${a.error}`);
finish(lastSlug(), { exit: 0 });
await settle(a.runId);

// Crit's own `approved: false` vetoes an otherwise-empty approval: it saw
// comments Reeve could not read back, so nothing is approved on its say.
const vetoed = built('vetoed');
const v = await startCritReview(db, writer, vetoed.card, dir, 'plan');
if (!v.ok) throw new Error(`vetoed: ${v.error}`);
finish(lastSlug(), { exit: 0, approved: false });
await settle(v.runId);

// Comments send the plan back, with their file, line and anchor, to whatever
// is listening on the card right now — and a second round does not resend an
// id a prior round already recorded.
const commented = built('commented');
const listen = listening(commented.card.id);
const c1 = await startCritReview(db, writer, commented.card, dir, 'plan');
if (!c1.ok) throw new Error(`commented round 1: ${c1.error}`);
const slug1 = lastSlug();
comments(slug1, [
  { id: 'c1', body: 'Shipping before the total.', start_line: 12, anchor: 'Rollout plan', quote: 'Ship it carefully.' },
  { id: 'c2', body: '  Too much padding.  ', scope: 'review' },
]);
finish(slug1, { exit: 0 });
await settle(c1.runId);

const c2 = await startCritReview(db, writer, commented.card, dir, 'plan');
if (!c2.ok) throw new Error(`commented round 2: ${c2.error}`);
const slug2 = lastSlug();
comments(slug2, [
  { id: 'c1', body: 'Shipping before the total, again.', scope: 'review' },
  { id: 'c3', body: 'New comment about the hero image.', scope: 'review' },
]);
finish(slug2, { exit: 0 });
await settle(c2.runId);

// A verdict read back after the card has already moved on is not a second
// approval: it is filed as not applied, and changes nothing.
const raced = built('raced');
const r = await startCritReview(db, writer, raced.card, dir, 'plan');
if (!r.ok) throw new Error(`raced: ${r.error}`);
approveStage(db, writer, raced.card, repo, raced.run);
finish(lastSlug(), { exit: 0, approved: true });
await settle(r.runId);

// Stop from Reeve ends the review and is recorded as cancelled, not failed.
const stopped = built('stopped');
const s = await startCritReview(db, writer, stopped.card, dir, 'plan');
if (!s.ok) throw new Error(`stopped: ${s.error}`);
await runRegistry.get(s.runId)?.stop('cancelled_by_user');
await settle(s.runId);

runRegistry.unregister(listen);

// `cardEventsFor` reads newest first, so the two rounds come back reversed.
const commentedEvents = critEvents(commented.card.id);
const round1 = commentedEvents[1];
const round2 = commentedEvents[0];
const round1Messages = userMessages(listen);

const expectedNotes1 =
  '**Line 12 of .reeve/plan.md, under “Rollout plan”**\n> Ship it carefully.\nShipping before the total.\n\n' +
  '**On the plan as a whole**\nToo much padding.';
const expectedNotes2 = '**On the plan as a whole**\nNew comment about the hero image.';

const checks: Array<[string, boolean, string]> = [
  ['an empty round approves the plan', getCard(db, approved.card.id)?.stage === 'in_progress', String(getCard(db, approved.card.id)?.stage)],
  ['...as a verdict given in Crit', reviewed(approved.card.id)?.meta?.['via'] === 'crit', JSON.stringify(reviewed(approved.card.id)?.meta)],
  ['approved: false vetoes an empty round', getCard(db, vetoed.card.id)?.stage === 'planning' && !reviewed(vetoed.card.id), ''],
  ['...and is recorded as failed, not approved', critEvents(vetoed.card.id)[0]?.meta?.['outcome'] === 'failed', JSON.stringify(critEvents(vetoed.card.id)[0]?.meta)],
  ['comments send the plan back', round1?.meta?.['outcome'] === 'sent' && getCard(db, commented.card.id)?.stage === 'planning', JSON.stringify(round1?.meta)],
  ['...formatted with file, line and anchor, to whatever is listening', round1Messages[0] === `**2 comments on the plan**\n\n${expectedNotes1}`, JSON.stringify(round1Messages[0])],
  ['...recording the ids sent', JSON.stringify(round1?.meta?.['sentIds']) === JSON.stringify(['c1', 'c2']), JSON.stringify(round1?.meta?.['sentIds'])],
  ['a second round skips an id already sent', round2?.meta?.['outcome'] === 'sent' && JSON.stringify(round2?.meta?.['sentIds']) === JSON.stringify(['c3']), JSON.stringify(round2?.meta)],
  ['...and sends only the new comment', round1Messages[1] === `**1 comment on the plan**\n\n${expectedNotes2}`, JSON.stringify(round1Messages[1])],
  ['a late verdict after the card moved is not applied', critEvents(raced.card.id)[0]?.meta?.['outcome'] === 'not_applied', JSON.stringify(critEvents(raced.card.id)[0]?.meta)],
  ['...and the card is not moved twice', getCard(db, raced.card.id)?.stage === 'in_progress', String(getCard(db, raced.card.id)?.stage)],
  ['Stop is recorded as cancelled', critEvents(stopped.card.id)[0]?.meta?.['outcome'] === 'cancelled', JSON.stringify(critEvents(stopped.card.id)[0]?.meta)],
  ['the fake was on PATH', existsSync(join(dir, 'calls.log')), dir],
];

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}
console.log(failed === 0 ? '\nonly an empty round, or one Crit could not veto, approves' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
