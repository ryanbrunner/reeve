/**
 * Throwaway check on whether a stage can hand its work to a background
 * subagent and stay free to talk: the go/no-go for In Progress and Testing
 * running their build as a worker while the lead session answers the person.
 *
 * Standalone like conversation-check.ts: a temp git dir, no app and no
 * database, and real API credit (Sonnet, some cents). Every message that
 * matters is printed with its time as it lands, and the verdict table at the
 * end is what the run loop would be built on.
 *
 *   npx tsx packages/server/src/spikes/background-agent-check.ts
 *
 * A: one live session. The lead launches a named background worker that
 *    sleeps twice and writes DONE.txt; a person's question is pushed while it
 *    sleeps (does the lead answer before the worker finishes?), then a change
 *    for the worker (does SendMessage reach it?).
 * B: stopTask on a running worker.
 * C: closing the input while a worker runs.
 * D: the worker parked on a permission while the person talks to the lead.
 * E: a background shell, no worker: does idle wait for it?
 * F: progress summaries, on and off, for what they cost.
 *
 * What it found on SDK 0.3.281 (Sonnet), on 2026-10-09:
 *
 * - GO. A question pushed 5s into the worker's run was answered 2.4s later;
 *   the worker finished 50s after that. Each push while the worker runs is
 *   its own short lead turn.
 * - Each of those turns ends in a `result` with no `idle`. `idle` comes only
 *   once the background set is empty and the lead has taken the
 *   notification's turn, so the idle close in runs/claude.ts is already
 *   right. Its 15s fallback after a `result` is not: it would close the input
 *   mid-work.
 * - Closing the input mid-work does not kill the worker. The loop carries on
 *   until the worker reports and the lead has answered it (C: 69s after the
 *   close), but nobody can talk to the lead in that time.
 * - `stopTask(task_id)` stops it at once, with a `stopped` task_notification,
 *   and the lead takes one more turn to say so.
 * - The Agent call's own tool_result is "Async agent launched successfully",
 *   at once. Its real end is a `task_notification` with the same
 *   `tool_use_id`. With SubagentHandback, the report itself comes as a lead
 *   turn whose `result.origin` is `{kind:'peer', handback:true, body}`.
 * - The worker's tool_use and tool_result messages stream live, each with
 *   `parent_tool_use_id` set to the Agent call's id. `task_progress` arrives
 *   on every worker tool call (`last_tool_name`, usage). It carries a
 *   `summary` only every ~30s, and only with `agentProgressSummaries`.
 * - `background_tasks_changed` lists only the worker. The worker's own Bash
 *   calls show up as foreground `task_started`/`task_notification` pairs with
 *   their own ids, so they do not count as background work.
 * - SendMessage reaches a running worker: it wrote NOTE.txt as relayed. The
 *   lead had to load SendMessage through ToolSearch, and tried the name
 *   before the task id.
 * - PreToolUse hooks fire for the worker's calls, with `agent_id` and
 *   `agent_type: 'worker'`; canUseTool's options carry `agentID`. So
 *   mergeGuard covers the worker, and an ask can be attributed to it.
 * - D: while canUseTool holds a worker's call, the lead still takes a turn: a
 *   question pushed 3s into a 25s hold was answered 1.8s later. So a person's
 *   words can go to the lead while the worker waits on Allow or Deny.
 * - E: a background shell does not hold idle back the way an agent does:
 *   idle came with a `local_bash` task still listed. A worker is listed as
 *   `local_agent`. So the run loop waits on agents only, or a dev server
 *   would keep a run open for ever.
 * - F (SPIKE_PART=F only, about $3): what progress summaries cost could
 *   not be told apart from the worker's own variance. On, $1.07 over 68s with
 *   one summary; off, $1.63 over 236s, since that worker took a longer road.
 *   A summary is one short fork every half minute or so against a cached
 *   context, small beside the work, so the runs keep them on.
 * - The hook's `tool_use_id` for an Agent call is the id its tool_use block
 *   carries, which a task_notification names in turn (A10).
 */
