/**
 * Throwaway end-to-end check on a stage as a conversation, through the real
 * app and real runs: Claude asking in plain text and the person replying, the
 * plan submitted through its tool, approval moving the card on, a message
 * interjected while In Progress works, and a question parked with
 * AskUserQuestion and answered from its buttons.
 *
 * Spends real API credit (Sonnet, low effort; about a dollar), and needs a
 * scratch board, which it fills with one repo of its own in a temp dir:
 *
 *   REEVE_DB=/tmp/conv-flow.db npx tsx packages/server/src/spikes/conversation-flow-check.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiConversation } from '@reeve/shared';
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

// A repo of its own: one README, on main.
const repoPath = mkdtempSync(join(tmpdir(), 'reeve-flow-repo-'));
const worktreeRoot = mkdtempSync(join(tmpdir(), 'reeve-flow-wt-'));
const g = (...a: string[]) => execFileSync('git', ['-C', repoPath, ...a], { encoding: 'utf8' });
g('init', '-q', '-b', 'main');
g('config', 'user.email', 't@t.t');
g('config', 'user.name', 'T');
writeFileSync(join(repoPath, 'README.md'), '# flow\n\nA tiny repo.\n');
g('add', '-A');
g('commit', '-qm', 'base');

const { app, db } = createApp();
db.insert(repoTable).values({ id: 'r1', name: 'flow', repoPath, worktreeRoot, defaultBranch: 'main' }).run();
db.insert(cardTable).values({
  id: 'c1', repoId: 'r1', number: 1, title: 'Add a CONTRIBUTING.md', stage: 'planning', position: 1000,
  model: 'sonnet', effort: 'low',
  body: [
    'Add a CONTRIBUTING.md at the repo root with a single short line of guidance.',
    '',
    'This is a test of the conversation itself, so follow these exactly:',
    '- In Planning: before anything else, ask me in plain text what the one line should say, and end your turn. Do not use AskUserQuestion for this. Then plan using my answer, with one step.',
    '- In In Progress: before writing the file, use AskUserQuestion once to ask whether the line should be bold, with the options "Bold" and "Plain". Then write it that way and commit it.',
  ].join('\n'),
}).run();

const api = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
};
const status = (stage: 'planning' | 'in_progress') => latestClaudeRunForStage(db, 'c1', stage)?.status ?? 'none';
const activity = () => cardActivity(db, getCard(db, 'c1')!).activity;

async function until(what: string, cond: () => boolean, ms = 240_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  note('TIMED OUT', what);
  return false;
}
const conversation = async () => (await api('GET', '/api/cards/c1/conversation')).json as unknown as ApiConversation;

// --- Planning: Claude asks, the person answers -----------------------------
console.log('\n--- planning: a question in plain text, then a reply ---');
const started = await api('POST', '/api/cards/c1/run');
note('start', started);
await until('planning turn ends', () => ['awaiting_reply', 'succeeded', 'failed'].includes(status('planning')));
check('planning ended its turn waiting on a reply', status('planning') === 'awaiting_reply', status('planning'));
check('the card reads needs_input', activity() === 'needs_input', activity());
let conv = await conversation();
const firstRun = conv.stages[0]!.runs[0]!;
check('its conversation opens with the stage prompt', firstRun.items[0]?.kind === 'prompt');
note('Claude asked', firstRun.items.filter((i) => i.kind === 'text').map((i) => (i as { text: string }).text).join(' / ').slice(0, 200));

const reply = await api('POST', '/api/cards/c1/messages', { text: 'The line should say: Run the tests before you push.' });
check('reply resumes the conversation', reply.json?.['delivered'] === 'resumed', JSON.stringify(reply.json));
await until('plan submitted', () => ['awaiting_reply', 'succeeded', 'failed'].includes(status('planning')) && latestClaudeRunForStage(db, 'c1', 'planning')?.id !== firstRun.runId);
check('the plan was submitted', status('planning') === 'succeeded', status('planning'));
check('the card reads needs_review', activity() === 'needs_review', activity());
check('.reeve/plan.md written', existsSync(join(getCard(db, 'c1')!.worktreePath ?? '/nope', '.reeve/plan.md')));
conv = await conversation();
const second = conv.stages[0]!.runs[1];
check('the follow-up run opens with the person\'s words', second?.items[0]?.kind === 'user', second?.items[0]?.kind);
check('and has no stage prompt of its own', !second?.items.some((i) => i.kind === 'prompt'));
check('and ends in a submitted item', second?.items.some((i) => i.kind === 'submitted') === true);
check('its cost is its own, not its parent\'s too', (second?.costUsd ?? 0) > 0 && (second?.costUsd ?? 1) < 1, String(second?.costUsd));

// --- Approve: the card moves on and In Progress starts ----------------------
console.log('\n--- approve, then talk to In Progress while it works ---');
const approved = await api('POST', '/api/cards/c1/review', { decision: 'approved' });
check('approved and moved', approved.json?.['toStage'] === 'in_progress', JSON.stringify(approved.json));
await until('in progress running', () => ['running', 'asking'].includes(status('in_progress')), 60_000);

// The AskUserQuestion park.
await until('in progress asks', () => status('in_progress') === 'asking' || ['succeeded', 'failed', 'awaiting_reply'].includes(status('in_progress')));
check('the run parked on its question', status('in_progress') === 'asking', status('in_progress'));
check('the card reads needs_input while it waits', activity() === 'needs_input', activity());
conv = await conversation();
const ipRun = conv.stages[1]!.runs.at(-1)!;
const ask = ipRun.items.find((i) => i.kind === 'ask' && i.outcome === null) as Extract<ApiConversation['stages'][number]['runs'][number]['items'][number], { kind: 'ask' }> | undefined;
check('the conversation shows the pending ask', Boolean(ask?.askId));
const q = ask?.request.kind === 'question' ? ask.request.questions[0] : undefined;
note('question', q);

// Interject while it is parked? No — answer it, then interject while it works.
const answered = await api('POST', `/api/cards/c1/asks/${ask?.askId}`, { answers: { [q?.question ?? '']: 'Bold' } });
check('the answer is taken', answered.status === 200, JSON.stringify(answered.json));
await until('back to running', () => status('in_progress') !== 'asking', 10_000);

const interject = await api('POST', '/api/cards/c1/messages', { text: 'Also add a second line, on its own: "Be kind."' });
note('interject', interject.json);
check('the interjection went into the live run', interject.json?.['delivered'] === 'live' || interject.json?.['delivered'] === 'resumed', JSON.stringify(interject.json));
await until('in progress finishes', () => ['succeeded', 'failed', 'awaiting_reply'].includes(status('in_progress')));
note('in progress ended', status('in_progress'));
if (status('in_progress') === 'awaiting_reply') {
  // It may answer the interjection before submitting; ask it to finish.
  await api('POST', '/api/cards/c1/messages', { text: 'Good — submit it now.' });
  await until('in progress submits', () => latestClaudeRunForStage(db, 'c1', 'in_progress')?.status === 'succeeded' || latestClaudeRunForStage(db, 'c1', 'in_progress')?.status === 'failed');
}
check('the implementation was submitted', status('in_progress') === 'succeeded', status('in_progress'));
const wt = getCard(db, 'c1')!.worktreePath!;
const contributing = existsSync(join(wt, 'CONTRIBUTING.md')) ? readFileSync(join(wt, 'CONTRIBUTING.md'), 'utf8') : '';
note('CONTRIBUTING.md', contributing.trim());
check('the answer was used (bold)', /\*\*|__/.test(contributing));
check('the interjection was used', /be kind/i.test(contributing));
const log = execFileSync('git', ['-C', wt, 'log', '--oneline', 'main..HEAD'], { encoding: 'utf8' }).trim();
check('and it was committed', log.length > 0, log);

conv = await conversation();
const kinds = conv.stages[1]!.runs.flatMap((r) => r.items.map((i) => i.kind));
note('in progress items', kinds.join(','));
check('the live message is in the conversation', conv.stages[1]!.runs.some((r) => r.items.some((i) => i.kind === 'user' && i.live)));
check('the answered ask is in the conversation', conv.stages[1]!.runs.some((r) => r.items.some((i) => i.kind === 'ask' && i.outcome?.kind === 'question')));

console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
