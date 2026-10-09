/**
 * Throwaway end-to-end check on a stage that leads a background worker,
 * through the real app and real runs: In Progress launches its worker, a
 * person's question is answered while the worker builds, a change asked for
 * mid-build reaches the worker, the lead submits only once it is done, and
 * Testing does the same. Then Stop, on a follow-up whose worker is mid-way.
 *
 * The repo's test command sleeps, so each worker takes long enough to talk
 * over. Spends real API credit (Sonnet, low effort; a dollar or two), and
 * needs a scratch board, which it fills with one repo of its own in a temp dir:
 *
 *   REEVE_DB=/tmp/worker-flow.db npx tsx packages/server/src/spikes/worker-flow-check.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiConversation, ConversationItem, ConversationRun } from '@reeve/shared';
import { config } from '../config.js';
import { cardActivity } from '../board.js';
import { getCard, latestClaudeRunForStage } from '../db/queries.js';
import { card as cardTable, repo as repoTable } from '../db/schema.js';
import { createApp } from '../index.js';

if (!process.env.REEVE_DB) throw new Error('give this a scratch REEVE_DB');
for (const f of [config.dbFile, `${config.dbFile}-wal`, `${config.dbFile}-shm`]) rmSync(f, { force: true });

const t0 = Date.now();
const note = (l: string, v: unknown) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${l.padEnd(32)}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const repoPath = mkdtempSync(join(tmpdir(), 'reeve-worker-repo-'));
const worktreeRoot = mkdtempSync(join(tmpdir(), 'reeve-worker-wt-'));
const g = (...a: string[]) => execFileSync('git', ['-C', repoPath, ...a], { encoding: 'utf8' });
g('init', '-q', '-b', 'main');
g('config', 'user.email', 't@t.t');
g('config', 'user.name', 'T');
writeFileSync(join(repoPath, 'README.md'), '# worker\n\nA tiny repo.\n');
writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ name: 'worker', type: 'module', private: true }, null, 2));
g('add', '-A');
g('commit', '-qm', 'base');

const { app, db } = createApp();
db.insert(repoTable).values({
  id: 'r1', name: 'worker', repoPath, worktreeRoot, defaultBranch: 'main',
  // Slow on purpose: the worker's test run is the stretch the person talks over.
  testCommand: 'sleep 40 && node --test',
}).run();
db.insert(cardTable).values({
  id: 'c1', repoId: 'r1', number: 1, title: 'Add a greet function', stage: 'in_progress', position: 1000,
  model: 'sonnet', effort: 'low',
  body: 'Add `greet.mjs` exporting `greet(name)`, which returns `Hello, <name>!`, and `greet.test.mjs` testing it with node:test. Commit both.',
}).run();

const api = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
};
type Stage = 'in_progress' | 'testing';
const latest = (stage: Stage) => latestClaudeRunForStage(db, 'c1', stage);
const status = (stage: Stage) => latest(stage)?.status ?? 'none';
const activity = () => cardActivity(db, getCard(db, 'c1')!).activity;
const conversation = async () => (await api('GET', '/api/cards/c1/conversation')).json as unknown as ApiConversation;
const runOf = async (stage: Stage): Promise<ConversationRun | undefined> =>
  (await conversation()).stages.find((s) => s.stage === stage)?.runs.at(-1);
type Tool = Extract<ConversationItem, { kind: 'tool' }>;
const workerIn = (run: ConversationRun | undefined): Tool | undefined =>
  run?.items.find((i): i is Tool => i.kind === 'tool' && i.agent?.type === 'worker');
const texts = (run: ConversationRun | undefined) => (run?.items ?? []).filter((i) => i.kind === 'text').map((i) => (i as { text: string }).text);
/** What the lead has said since the person's message `words`, in order. */
const repliesTo = (run: ConversationRun | undefined, words: string) => {
  const items = run?.items ?? [];
  const from = items.findIndex((i) => i.kind === 'user' && i.text === words);
  return from < 0 ? [] : items.slice(from + 1).filter((i) => i.kind === 'text').map((i) => (i as { text: string }).text);
};

async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 300_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  note('TIMED OUT', what);
  return false;
}