import { query, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODEL = 'sonnet';
let t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const note = (l: string, v: unknown) =>
  console.log(`${secs()}s ${l.padEnd(28)}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
const verdict: Array<[string, string]> = [];
const find = (name: string, value: unknown) => {
  verdict.push([name, typeof value === 'string' ? value : JSON.stringify(value)]);
  note(name, value);
};

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'reeve-bg-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

/** The same shape as runs/inbox.ts: no priority, so a push waits for a tool boundary or the next turn. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  closed = false;
  get pending() { return this.queue.length; }
  push(text: string) {
    if (this.closed) return false;
    const msg: SDKUserMessage = { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: text } };
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

function textOf(m: SDKMessage): string {
  const c = (m as { message?: { content?: unknown } }).message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b: { type?: string; text?: string; name?: string; input?: unknown }) =>
    b.type === 'text' ? b.text
      : b.type === 'tool_use' ? `[tool_use ${b.name} ${JSON.stringify(b.input).slice(0, 120)}]`
      : b.type === 'tool_result' ? '[tool_result]' : '').join(' ');
}

const WORKER = {
  description: 'Does the stage\'s actual work in the background while the lead stays free to talk.',
  prompt: 'You are a worker. Carry out the task you are given exactly, using Bash, then reply with one line saying what you did. ' +
    'If a message arrives from the lead while you work, do what it asks as well.',
  model: 'inherit',
} as const;

function baseOptions(cwd: string, abortController: AbortController, extra: Partial<Options> = {}): Options {
  return {
    cwd, model: MODEL, permissionMode: 'auto', maxBudgetUsd: 2, abortController,
    env: { ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
    agents: { worker: WORKER },
    agentProgressSummaries: true,
    forwardSubagentText: true,
    ...extra,
  };
}

const LAUNCH = (task: string) =>
  'You are the lead. Use the Agent tool ONCE to launch a background agent: subagent_type "worker", name "worker", ' +
  `run_in_background true, with this task: "${task}". Do no work yourself. ` +
  'After launching it, end your turn with one short sentence. While it runs, answer my messages briefly; ' +
  'if I ask you to pass something to the worker, use SendMessage to "worker". When it finishes, say "WORKER FINISHED" and what it reported.';

// ---------- Part A ----------
async function partA() {
  console.log('\n--- A: talk to the lead while a background worker runs ---');
  t0 = Date.now();
  const dir = repo();
  const inbox = new Inbox();
  const abort = new AbortController();
  const hookCalls: string[] = [];
  const hookAgentIds: string[] = [];
  const blockAgentIds: string[] = [];
  const canUseCalls: string[] = [];
  const opts = baseOptions(dir, abort, {
    hooks: {
      PreToolUse: [{
        hooks: [async (input, toolUseID) => {
          const i = input as { tool_name?: string; agent_id?: string; agent_type?: string; tool_use_id?: string };
          hookCalls.push(`${i.tool_name}@${i.agent_id ? `sub:${i.agent_type}` : 'main'}`);
          if (i.tool_name === 'Agent') hookAgentIds.push(`${i.tool_use_id}/${toolUseID}`);
          return {};
        }],
      }],
    },
    canUseTool: async (name, input, o) => {
      canUseCalls.push(`${name}@${o.agentID ? 'sub' : 'main'}`);
      return { behavior: 'allow', updatedInput: input };
    },
  });
  inbox.push(LAUNCH('Run `sleep 20 && echo one` with Bash, then `sleep 20 && echo two`, then write the word done into DONE.txt.'));

  const q = query({ prompt: inbox, options: opts });
  const watchdog = setTimeout(() => { note('WATCHDOG', 'A ran 300s; aborting'); inbox.close(); abort.abort(); }, 300_000);

  let taskStartedAt = 0, notifiedAt = 0, replyAt = 0, askedAt = 0, relayedAt = 0;
  let bgTasks: string[] = [];
  const idlesWhileRunning: number[] = [];
  const resultsWhileRunning: Array<{ at: number; origin: unknown }> = [];
  let subToolUses = 0, subTexts = 0, subToolResults = 0, progressSummaries = 0;
  let launchResult = '';
  let sendMessageUsed = false;
  let leadTurnAfterNotify = false;
  const kinds = new Map<string, number>();

  const pushQuestion = () => {
    askedAt = Date.now();
    inbox.push('Quick question while that runs: what is 6 times 7? Reply in one line.');
    note('PUSHED question', `bg=${bgTasks.length}`);
  };
  const pushRelay = () => {
    relayedAt = Date.now();
    inbox.push('Please tell the worker to also write the word hi into NOTE.txt before it finishes.');
    note('PUSHED relay', `bg=${bgTasks.length}`);
  };

  try {
    for await (const m of q) {
      const sub = (m as { subtype?: string }).subtype;
      const kind = m.type === 'system' ? `system:${sub}` : m.type;
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      const parent = (m as { parent_tool_use_id?: string | null }).parent_tool_use_id;

      if (m.type === 'assistant') {
        const t = textOf(m);
        if (parent) {
          const c = (m as { message?: { content?: Array<{ type?: string }> } }).message?.content ?? [];
          subToolUses += c.filter((b) => b.type === 'tool_use').length;
          subTexts += c.filter((b) => b.type === 'text').length;
          note('  worker says', t.slice(0, 140));
        } else {
          note('lead says', t.slice(0, 160));
          for (const b of (m as { message?: { content?: Array<{ type?: string; name?: string; id?: string }> } }).message?.content ?? []) {
            if (b.type === 'tool_use' && b.name === 'Agent' && b.id) blockAgentIds.push(b.id);
          }
          if (/SendMessage/.test(t)) sendMessageUsed = true;
          if (askedAt && !replyAt && /42|forty/i.test(t)) replyAt = Date.now();
          if (notifiedAt) leadTurnAfterNotify = true;
        }
      }
      if (m.type === 'user') {
        const c = (m as { message?: { content?: unknown } }).message?.content;
        const isResult = Array.isArray(c) && c.some((b: { type?: string }) => b.type === 'tool_result');
        if (parent && isResult) subToolResults++;
        if (!parent && isResult && !launchResult) {
          const block = (c as Array<{ type?: string; content?: unknown }>).find((b) => b.type === 'tool_result');
          launchResult = JSON.stringify(block?.content).slice(0, 200);
          note('lead tool_result', launchResult);
        }
        if (!parent && !isResult) note('user echo', textOf(m).slice(0, 120));
      }
      if (m.type === 'system') {
        const rec = m as Record<string, unknown>;
        if (sub === 'task_started') {
          note('task_started', { task_id: rec['task_id'], tool_use_id: rec['tool_use_id'], bg: rec['is_backgrounded'], type: rec['subagent_type'] });
          if (!taskStartedAt) {
            taskStartedAt = Date.now();
            setTimeout(pushQuestion, 5_000);
            setTimeout(pushRelay, 15_000);
          }
        } else if (sub === 'task_progress') {
          if (rec['summary']) progressSummaries++;
          note('task_progress', { summary: rec['summary'], last: rec['last_tool_name'], usage: rec['usage'] });
        } else if (sub === 'task_updated') {
          note('task_updated', rec['patch']);
        } else if (sub === 'task_notification') {
          notifiedAt = Date.now();
          note('task_notification', { status: rec['status'], summary: String(rec['summary']).slice(0, 120), tool_use_id: rec['tool_use_id'] });
        } else if (sub === 'background_tasks_changed') {
          bgTasks = ((rec['tasks'] as Array<{ task_id: string }>) ?? []).map((t) => t.task_id);
          note('background_tasks_changed', bgTasks);
        } else if (sub === 'session_state_changed') {
          const state = rec['state'];
          note('session_state', `${state} bg=${bgTasks.length} pending=${inbox.pending}`);
          if (state === 'idle' && bgTasks.length > 0) idlesWhileRunning.push(Date.now());
          // Close once the worker is done, the lead has spoken about it, and nothing is queued.
          if (state === 'idle' && notifiedAt && leadTurnAfterNotify && bgTasks.length === 0 && inbox.pending === 0) inbox.close();
        }
      }
      if (m.type === 'result') {
        const origin = (m as { origin?: unknown }).origin;
        note('result', `${m.subtype} origin=${JSON.stringify(origin)} bg=${bgTasks.length}`);
        if (bgTasks.length > 0) resultsWhileRunning.push({ at: Date.now(), origin });
      }
    }
  } catch (err) {
    note('A threw', String(err).slice(0, 200));
  } finally {
    clearTimeout(watchdog);
  }

  const rel = (at: number) => (at ? `${((at - t0) / 1000).toFixed(1)}s` : 'never');
  find('A1 lead answered mid-work', `asked=${rel(askedAt)} replied=${rel(replyAt)} workerDone=${rel(notifiedAt)} → ${replyAt && notifiedAt && replyAt < notifiedAt ? 'GO' : 'NO-GO'}`);
  find('A2 idle while worker ran', idlesWhileRunning.map(rel).join(',') || 'none');
  find('A3 result while worker ran', resultsWhileRunning.map((r) => `${rel(r.at)} ${JSON.stringify(r.origin)}`).join(' | ') || 'none');
  find('A4 Agent call tool_result', launchResult);
  find('A5 worker messages streamed', `tool_use=${subToolUses} tool_result=${subToolResults} text=${subTexts} progress summaries=${progressSummaries}`);
  find('A6 relay via SendMessage', `relayed=${rel(relayedAt)} sendMessageUsed=${sendMessageUsed} NOTE.txt=${existsSync(join(dir, 'NOTE.txt')) ? readFileSync(join(dir, 'NOTE.txt'), 'utf8').trim() : 'missing'} DONE.txt=${existsSync(join(dir, 'DONE.txt'))}`);
  find('A7 PreToolUse hook saw', hookCalls.join(','));
  find('A8 canUseTool saw', canUseCalls.join(',') || '(nothing)');
  find('A9 lead turn after notification', leadTurnAfterNotify);
  find('A10 hook ids = block ids', `hook=${hookAgentIds.join(',')} block=${blockAgentIds.join(',')}`);
  note('message kinds', Object.fromEntries(kinds));
}

/** Launch a long worker and do something to it once it has started. */
async function poke(label: string, act: (q: ReturnType<typeof query>, inbox: Inbox, taskId: string) => void) {
  t0 = Date.now();
  const dir = repo();
  const inbox = new Inbox();
  const abort = new AbortController();
  inbox.push(LAUNCH('Run `sleep 60 && echo late` with Bash, then write the word done into DONE.txt.'));
  const q = query({ prompt: inbox, options: baseOptions(dir, abort) });
  const watchdog = setTimeout(() => { note('WATCHDOG', `${label} ran 150s; aborting`); inbox.close(); abort.abort(); }, 150_000);
  let acted = false, notified = '', loopEnded = 0, actedAt = 0, bg = 0;
  try {
    for await (const m of q) {
      const sub = (m as { subtype?: string }).subtype;
      const rec = m as Record<string, unknown>;
      if (m.type === 'system' && sub === 'task_started' && !acted) {
        acted = true;
        setTimeout(() => { actedAt = Date.now(); note(`${label}: acting`, String(rec['task_id'])); act(q, inbox, String(rec['task_id'])); }, 8_000);
      }
      if (m.type === 'system' && sub === 'task_notification') { notified = `${rec['status']} at ${secs()}s`; note('task_notification', notified); }
      if (m.type === 'system' && sub === 'background_tasks_changed') bg = (rec['tasks'] as unknown[]).length;
      if (m.type === 'system' && sub === 'session_state_changed') {
        note('session_state', `${rec['state']} bg=${bg}`);
        if (rec['state'] === 'idle' && notified && bg === 0) inbox.close();
      }
      if (m.type === 'assistant' && !(m as { parent_tool_use_id?: string }).parent_tool_use_id) note('lead says', textOf(m).slice(0, 120));
    }
    loopEnded = Date.now();
  } catch (err) {
    note(`${label} threw`, String(err).slice(0, 200));
    loopEnded = Date.now();
  } finally {
    clearTimeout(watchdog);
  }
  return { notified: notified || 'none', endedAfterAct: actedAt ? `${((loopEnded - actedAt) / 1000).toFixed(1)}s` : 'n/a', done: existsSync(join(dir, 'DONE.txt')) };
}

async function partB() {
  console.log('\n--- B: stopTask on a running worker ---');
  const r = await poke('B', (q, _inbox, taskId) => { void q.stopTask(taskId).catch((e) => note('stopTask threw', String(e))); });
  find('B1 stopTask', `notification=${r.notified} loop ended ${r.endedAfterAct} after DONE.txt=${r.done}`);
}

async function partC() {
  console.log('\n--- C: close the input while a worker runs ---');
  const r = await poke('C', (_q, inbox) => inbox.close());
  find('C1 input closed mid-work', `notification=${r.notified} loop ended ${r.endedAfterAct} after DONE.txt=${r.done}`);
}

/**
 * D: the worker parked on a permission nobody has answered yet. Default mode,
 * so the worker's Bash reaches canUseTool, which holds it for 25s; a question
 * for the lead is pushed meanwhile. Is it answered before the hold ends?
 */
async function partD() {
  console.log('\n--- D: talk to the lead while the worker waits on a permission ---');
  t0 = Date.now();
  const dir = repo();
  const inbox = new Inbox();
  const abort = new AbortController();
  let heldAt = 0, releasedAt = 0, askedAt = 0, replyAt = 0, notifiedAt = 0;
  let bg = 0;
  const opts = baseOptions(dir, abort, {
    permissionMode: 'default',
    canUseTool: async (name, input, o) => {
      if (!o.agentID || heldAt) return { behavior: 'allow', updatedInput: input };
      heldAt = Date.now();
      note('worker parked', name);
      setTimeout(() => { askedAt = Date.now(); inbox.push('While you wait: what is 6 times 7? One line.'); note('PUSHED question', ''); }, 3_000);
      await new Promise((r) => setTimeout(r, 25_000));
      releasedAt = Date.now();
      note('worker released', name);
      return { behavior: 'allow', updatedInput: input };
    },
  });
  inbox.push(LAUNCH('Run `touch MADE.txt && mkdir -p out && echo hello > out/hello.txt` with Bash, then write the word done into DONE.txt.'));
  const q = query({ prompt: inbox, options: opts });
  const watchdog = setTimeout(() => { note('WATCHDOG', 'D ran 180s; aborting'); inbox.close(); abort.abort(); }, 180_000);
  try {
    for await (const m of q) {
      const sub = (m as { subtype?: string }).subtype;
      const rec = m as Record<string, unknown>;
      if (m.type === 'assistant' && !(m as { parent_tool_use_id?: string }).parent_tool_use_id) {
        const t = textOf(m);
        note('lead says', t.slice(0, 120));
        if (askedAt && !replyAt && /42|forty/i.test(t)) replyAt = Date.now();
      }
      if (m.type === 'system' && sub === 'task_notification') notifiedAt = Date.now();
      if (m.type === 'system' && sub === 'background_tasks_changed') bg = (rec['tasks'] as unknown[]).length;
      if (m.type === 'system' && sub === 'session_state_changed' && rec['state'] === 'idle' && notifiedAt && bg === 0) inbox.close();
    }
  } catch (err) {
    note('D threw', String(err).slice(0, 200));
  } finally {
    clearTimeout(watchdog);
  }
  const rel = (at: number) => (at ? `${((at - t0) / 1000).toFixed(1)}s` : 'never');
  find('D1 lead answered while worker parked', `parked=${rel(heldAt)} asked=${rel(askedAt)} replied=${rel(replyAt)} released=${rel(releasedAt)} → ${replyAt && replyAt < releasedAt ? 'YES' : 'NO'}`);
}

/**
 * E: no worker, but a background shell. Does idle come while the shell is
 * still listed in background_tasks_changed, and with what task_type? Reeve's
 * run loop must not hold the input open for ever on a dev server.
 */
async function partE() {
  console.log('\n--- E: a background shell, and no worker ---');
  t0 = Date.now();
  const dir = repo();
  const inbox = new Inbox();
  const abort = new AbortController();
  let bg: Array<{ task_id?: string; task_type?: string }> = [];
  let idleWithShell = '';
  const watchdog = setTimeout(() => { note('WATCHDOG', 'E ran 90s; aborting'); inbox.close(); abort.abort(); }, 90_000);
  inbox.push('Use Bash with run_in_background true to run `sleep 120`. Do not wait for it. Then reply with one short sentence and end your turn.');
  try {
    for await (const m of query({ prompt: inbox, options: baseOptions(dir, abort) })) {
      const sub = (m as { subtype?: string }).subtype;
      const rec = m as Record<string, unknown>;
      if (m.type === 'system' && sub === 'background_tasks_changed') {
        bg = (rec['tasks'] as typeof bg) ?? [];
        note('background_tasks_changed', bg.map((t) => `${t.task_id}:${t.task_type}`));
      }
      if (m.type === 'system' && sub === 'session_state_changed') {
        note('session_state', `${rec['state']} bg=${bg.length}`);
        // The first idle is the finding; closing at it then takes the shell down.
        if (rec['state'] === 'idle' && !idleWithShell) {
          idleWithShell = bg.length ? `yes, with ${bg.map((t) => t.task_type).join(',')} listed` : 'no shell listed';
          inbox.close();
        }
      }
      if (m.type === 'result') note('result', m.subtype);
    }
  } catch (err) {
    note('E threw', String(err).slice(0, 200));
  } finally {
    clearTimeout(watchdog);
  }
  find('E1 idle while a background shell runs', idleWithShell || 'never idle');
}

/**
 * F: what progress summaries cost. The same worker twice, summaries on and
 * off: it reads a large file into its context, then sleeps for two and a half
 * minutes, which is several summaries' worth. The difference in
 * total_cost_usd is their price at that context size.
 */
async function partF() {
  console.log('\n--- F: progress summaries, on and off ---');
  const big = join(process.cwd(), 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts');
  const costs: Record<string, number> = {};
  for (const summaries of [true, false]) {
    t0 = Date.now();
    const dir = repo();
    const inbox = new Inbox();
    const abort = new AbortController();
    let notified = false, bg = 0, n = 0;
    inbox.push(LAUNCH(`Read the file ${big} in full (every part of it, with several Read calls if needed). Then run \`sleep 30\` with Bash five times, one at a time. Then report how many lines the file had.`));
    const watchdog = setTimeout(() => { note('WATCHDOG', 'F ran 400s; aborting'); inbox.close(); abort.abort(); }, 400_000);
    try {
      for await (const m of query({ prompt: inbox, options: baseOptions(dir, abort, { agentProgressSummaries: summaries }) })) {
        const sub = (m as { subtype?: string }).subtype;
        const rec = m as Record<string, unknown>;
        if (m.type === 'system' && sub === 'task_progress' && rec['summary']) n++;
        if (m.type === 'system' && sub === 'task_notification') notified = true;
        if (m.type === 'system' && sub === 'background_tasks_changed') bg = (rec['tasks'] as unknown[]).length;
        if (m.type === 'result') costs[String(summaries)] = (m as { total_cost_usd?: number }).total_cost_usd ?? 0;
        if (m.type === 'system' && sub === 'session_state_changed' && rec['state'] === 'idle' && notified && bg === 0) inbox.close();
      }
    } catch (err) {
      note('F threw', String(err).slice(0, 200));
    } finally {
      clearTimeout(watchdog);
    }
    note(`summaries ${summaries ? 'on' : 'off'}`, `$${costs[String(summaries)]?.toFixed(4)} in ${((Date.now() - t0) / 1000).toFixed(0)}s, ${n} summaries`);
  }
  find('F1 summaries cost', `on=$${costs['true']?.toFixed(4)} off=$${costs['false']?.toFixed(4)}`);
}

const only = process.env['SPIKE_PART'];
if (!only || only === 'A') await partA();
if (!only || only === 'B') await partB();
if (!only || only === 'C') await partC();
if (!only || only === 'D') await partD();
if (!only || only === 'E') await partE();
if (only === 'F') await partF();

console.log('\n--- verdict ---');
for (const [k, v] of verdict) console.log(`${k.padEnd(32)} ${v}`);
