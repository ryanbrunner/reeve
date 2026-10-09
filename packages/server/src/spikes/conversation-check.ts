/**
 * Throwaway check on what a stage needs from the SDK to be a conversation
 * rather than a single turn: an input left open, a person's message pushed in
 * while Claude works, a turn that ends in plain text, and a stage that ends
 * when Claude calls a submit tool instead of on the first `result`.
 *
 * Standalone like spike-interrupt.ts: a temp dir, no app and no database, and
 * real API credit (Sonnet, a few cents). Each finding is printed as it lands,
 * and the verdict table at the end is what the run loop is built on.
 *
 *   npx tsx packages/server/src/spikes/conversation-check.ts
 *   SPIKE_PRIORITY=now npx tsx packages/server/src/spikes/conversation-check.ts
 *
 * What it found on SDK 0.3.281 (Sonnet), which runs/claude.ts is built on:
 *
 * - One `result` per turn, and a message pushed after it starts a new turn in
 *   the same process. Closing the input then ends the loop cleanly.
 * - `session_state_changed: idle` is the turn boundary, and only with
 *   CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1 in the session's env: without it
 *   the event never comes, which is what hung this spike's first version.
 *   `result` alone is not the boundary — see 'now' below.
 * - A push with no priority while a tool runs is folded into the SAME turn at
 *   the next tool boundary: one result, and the reply answers it. That is the
 *   interjection the board wants. `priority: 'now'` instead cuts the turn off
 *   (an empty `result`, no idle) and carries on in a new one.
 * - An in-process MCP submit tool is approved by auto mode's classifier
 *   without reaching `canUseTool`, so it needs no `allowedTools`. Its input
 *   is the contract; `structured_output` on the result stays null, so the
 *   handler is where the output is captured.
 * - AskUserQuestion does reach `canUseTool`, and `allow` with
 *   `updatedInput.answers` (question text → label) answers it.
 * - A forked session's first `total_cost_usd` includes the parent's, so a
 *   run's own cost is the difference.
 * - With `outputFormat` set, a turn that only wants to ask "succeeds" with a
 *   made-up deliverable ("Waiting for user input", steps: []) — why stages
 *   moved to a submit tool.
 */
import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { jsonSchemaFor } from '@reeve/shared';

