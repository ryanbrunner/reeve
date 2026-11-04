/**
 * Throwaway check on how the conversation endpoint holds up on a long run:
 * one finished In Progress run of a few thousand events, the size of a big
 * card's, projected cold and then again, with the size of what the modal is
 * sent. No API credit; a scratch board.
 *
 *   REEVE_DB=/tmp/conv-size.db npx tsx packages/server/src/spikes/conversation-size-check.ts
 */
import { rmSync } from 'node:fs';
import { config } from '../config.js';
import { conversationFor } from '../conversation.js';
import { openDatabase } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { createCard, getCard, insertEvents, insertRun } from '../db/queries.js';

if (!process.env.REEVE_DB) throw new Error('give this a scratch REEVE_DB');
for (const f of [config.dbFile, `${config.dbFile}-wal`, `${config.dbFile}-shm`]) rmSync(f, { force: true });
const db = openDatabase(config.dbFile);
runMigrations(db);

const card = createCard(db, { title: 'A long one', stage: 'in_progress' });
const run = insertRun(db, { id: crypto.randomUUID(), cardId: card.id, kind: 'claude', stage: 'in_progress', status: 'succeeded', sessionId: crypto.randomUUID(), prompt: 'x'.repeat(8000), cwd: '/tmp' });
const CALLS = 2000;
const output = 'line of tool output that goes on for a while\n'.repeat(120); // ~5.5 KB
const rows = [];
let seq = 1;
for (let i = 0; i < CALLS; i++) {
  const id = `toolu_${i}`;
  rows.push({ runId: run.id, seq: seq++, kind: 'assistant', sdkUuid: null, payload: JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: `Step ${i}: reading the next file.` }, { type: 'tool_use', id, name: 'Read', input: { file_path: `src/file${i}.ts` } }] } }) });
  rows.push({ runId: run.id, seq: seq++, kind: 'tool_result', sdkUuid: null, payload: JSON.stringify({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: output }] } }) });
}
insertEvents(db, rows);

const fresh = getCard(db, card.id)!;
let t = performance.now();
const cold = conversationFor(db, fresh);
const coldMs = performance.now() - t;
t = performance.now();
conversationFor(db, fresh);
const warmMs = performance.now() - t;
const bytes = JSON.stringify(cold).length;
console.log(`events            : ${rows.length}`);
console.log(`cold projection   : ${coldMs.toFixed(0)} ms`);
console.log(`cached projection : ${warmMs.toFixed(1)} ms`);
console.log(`response size     : ${(bytes / 1024 / 1024).toFixed(2)} MB`);
