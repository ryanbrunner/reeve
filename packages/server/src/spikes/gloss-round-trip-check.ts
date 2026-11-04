/**
 * Throwaway end-to-end check on the rounds a review in Gloss takes after a
 * revision — the gap gloss-check.ts's own header names, which a fake repo
 * cannot close: a revision run can only truly finish, rather than just fail
 * to start, in a real git worktree with a real Agent SDK call.
 *
 * Unlike gloss-check.ts, the repo here is a real tiny git checkout, so
 * `sendBackForRevision` actually starts a run. `gloss` itself is still fake
 * — the same binary gloss-check.ts uses, logging each call and blocking
 * `gloss wait` until this script writes the verdict it should print — so
 * nothing here depends on it being installed. The build Gloss reviews is a
 * real submission too, not a fabricated row: `sendBackForRevision`'s own
 * `done` only resolves when the revision truly finishes if the run it is
 * sent from has a session to resume — a fabricated row with none takes the
 * cold-start path instead, whose result carries no `done` at all, and
 * `handBack` would then run against a build still mid-revision and read it as
 * stale. A real first submission is the cheap way around that seam without
 * widening it in production code for a spike's sake.
 *
 * So two low-effort Claude turns are real: the build, and the revision round
 * one's comments send it back for. Once the revision submits, `handBack` is
 * expected to tell the window `ready` with a summary of it and start the next
 * round automatically, with no one pressing anything in Reeve; approving that
 * round is expected to close the loop the same way an approval always does.
 *
 * Spends real API credit (Sonnet, low effort; two small turns, well under a
 * dollar), and needs a scratch board:
 *
 *   REEVE_DB=/tmp/gloss-round-trip.db npx tsx packages/server/src/spikes/gloss-round-trip-check.ts
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { cardEventsFor, getCard, latestClaudeRunForStage, listRepos, liveTaskRun } from '../db/queries.js';
import { card as cardTable, repo as repoTable } from '../db/schema.js';
import { GLOSS_TASK, startGlossReview } from '../gloss.js';
import { createApp } from '../index.js';
import { runRegistry } from '../runs/registry.js';
import { startStage } from '../startStage.js';

if (!process.env.REEVE_DB) throw new Error('give this a scratch REEVE_DB');
for (const f of [config.dbFile, `${config.dbFile}-wal`, `${config.dbFile}-shm`]) rmSync(f, { force: true });

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// A real tiny repo, with the card's own worktree already cut — empty, so the
// first real turn below is what actually builds something in it.
const repoPath = mkdtempSync(join(tmpdir(), 'reeve-gloss-rt-repo-'));
const worktreeRoot = mkdtempSync(join(tmpdir(), 'reeve-gloss-rt-wt-'));
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
git(repoPath, 'init', '-q', '-b', 'main');
git(repoPath, 'config', 'user.email', 't@t.t');
git(repoPath, 'config', 'user.name', 'T');
writeFileSync(join(repoPath, 'README.md'), '# gloss round trip\n');
git(repoPath, 'add', '-A');
git(repoPath, 'commit', '-qm', 'base');
const base = git(repoPath, 'rev-parse', 'HEAD');

const wt = join(worktreeRoot, 'c1');
git(repoPath, 'worktree', 'add', '-q', '-b', 'reeve/c1-notes', wt);
git(wt, 'config', 'user.email', 't@t.t');
git(wt, 'config', 'user.name', 'T');

// The fake `gloss`: logs every call, and blocks `wait` until this script
// writes the verdict it should print. Identical to gloss-check.ts's own.
const fakeDir = mkdtempSync(join(tmpdir(), 'reeve-gloss-rt-fake-'));
writeFileSync(join(fakeDir, 'gloss'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = ${JSON.stringify(fakeDir)};
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
chmodSync(join(fakeDir, 'gloss'), 0o755);
process.env.PATH = `${fakeDir}:${process.env.PATH}`;

const { db, writer } = createApp();
db.insert(repoTable).values({
  id: 'r1', name: 'gloss-rt', repoPath, worktreeRoot, defaultBranch: 'main',
  serverCommand: `node -e "require('node:http').createServer((q,s)=>s.end('ok')).listen({{port}})"`,
}).run();
db.insert(cardTable).values({
  id: 'c1', repoId: 'r1', number: 1, title: 'Add NOTES.md', stage: 'in_progress', position: 1000,
  model: 'sonnet', effort: 'low',
  body: 'Create a file named NOTES.md with exactly one line: "First draft." Commit it, then call submit_in_progress with a one-sentence summary.',
  worktreePath: wt, branchName: 'reeve/c1-notes', baseSha: base,
}).run();

const repo = listRepos(db).find((r) => r.id === 'r1')!;
const calls = () => readFileSync(join(fakeDir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
const sessionName = 'reeve-c1-in_progress'; // reeve-${cardId.slice(0,8)}-${stage}, and 'c1' is already 8 chars or fewer
const answer = (exit: number, stdout: string) => writeFileSync(join(fakeDir, `${sessionName}.wait`), JSON.stringify({ exit, stdout }));
const verdict = (v: Record<string, unknown>) => JSON.stringify({ version: 1, round: 1, page: null, comments: [], ...v });

async function until(what: string, cond: () => boolean, ms = 180_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`TIMED OUT waiting for: ${what}`);
  return false;
}

console.log('--- first real turn: the build Gloss is going to review ---');
const started = await startStage(db, writer, getCard(db, 'c1')!, repo);
if (!started.ok) throw new Error(`the build did not start: ${started.error} (${started.detail})`);
await until('the build to submit', () => latestClaudeRunForStage(db, 'c1', 'in_progress')?.status === 'succeeded', 60_000);
const deliverable = latestClaudeRunForStage(db, 'c1', 'in_progress');
check('the build submitted, with a session to resume', deliverable?.status === 'succeeded' && Boolean(deliverable.sessionId), String(deliverable?.sessionId));

console.log('\n--- round one: comments send the build back ---');
const opened = await startGlossReview(db, writer, getCard(db, 'c1')!, repo, wt, deliverable!);
if (!opened.ok) throw new Error(`gloss did not open: ${opened.error} (${opened.detail ?? ''})`);
check('the window opened on the dev server', /^http:\/\/localhost:\d+/.test(opened.url ?? ''), opened.url ?? '');
const round1Id = opened.runId;

answer(0, verdict({
  approved: false, round: 1,
  comments: [{ body: 'Add a second line, on its own: "Reviewed."', page: null, target: null }],
}));

// The fake `gloss wait` process exits almost at once; what takes real time is
// the Claude turn the comments start, which `finishRound` awaits before it
// hands the window back. Watched for on the card's own state, not the shell
// run, which is long gone by then.
await until('the revision to start', () => latestClaudeRunForStage(db, 'c1', 'in_progress')?.id !== deliverable!.id, 60_000);
const revisionRun = latestClaudeRunForStage(db, 'c1', 'in_progress');
check('a revision run started', Boolean(revisionRun && revisionRun.id !== deliverable!.id), String(revisionRun?.id));
await until('the revision to finish', () => ['succeeded', 'failed', 'awaiting_reply'].includes(latestClaudeRunForStage(db, 'c1', 'in_progress')?.status ?? ''));
const finished = latestClaudeRunForStage(db, 'c1', 'in_progress');
check('the revision submitted', finished?.status === 'succeeded', finished?.status);
const notes = existsSync(join(wt, 'NOTES.md')) ? readFileSync(join(wt, 'NOTES.md'), 'utf8') : '';
check('the comment was acted on', /reviewed/i.test(notes), notes.trim());
const log = git(wt, 'log', '--oneline', 'main..HEAD');
check('and committed', log.split('\n').length >= 2, log);

console.log('\n--- the loop: handed back, and a new round starts on its own ---');
const round2 = await until('a second round to start', () => {
  const live = liveTaskRun(db, 'c1', GLOSS_TASK);
  return Boolean(live && live.id !== round1Id);
});
check('a second round started automatically', round2);
const readyCall = calls().find((l) => l[0] === 'ready' && l.includes(sessionName));
check('the window was told ready, with a summary', Boolean(readyCall) && typeof readyCall?.[1] === 'string' && readyCall[1].length > 0, JSON.stringify(readyCall));
const reviewedEvents = cardEventsFor(db, 'c1').filter((e) => e.kind === 'gloss_reviewed');
check('nothing was recorded as a failure in between', !reviewedEvents.some((e) => e.meta?.['outcome'] === 'failed'), JSON.stringify(reviewedEvents.map((e) => e.meta)));

console.log('\n--- round two: approving closes the loop ---');
const live2 = liveTaskRun(db, 'c1', GLOSS_TASK);
if (!live2) throw new Error('no second round to approve');
answer(0, verdict({ approved: true, round: 2 }));
await until('the card to move on', () => getCard(db, 'c1')?.stage === 'testing', 15_000);
check('approval in the second round moved the card to Testing', getCard(db, 'c1')?.stage === 'testing', String(getCard(db, 'c1')?.stage));
check('...as a verdict given in Gloss', cardEventsFor(db, 'c1').find((e) => e.kind === 'reviewed')?.meta?.['via'] === 'gloss');
const closed = calls().some((l) => l[0] === 'close' && l.includes(sessionName));
check('...and closed the window', closed);

for (const r of runRegistry.all().filter((r) => r.kind === 'server')) await r.stop('cancelled_by_user');

console.log(`\n${failed === 0 ? 'the loop after a revision runs itself, start to close' : `${failed} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