const dir = mkdtempSync(join(tmpdir(), 'reeve-conv-'));
const MODEL = 'sonnet';
const t0 = Date.now();
const note = (l: string, v: unknown) =>
  console.log(`${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(6)}s ${l.padEnd(30)}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const verdict: Array<[string, string]> = [];
const find = (name: string, value: unknown) => {
  verdict.push([name, typeof value === 'string' ? value : JSON.stringify(value)]);
  note(name, value);
};

/** The pushable input a live run will hold. Iterating it waits for the next push. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  closed = false;
  push(text: string, priority?: 'now' | 'next' | 'later') {
    if (this.closed) return false;
    const msg: SDKUserMessage = {
      type: 'user', session_id: '', parent_tool_use_id: null,
      message: { role: 'user', content: text },
      ...(priority ? { priority } : {}),
    };
    if (this.waiting) { const w = this.waiting; this.waiting = null; w({ value: msg, done: false }); }
    else this.queue.push(msg);
    return true;
  }
  close() {
    this.closed = true;
    if (this.waiting) { const w = this.waiting; this.waiting = null; w({ value: undefined, done: true }); }
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const head = this.queue.shift();
        if (head) return Promise.resolve({ value: head, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { this.waiting = resolve; });
      },
    };
  }
}

const planShape = { summary: z.string(), steps: z.array(z.string()) };
let submitted: unknown = null;
const submitPlan = tool(
  'submit_plan',
  'Submit the finished plan. Call this once, only when the person is happy with it; it ends the stage.',
  planShape,
  async (args) => {
    submitted = args;
    return { content: [{ type: 'text', text: 'Recorded. Reeve has written the plan. End your turn.' }] };
  },
  { alwaysLoad: true },
);
// tool() takes no _meta; the definition it returns does. alwaysLoad, because
// the first run found Claude reaching it through ToolSearch.
submitPlan._meta = { 'claude/endTurn': true };

/** An abort controller that fires on its own, so parts B and C cannot hang either. */
function timed(ms: number): AbortController {
  const c = new AbortController();
  const t = setTimeout(() => { note('WATCHDOG', `aborting after ${ms / 1000}s`); c.abort(); }, ms);
  t.unref();
  return c;
}

const canUseToolCalls: string[] = [];
let askAnswered = false;

function textOf(m: SDKMessage): string {
  const c = (m as { message?: { content?: unknown } }).message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b: { type?: string; text?: string; name?: string }) =>
    b.type === 'text' ? b.text : b.type === 'tool_use' ? `[tool_use ${b.name}]` : b.type === 'tool_result' ? '[tool_result]' : '').join(' ');
}

// ---------- Part A: one live session, several turns ----------
console.log('\n--- A: one session, input left open ---');
const inbox = new Inbox();
const sessionId = crypto.randomUUID();
const abortA = new AbortController();
const options: Omit<Options, 'prompt'> = {
  cwd: dir, sessionId, model: MODEL, permissionMode: 'auto', maxBudgetUsd: 1.5, abortController: abortA,
  // Opt-in: without it session_state_changed never arrives, which is what hung
  // the first version of this spike. Turned on to see it, not relied on.
  env: { ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
  mcpServers: { reeve: createSdkMcpServer({ name: 'reeve', tools: [submitPlan] }) },
  canUseTool: async (toolName, input) => {
    canUseToolCalls.push(toolName);
    if (toolName === 'AskUserQuestion') {
      // Answered the way a person clicking a chip would be.
      const qs = (input as { questions: Array<{ question: string; options: Array<{ label: string }> }> }).questions;
      const answers = Object.fromEntries(qs.map((q) => [q.question, q.options[0]?.label ?? 'yes']));
      askAnswered = true;
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    }
    if (toolName.startsWith('mcp__reeve__')) return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: 'Denied by the spike.' };
  },
};

inbox.push('We are planning a tiny change together. Ask me ONE short clarifying question in plain text ' +
  '(do not use any tools, do not use AskUserQuestion), then end your turn and wait for my answer.');

const q = query({ prompt: inbox, options });
let turn = 0;
const perTurn: Array<{ results: number; idle: number; queued: number | undefined; cost: number; text: string }> = [];
let current = { results: 0, idle: 0, queued: undefined as number | undefined, cost: 0, text: '' };
let echoes = 0, replays = 0;
let interjected = false, interjectSeen = false, sawBashUse = false;
const kinds = new Map<string, number>();
let firstCost = 0;
let loopEndedCleanly = false;

let idleSeen = 0;
// A stalled turn must show up as a finding, not a hang.
let watchdog: NodeJS.Timeout | undefined;
const arm = () => {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => { note('WATCHDOG', `turn ${turn} stalled 150s; aborting`); inbox.close(); abortA.abort(); }, 150_000);
};
arm();
const advance = () => {
  arm();
  note(`turn ${turn} said`, current.text.trim().replace(/\s+/g, ' ').slice(0, 160));
  perTurn.push(current);
  current = { results: 0, idle: 0, queued: undefined, cost: 0, text: '' };
  turn++;
  switch (turn) {
    case 1:
      inbox.push('Name it notes.txt. Now run exactly this with Bash: `sleep 6 && echo slept` and then tell me what it printed.');
      break;
    case 2:
      inbox.push('Use the AskUserQuestion tool to ask me whether the plan should have 2 or 3 steps (two options). ' +
        'Then, using my answer, call the submit_plan tool with a one-line summary and that many steps.');
      break;
    default:
      inbox.close();
  }
};

try {
  for await (const m of q) {
    const kind = m.type === 'system' ? `system:${(m as { subtype?: string }).subtype}` : m.type;
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    if (m.type === 'user') {
      if ((m as { isReplay?: boolean }).isReplay) replays++;
      const c = (m as { message?: { content?: unknown } }).message?.content;
      const isToolResult = Array.isArray(c) && c.some((b: { type?: string }) => b.type === 'tool_result');
      if (!isToolResult) { echoes++; if (/forty|42/i.test(textOf(m))) interjectSeen = true; }
    }
    if (m.type === 'assistant') {
      const t = textOf(m);
      if (t.trim()) current.text += t + ' ';
      if (turn === 1 && /tool_use Bash/.test(t) && !interjected) {
        sawBashUse = true;
        interjected = true;
        // Pushed while the Bash call sleeps: does 'now' cut in, or wait?
        // SPIKE_PRIORITY=now|next|later, or unset for none: the mode under test.
        const p = process.env['SPIKE_PRIORITY'] as 'now' | 'next' | 'later' | undefined;
        inbox.push('Interjection: also mention the number 42 in your reply.', p);
        note('interjected', `priority ${p ?? '(none)'} during Bash`);
      }
    }
    if (m.type === 'result') {
      current.results++;
      current.queued = (m as { queued_turn_count?: number }).queued_turn_count;
      current.cost = (m as { total_cost_usd?: number }).total_cost_usd ?? 0;
      firstCost = current.cost;
      note(`turn ${turn} result`, `${m.subtype} queued=${current.queued} cost=$${current.cost.toFixed(4)} ` +
        `structured=${JSON.stringify((m as { structured_output?: unknown }).structured_output ?? null).slice(0, 80)}`);
      // Not the boundary: a 'now' interjection emits a result mid-flow. idle is.
    }
    if (m.type === 'system' && (m as { subtype?: string }).subtype === 'session_state_changed') {
      const state = (m as { state?: string }).state;
      if (state === 'idle') { idleSeen++; note('idle event', `#${idleSeen}`); advance(); }
    }
  }
  loopEndedCleanly = true;
} catch (err) {
  note('part A threw', String(err).slice(0, 200));
} finally {
  clearTimeout(watchdog);
}