/** One stage, start to submit, talked to while its worker runs. */
async function stage(name: Stage, question: string, change: string | null) {
  console.log(`\n--- ${name}: lead a worker, talk over it ---`);
  await until(`${name} running`, () => ['running', 'asking'].includes(status(name)), 120_000);
  const launched = await until(`${name} worker launched`, async () => workerIn(await runOf(name))?.agent?.status === 'running');
  check(`${name}: the lead launched its worker in the background`, launched && workerIn(await runOf(name))?.agent?.background === true);
  note('worker', workerIn(await runOf(name))?.target);

  // Asked while the worker is still going; answered while it still is.
  // After its own word on launching, so that is not mistaken for the answer.
  await until(`${name} lead ends its launch turn`, async () => texts(await runOf(name)).length > 0, 60_000);
  await new Promise((r) => setTimeout(r, 3000));
  const asked = Date.now();
  const sent = await api('POST', '/api/cards/c1/messages', { text: question });
  check(`${name}: the question went into the live run`, sent.json?.['delivered'] === 'live', JSON.stringify(sent.json));
  await until(`${name} lead answers`, async () => repliesTo(await runOf(name), question).length > 0, 90_000);
  const run = await runOf(name);
  const answeredIn = (Date.now() - asked) / 1000;
  note('lead answered', `${answeredIn.toFixed(0)}s: ${repliesTo(run, question).join(' / ').slice(0, 200)}`);
  check(`${name}: the lead answered while the worker was still running`, workerIn(run)?.agent?.status === 'running', workerIn(run)?.agent?.status);
  check(`${name}: and the run never left running for it`, ['running', 'asking'].includes(status(name)), status(name));
  check(`${name}: and the card still reads running`, activity() === 'running', activity());

  if (change) {
    const relayed = await api('POST', '/api/cards/c1/messages', { text: change });
    check(`${name}: the change went into the live run`, relayed.json?.['delivered'] === 'live', JSON.stringify(relayed.json));
    const passed = await until(`${name} lead relays`, async () =>
      (await runOf(name))?.items.some((i) => i.kind === 'tool' && i.name === 'SendMessage') === true, 120_000);
    check(`${name}: the lead passed the change to the worker`, passed);
  }

  await until(`${name} finishes`, () => ['succeeded', 'failed', 'awaiting_reply', 'cancelled'].includes(status(name)), 600_000);
  if (status(name) === 'awaiting_reply') {
    note('ended awaiting a reply', texts(await runOf(name)).at(-1)?.slice(0, 300));
    await api('POST', '/api/cards/c1/messages', { text: 'Good — submit it now.' });
    await until(`${name} submits`, () => ['succeeded', 'failed'].includes(status(name)) && latest(name)?.parentRunId !== null, 600_000);
  }
  check(`${name}: the stage was submitted`, status(name) === 'succeeded', `${status(name)} ${latest(name)?.errorMessage ?? ''}`);
  const done = await runOf(name);
  const w = workerIn((await conversation()).stages.find((s) => s.stage === name)?.runs[0]);
  check(`${name}: its worker ended completed`, w?.agent?.status === 'completed', w?.agent?.status);
  check(`${name}: its steps are nested under it`, (w?.agent?.steps.length ?? 0) > 0, `${w?.agent?.steps.length} steps`);
  check(`${name}: and none leaked into the thread`, !(done?.items ?? []).some((i) => i.kind === 'tool' && i.name === 'Write' && /greet/.test(i.target)) || name === 'testing');
  note(`${name} cost`, latest(name)?.totalCostUsd);
}

const started = await api('POST', '/api/cards/c1/run');
note('start', started.json);
await stage('in_progress', 'Quick question: what is the worker doing right now? One line.', 'Also: greet should take an optional second argument, `greeting`, defaulting to "Hello". Update the test too.');

const wt = getCard(db, 'c1')!.worktreePath!;
const src = existsSync(join(wt, 'greet.mjs')) ? readFileSync(join(wt, 'greet.mjs'), 'utf8') : '';
note('greet.mjs', src.replace(/\s+/g, ' ').slice(0, 200));
check('the change reached the code', /greeting/.test(src));
const log = execFileSync('git', ['-C', wt, 'log', '--oneline', 'main..HEAD'], { encoding: 'utf8' }).trim();
check('the work was committed', log.length > 0, log.replace(/\n/g, ' | '));
check('the worker\'s brief is kept beside the stage documents', existsSync(join(wt, '.reeve/in_progress-brief.md')));
const tracked = execFileSync('git', ['-C', wt, 'ls-files', '.reeve'], { encoding: 'utf8' }).trim();
check('and .reeve/ was never committed', tracked === '', tracked);

