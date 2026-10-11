/**
 * Throwaway check on Reeve's half of a worker's permission ask, with no API
 * credit: a run row parked `asking`, a fake live session in the run registry
 * that records what it is sent, and asks opened straight on the registry, as
 * runs/claude.ts opens them. The SDK's half — that the lead takes a turn
 * while the worker's call is held — is spikes/background-agent-check.ts, D.
 *
 * What it checks:
 *
 * - Typed words go to the lead while only the worker's ask is open, and the
 *   ask stays open.
 * - With a lead question open beside it, typed words answer the question.
 * - Allow once on a worker's refusal reaches the lead as an instruction,
 *   never as the answer to the lead's own open ask.
 * - The worker's ask is answered by id from its buttons.
 *
 *   REEVE_DB=/tmp/worker-ask.db npx tsx packages/server/src/spikes/worker-ask-check.ts
 */
import { rmSync } from 'node:fs';
import { config } from '../config.js';
import { answerAsk, allowOnce, sendToCard } from '../conversation.js';
import { createCard, createRepo, getCard, insertRun } from '../db/queries.js';
import { createApp } from '../index.js';
import { askRegistry } from '../runs/asks.js';
import { runRegistry } from '../runs/registry.js';

if (!process.env.REEVE_DB) throw new Error('give this a scratch REEVE_DB');
for (const f of [config.dbFile, `${config.dbFile}-wal`, `${config.dbFile}-shm`]) rmSync(f, { force: true });

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const { db, writer } = createApp();
const repo = createRepo(db, { name: 'asks', repoPath: '/tmp/nowhere', worktreeRoot: '/tmp/nowhere-wt', defaultBranch: 'main' });
const created = createCard(db, { repoId: repo.id, title: 'Worker asks', body: '', stage: 'in_progress' });
const run = insertRun(db, {
  id: crypto.randomUUID(), cardId: created.id, kind: 'claude', stage: 'in_progress', status: 'asking',
  sessionId: crypto.randomUUID(), prompt: 'p', cwd: '/tmp/nowhere-wt', startedAt: new Date(),
});
const card = () => getCard(db, created.id)!;

// The live session: what the lead would read at its next tool boundary.
const sent: string[] = [];
runRegistry.register({ runId: run.id, cardId: created.id, kind: 'claude', send: (t) => { sent.push(t); return true; }, stop: async () => {} });

const permission = { kind: 'permission' as const, toolName: 'Bash', input: { command: 'rm -rf build' } };
const worker = askRegistry.wait(run.id, created.id, permission, 60_000, 'worker');

// 1. Only the worker's ask is open: words go to the lead.
const talk = await sendToCard(db, writer, card(), 'Is the build nearly done?');
check('words reach the lead while the worker waits', talk.ok && talk.delivered === 'live', JSON.stringify(talk));
check('the lead was sent them', sent.at(-1) === 'Is the build nearly done?', sent.at(-1));
check('and the worker\'s ask is still open', askRegistry.get(worker.ask.id) !== undefined);

// 2. A lead question beside it: words answer the question.
const question = askRegistry.wait(run.id, created.id, { kind: 'question', questions: [{ question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }] }, 60_000);
const reply = await sendToCard(db, writer, card(), 'Blue');
check('words answer the lead\'s question', reply.ok && reply.delivered === 'answered', JSON.stringify(reply));
const settled = await question.answer;
check('with the person\'s words', settled.kind === 'question' && settled.answers['Which colour?'] === 'Blue', JSON.stringify(settled));
check('and the worker\'s ask is still open', askRegistry.get(worker.ask.id) !== undefined);

// 3. Allow once on the worker's refused call, with a lead question open again.
const another = askRegistry.wait(run.id, created.id, { kind: 'question', questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }] }] }, 60_000);
writer.append(run.id, 'refused', { toolUseId: 'toolu_refused', toolName: 'Bash', input: { command: 'npm publish --dry-run' }, agent: 'worker', at: Date.now() });
writer.flush();
const allowed = await allowOnce(db, writer, card(), run.id, 'toolu_refused');
check('Allow once goes into the session', allowed.ok && allowed.delivered === 'live', JSON.stringify(allowed));
check('telling the lead to pass it to the worker', /SendMessage/.test(sent.at(-1) ?? '') && /worker/.test(sent.at(-1) ?? ''), sent.at(-1)?.slice(0, 120));
check('and the lead\'s question is not answered with it', askRegistry.get(another.ask.id) !== undefined);
askRegistry.settle(another.ask.id, { kind: 'unanswered', why: 'stopped' });

// 4. The worker's ask, from its buttons, by id.
const clicked = answerAsk(card(), worker.ask.id, { kind: 'permission', allow: true, actor: 'human' });
check('the worker\'s ask is answered by id', clicked);
const answer = await worker.answer;
check('and allowed', answer.kind === 'permission' && answer.allow, JSON.stringify(answer));

runRegistry.unregister(run.id);
writer.flush();
console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