find('1 results per turn', perTurn.map((t) => `${t.results}r`).join(' ') + ` · idle events=${idleSeen}`);
find('2 push after idle = new turn', perTurn.length >= 2 && perTurn[1]!.results > 0);
find('3 close at idle ends loop', loopEndedCleanly);
find("4 'now' interject reached turn", `bash seen=${sawBashUse} echo seen=${interjectSeen} turnsMentioning42=${perTurn.map((t, i) => (/42|forty/i.test(t.text) ? i : null)).filter((i) => i !== null).join(',')} results=${perTurn.map((t) => t.results).join('/')}`);
find('4b user echoes / replays', `${echoes} / ${replays}`);
find('5 submit tool reached canUseTool', canUseToolCalls.filter((n) => n.startsWith('mcp__reeve__')).length > 0);
find('5b AskUserQuestion via canUseTool', `${canUseToolCalls.includes('AskUserQuestion')} answered=${askAnswered}`);
find('6 submit called with contract', JSON.stringify(submitted)?.slice(0, 120) ?? 'null');
find('6b canUseTool saw', canUseToolCalls.join(',') || '(nothing)');
note('message kinds', Object.fromEntries(kinds));

// ---------- Part B: fork the session; does cost carry over? ----------
console.log('\n--- B: fork resume, cost carry-over ---');
let forkCost = 0, recalled = '';
const forkInbox = new Inbox();
forkInbox.push('Without using tools: what file name did I choose? One word.');
try {
for await (const m of query({
  prompt: forkInbox,
  options: { cwd: dir, resume: sessionId, forkSession: true, sessionId: crypto.randomUUID(), model: MODEL, permissionMode: 'auto', maxBudgetUsd: 0.5, abortController: timed(90_000) },
})) {
  if (m.type === 'result') { forkCost = (m as { total_cost_usd?: number }).total_cost_usd ?? 0; recalled = (m as { result?: string }).result ?? ''; forkInbox.close(); }
}
} catch (err) { note('part B threw', String(err).slice(0, 200)); }
find('7 fork cost includes parent', `parent=$${firstCost.toFixed(4)} fork=$${forkCost.toFixed(4)} recalled=${recalled.trim().slice(0, 30)}`);

// ---------- Part C: outputFormat and a plain-text turn ----------
console.log('\n--- C: outputFormat vs a turn that only asks ---');
let cSubtype = '', cText = '';
try {
for await (const m of query({
  prompt: (async function* () {
    yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: 'Do not produce a plan yet. Ask me one question in plain text and wait.' } } satisfies SDKUserMessage;
  })(),
  options: {
    cwd: dir, model: MODEL, permissionMode: 'auto', maxBudgetUsd: 0.5, abortController: timed(120_000),
    outputFormat: { type: 'json_schema', schema: jsonSchemaFor(z.object(planShape)) },
  },
})) {
  if (m.type === 'result') { cSubtype = m.subtype; cText = JSON.stringify((m as { structured_output?: unknown }).structured_output ?? (m as { result?: string }).result ?? '').slice(0, 100); }
}
} catch (err) { note('part C threw', String(err).slice(0, 200)); }
find('8 outputFormat on a question turn', `${cSubtype} ${cText}`);

console.log('\n--- verdict ---');
for (const [k, v] of verdict) console.log(`${k.padEnd(34)} ${v}`);