// --- Sent back: a forked run, in a new process, leads a fresh worker ----------
console.log('\n--- in_progress: sent back for a revision ---');
const firstRun = latest('in_progress')!.id;
const rejected = await api('POST', '/api/cards/c1/review', { decision: 'rejected', notes: 'Rename greet.test.mjs to greet.spec.mjs, and make sure `node --test greet.spec.mjs` passes.' });
check('the rejection resumed the stage', rejected.json?.['ok'] === true, JSON.stringify(rejected.json));
const revised = await until('revision worker launched', async () => {
  const run = await runOf('in_progress');
  return run?.runId !== firstRun && workerIn(run) !== undefined;
}, 180_000);
check('the revision launched a fresh worker', revised);
await until('revision finishes', () => latest('in_progress')?.id !== firstRun && ['succeeded', 'failed', 'awaiting_reply', 'cancelled'].includes(status('in_progress')), 600_000);
check('the revision was submitted', status('in_progress') === 'succeeded', status('in_progress'));
check('the revision did the work', existsSync(join(wt, 'greet.spec.mjs')) && !existsSync(join(wt, 'greet.test.mjs')));
const revisionWorker = workerIn(await runOf('in_progress'));
check('its worker ended completed', revisionWorker?.agent?.status === 'completed', revisionWorker?.agent?.status);
note('revision cost', latest('in_progress')?.totalCostUsd);

// --- Testing ------------------------------------------------------------------
const approved = await api('POST', '/api/cards/c1/review', { decision: 'approved' });
check('approved into Testing', approved.json?.['toStage'] === 'testing', JSON.stringify(approved.json));
await stage('testing', 'How is verification going? One line.', null);

// --- Stop a follow-up mid-worker ------------------------------------------------
console.log('\n--- stop a follow-up while its worker runs ---');
const follow = await api('POST', '/api/cards/c1/messages', { text: 'One more thing: add a README section about greet, and run the tests again.' });
check('the follow-up resumed the conversation', follow.json?.['delivered'] === 'resumed', JSON.stringify(follow.json));
const relaunched = await until('follow-up worker launched', async () => {
  const run = (await conversation()).stages.find((s) => s.stage === 'testing')?.runs.at(-1);
  return run?.runId === latest('testing')?.id && workerIn(run)?.agent?.status === 'running';
}, 180_000);
check('the follow-up launched a fresh worker', relaunched);
const stopAt = Date.now();
const stopped = await api('POST', `/api/runs/${latest('testing')!.id}/stop`);
note('stop', stopped.status);
await until('stopped', () => status('testing') === 'cancelled', 30_000);
check('Stop ended the run, worker and all', status('testing') === 'cancelled', `${status('testing')} after ${((Date.now() - stopAt) / 1000).toFixed(1)}s`);
check('and the card no longer reads running', activity() !== 'running', activity());

// The forked session still holds an Agent call whose worker never reported.
// The next message must get a fresh worker, not a lead waiting on the dead one.
console.log('\n--- after Stop: carry on, with a fresh worker ---');
const stoppedRun = latest('testing')!.id;
const after = await api('POST', '/api/cards/c1/messages', { text: 'Carry on with the README section and the test run, please.' });
check('the message after Stop resumed the conversation', after.json?.['delivered'] === 'resumed', JSON.stringify(after.json));
const fresh = await until('worker after Stop', async () => {
  const run = (await conversation()).stages.find((s) => s.stage === 'testing')?.runs.at(-1);
  return (run?.runId !== stoppedRun && workerIn(run) !== undefined) || (latest('testing')?.id !== stoppedRun && ['awaiting_reply', 'failed', 'succeeded'].includes(status('testing')));
}, 180_000);
const afterRun = (await conversation()).stages.find((s) => s.stage === 'testing')?.runs.at(-1);
check('the lead launched a fresh worker rather than wait on the stopped one', fresh && workerIn(afterRun) !== undefined, `${status('testing')}: ${texts(afterRun).at(-1)?.slice(0, 200) ?? ''}`);
await until('carried-on run ends', () => latest('testing')?.id !== stoppedRun && ['succeeded', 'failed', 'awaiting_reply', 'cancelled'].includes(status('testing')), 600_000);
check('and the stage was submitted again', status('testing') === 'succeeded', status('testing'));
const readme = existsSync(join(wt, 'README.md')) ? readFileSync(join(wt, 'README.md'), 'utf8') : '';
check('with the README section', /greet/i.test(readme));

console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
