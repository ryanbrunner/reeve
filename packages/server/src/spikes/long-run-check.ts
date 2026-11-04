/**
 * Throwaway check on a long run's transcript, with no API credit: a run with
 * thousands of events, its conversation projected as events keep landing (a
 * live run's projector is kept between requests and must match a fresh fold),
 * and its SSE replay from the start, which reads a page at a time.
 *
 *   REEVE_DB=/tmp/long-run.db npx tsx packages/server/src/spikes/long-run-check.ts
 */
import { rmSync } from 'node:fs';
import { RunProjector, type ApiConversation } from '@reeve/shared';
import { config } from '../config.js';
import { createCard, createRepo, insertEvents, insertRun, setRunStatus } from '../db/queries.js';
import { createApp } from '../index.js';

if (!process.env.REEVE_DB) throw new Error('give this a scratch REEVE_DB');
for (const f of [config.dbFile, `${config.dbFile}-wal`, `${config.dbFile}-shm`]) rmSync(f, { force: true });

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const { app, db } = createApp();
const repo = createRepo(db, { name: 'long', repoPath: '/tmp/nowhere', worktreeRoot: '/tmp/nowhere-wt', defaultBranch: 'main' });
const card = createCard(db, { repoId: repo.id, title: 'Long run', body: '', stage: 'in_progress' });
const run = insertRun(db, {
  id: crypto.randomUUID(), cardId: card.id, kind: 'claude', stage: 'in_progress', status: 'running',
  sessionId: crypto.randomUUID(), prompt: 'The brief.', cwd: '/tmp/nowhere-wt', startedAt: new Date(),
});

let seq = 0;
const rows: Parameters<typeof insertEvents>[1] = [];
const add = (n: number) => {
  for (let i = 0; i < n; i++) {
    const id = `toolu_${seq}`;
    rows.push({ runId: run.id, seq: ++seq, kind: 'assistant', sdkUuid: null, at: new Date(), payload: JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { id: `m${seq}`, content: [{ type: 'text', text: `Step ${seq}` }, { type: 'tool_use', id, name: 'Read', input: { file_path: `f${seq}.ts` } }] } }) });
    rows.push({ runId: run.id, seq: ++seq, kind: 'tool_result', sdkUuid: null, at: new Date(), payload: JSON.stringify({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(800) }] } }) });
  }
  // In batches, as the event writer itself writes: one statement per row set.
  while (rows.length) insertEvents(db, rows.splice(0, 100));
};

const conversation = async () => {
  const res = await app.request(`/api/cards/${card.id}/conversation`);
  return ((await res.json()) as ApiConversation).stages.find((s) => s.stage === 'in_progress')!.runs[0]!;
};
const fresh = () => {
  const p = new RunProjector('The brief.');
  const all = db.$client.prepare('select seq, kind, payload, at from run_event where run_id = ? order by seq').all(run.id) as Array<{ seq: number; kind: string; payload: string; at: number }>;
  for (const e of all) p.add({ seq: e.seq, kind: e.kind, payload: e.payload, at: e.at });
  return p;
};

add(3000);
let t = performance.now();
const first = await conversation();
const firstMs = performance.now() - t;
check('a 6,000-event live run projects whole', first.lastSeq === seq && first.items.length === fresh().items.length, `${first.items.length} items, lastSeq ${first.lastSeq}, ${firstMs.toFixed(0)}ms`);

add(50);
t = performance.now();
const second = await conversation();
const secondMs = performance.now() - t;
check('a refetch folds in only what is new', second.lastSeq === seq && second.items.length === fresh().items.length, `${second.items.length} items in ${secondMs.toFixed(0)}ms vs ${firstMs.toFixed(0)}ms the first time`);
check('and matches a fresh fold item for item', JSON.stringify(second.items) === JSON.stringify(fresh().items.map((i) => i)));

setRunStatus(db, run.id, { status: 'succeeded', finishedAt: new Date() });
const ended = await conversation();
check('once ended, it is still whole', ended.status === 'succeeded' && ended.items.length === fresh().items.length);

// SSE replay from the start, across pages.
const res = await app.request(`/api/runs/${run.id}/events?since=0`);
const text = await res.text();
const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
const inOrder = ids.every((id, i) => i === 0 || id === ids[i - 1]! + 1);
check('SSE replays every event, in order, across pages', ids.length === seq && inOrder && ids[0] === 1, `${ids.length} of ${seq}`);
check('and ends the stream', /event: end/.test(text));

console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
