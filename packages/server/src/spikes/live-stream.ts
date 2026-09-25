/**
 * Throwaway check on the stream the card modal reads while Claude works.
 *
 * Two things, both of which were typecheck-only until something drove them:
 * that `?since=live` really does skip the replay and survive a reconnect, and
 * that the one line the modal shows can actually be found in a real SDK
 * message rather than in a shape someone imagined.
 */
import { describeMessage, nextThought, type Thought } from '@reeve/shared';
import { createApp } from '../index.js';
import { createCard, createRepo, insertRun } from '../db/queries.js';
import { EventWriter } from '../runs/events.js';

const { app, db } = createApp();
const writer = new EventWriter(db);

const repo = createRepo(db, {
  name: `live-${Date.now()}`, repoPath: '/tmp/x', worktreeRoot: '/tmp/x', defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null, maxBudgetUsd: null,
});
const card = createCard(db, { title: 'live', repoId: repo.id, stage: 'in_progress' });
const run = insertRun(db, {
  id: crypto.randomUUID(), cardId: card.id, kind: 'claude', stage: 'in_progress',
  status: 'running', sessionId: crypto.randomUUID(), cwd: '/tmp/x',
});

/** Shaped as the SDK really emits them — see classify() in runs/claude.ts. */
const assistant = (content: unknown) => ({
  type: 'assistant',
  session_id: run.sessionId,
  message: { role: 'assistant', content },
});

const SUMMARY = 'The cart is keyed by session, so a guest loses it on reload.\n\nPersisting it to localStorage first.';

// Messages BEFORE anyone subscribes: these are the replay a live-only
// subscriber must not receive.
for (const m of [
  assistant([{ type: 'text', text: 'Reading the cart code.' }]),
  assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
  assistant([{ type: 'tool_use', id: 't2', name: 'Grep', input: {} }]),
  // Thinking arrives as its own single-block message. Summarized, it has text;
  // left to the model's default, only a signature.
  assistant([{ type: 'thinking', thinking: SUMMARY, signature: 'sig' }]),
  assistant([{ type: 'thinking', thinking: '', signature: 'sig' }]),
]) {
  writer.append(run.id, 'assistant', m, crypto.randomUUID());
}
writer.append(
  run.id,
  'system:thinking_tokens',
  { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 120, estimated_tokens_delta: 40, session_id: run.sessionId },
  crypto.randomUUID(),
);
await writer.flush();

const read = async (url: string, headers: Record<string, string> = {}) => {
  const res = await app.fetch(new Request(url, { headers }));
  const reader = res.body!.getReader();
  const seen: string[] = [];
  const deadline = Date.now() + 2_500;
  // Push two more once the subscriber is attached; only these should arrive.
  setTimeout(() => {
    writer.append(run.id, 'assistant', assistant([{ type: 'tool_use', id: 't3', name: 'Edit', input: {} }]), crypto.randomUUID());
    writer.append(run.id, 'assistant', assistant([{ type: 'text', text: 'Writing the e2e tests for guest persistence.' }]), crypto.randomUUID());
    void writer.flush();
  }, 300);
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 400)),
    ]);
    if (chunk.value) seen.push(new TextDecoder().decode(chunk.value));
    if (seen.join('').split('data:').length > 12) break;
  }
  await reader.cancel();
  return seen.join('');
};

const live = await read(`http://x/api/runs/${run.id}/events?since=live`);
const replayed = await read(`http://x/api/runs/${run.id}/events?since=0`);
// The browser sends this automatically on every auto-reconnect.
const reconnect = await read(`http://x/api/runs/${run.id}/events?since=live`, { 'Last-Event-ID': '1' });

const count = (body: string, needle: string) => body.split(needle).length - 1;

// The modal's one line, parsed exactly as the browser parses it.
const payloads = [...replayed.matchAll(/^data: (.+)$/gm)].map((m) => m[1]!);
const described = payloads.map(describeMessage).filter((d) => d !== null);
const actions = described.filter((d) => d.text !== 'thinking');
const reasoning = described.filter((d) => d.text === 'thinking');
// What the server stores and the band shows: every line folded in order.
const folded = described.reduce<Thought>(nextThought, { activity: null, thinking: null });
const afterEmpty = nextThought({ activity: 'thinking', thinking: SUMMARY }, { text: 'thinking', thinking: null });
const afterTokens = nextThought(
  { activity: 'reading a file', thinking: SUMMARY },
  describeMessage(JSON.stringify({ type: 'system', subtype: 'thinking_tokens' }))!,
);

const checks: Array<[string, boolean, string]> = [
  ['live-only skips the replay', count(live, '"tool_use"') <= 1 && !live.includes('Reading the cart code'), `${count(live, 'data:')} events`],
  ['...but does deliver what happens next', live.includes('Writing the e2e tests'), ''],
  ['since=0 replays everything', replayed.includes('Reading the cart code'), `${count(replayed, 'data:')} events`],
  // useLiveRun listens by these names; a renamed kind would go silently unheard.
  ['events are named after their kind', replayed.includes('event: assistant') && replayed.includes('event: system:thinking_tokens'), ''],
  ['live-only survives a reconnect', !reconnect.includes('Reading the cart code'), `${count(reconnect, 'data:')} events`],
  ['tool calls and prose carry no summary', actions.length >= 3 && actions.every((d) => d.thinking === undefined), `${actions.length} actions`],
  ['thinking reads as thinking', reasoning.length === 3, `${reasoning.length} thinking`],
  ['a summary comes through whole', described.some((d) => d.thinking === SUMMARY), ''],
  ['an empty block shows no summary', described.some((d) => d.text === 'thinking' && d.thinking === null), ''],
  ['thinking_tokens reads as thinking', reasoning.some((d) => d.thinking === undefined), ''],
  ['a search reads as one too', described.some((d) => d.text === 'searching the codebase'), ''],
  ['a tool call reads as an activity', described.some((d) => d.text === 'reading a file'), String(described.map((d) => d.text))],
  ['so does a sentence of prose', described.some((d) => d.text === 'Reading the cart code.'), ''],
  ['an empty block keeps the last summary', afterEmpty.thinking === SUMMARY, ''],
  ['thinking_tokens moves only the activity', afterTokens.activity === 'thinking' && afterTokens.thinking === SUMMARY, ''],
  [
    'the whole run folds to its last action and summary',
    folded.activity === 'Writing the e2e tests for guest persistence.' && folded.thinking === SUMMARY,
    JSON.stringify(folded.activity),
  ],
];

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}
console.log(failed === 0 ? '\nthe live stream carries what the band shows' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
