import type { RunStatus, StopReason } from './runs.js';
import type { RunnableStage } from './stages.js';

/**
 * A stage's conversation, as the card modal and `reeve run follow` show it,
 * read out of a run's stored events.
 *
 * One projection, here, so the server's `/conversation`, the modal's live
 * tail and the CLI cannot disagree about what a run said. It is a fold over
 * events in order, so the modal can apply each one as it arrives over SSE and
 * end up exactly where a fresh load of the endpoint would.
 *
 * Shallow on purpose, like transcript.ts: the stream carries forty-odd message
 * shapes, and anything not recognised here is skipped rather than guessed at.
 * A subagent's own messages are folded under the Agent call that launched it
 * (`agent` on that call's item), not into the thread: they are its work, and
 * the thread is the conversation with the person.
 */

/** Where a person's words came from, when not typed in the composer. */
export type MessageSource = 'chat' | 'answer' | 'review' | 'note' | 'crit' | 'gloss' | 'vibes';

export interface AskQuestionView {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export type AskView =
  /** `session`: what Allow for this session would cover, when it is offered. */
  | { kind: 'permission'; toolName: string; input: Record<string, unknown>; session?: string }
  | { kind: 'question'; questions: AskQuestionView[] };

export type AskOutcome =
  | { kind: 'permission'; allow: boolean; session?: boolean; reason?: string | null; actor: 'human' | 'claude' }
  | { kind: 'question'; answers: Record<string, string>; actor: 'human' | 'claude'; vibes?: boolean }
  | { kind: 'unanswered'; why: 'timeout' | 'stopped' };

export type ConversationItem =
  /** The stage's opening prompt: long, and collapsed by default. */
  | { kind: 'prompt'; id: string; text: string }
  | { kind: 'user'; id: string; text: string; actor: 'human' | 'claude'; source: MessageSource; live: boolean; at: number }
  | { kind: 'text'; id: string; text: string; at: number }
  | { kind: 'thinking'; id: string; text: string; at: number }
  | {
      kind: 'tool';
      id: string;
      /** The call's own id, which its result names. */
      toolUseId: string;
      name: string;
      /** What it did, in a word: Read, Edit, Bash. */
      verb: string;
      /** What it did it to: a path, a command, a pattern. */
      target: string;
      /** The call's input, trimmed for display. */
      input: string;
      /**
       * The head of what came back. The whole of it stays in the run's
       * events, at `seq`, and the modal fetches it when a row is opened: a
       * long run's outputs would otherwise make the conversation megabytes.
       */
      result: { text: string; isError: boolean; truncated: boolean; seq: number } | null;
      /** On an Agent call: the subagent it launched, and everything it has done. */
      agent?: AgentView;
      at: number;
    }
  | {
      kind: 'ask';
      id: string;
      askId: string | null;
      request: AskView;
      outcome: AskOutcome | null;
      /** Set when the stage's background worker asked, rather than the session the person talks to. */
      agent?: 'worker';
      at: number;
    }
  /** A call auto mode's classifier refused on its own, which a person may allow once. */
  | {
      kind: 'refused';
      id: string;
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
      allowed: boolean;
      /** Set when it was the stage's background worker's call. */
      agent?: 'worker';
      at: number;
    }
  | { kind: 'submitted'; id: string; summary: string; at: number }
  | { kind: 'error'; id: string; text: string; at: number };

/** A subagent's own text or tool call, as it shows under the Agent call that launched it. */
export type AgentStep = Extract<ConversationItem, { kind: 'text' }> | Omit<Extract<ConversationItem, { kind: 'tool' }>, 'agent'>;

export interface AgentView {
  /** `subagent_type` from the call: `worker` for a stage's own worker. */
  type: string | null;
  /** Launched to run in the background, which the lead goes on talking over. */
  background: boolean;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  /** Its own latest account of where it has got to, every half minute or so. */
  progress: string | null;
  usage: { tokens: number; toolUses: number; durationMs: number } | null;
  /** Its latest steps, oldest first. Earlier ones are dropped, and counted. */
  steps: AgentStep[];
  dropped: number;
  endedAt: number | null;
}

export interface ConversationRun {
  runId: string;
  status: RunStatus;
  stopReason: StopReason | null;
  /** The run this one carried on from, when it is a follow-up. */
  parentRunId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  costUsd: number | null;
  model: string | null;
  items: ConversationItem[];
  /** The last event folded in, for the live tail to resume from. */
  lastSeq: number;
}

export interface ConversationStage {
  stage: RunnableStage;
  runs: ConversationRun[];
}

export interface ApiConversation {
  stages: ConversationStage[];
}

/** One stored event, as the database and the SSE stream both carry it. */
export interface RunEventInput {
  seq: number;
  kind: string;
  /** Parsed already, or the raw JSON string. */
  payload: unknown;
  at?: number;
}

/** How much of a tool's call and output the conversation carries. The rest is in the run's events. */
const RESULT_MAX = 500;
const INPUT_MAX = 400;
/**
 * How many of a subagent's steps the conversation carries. A worker can make
 * hundreds of calls, and the latest are what anyone opening it wants; the
 * rest stay in the run's events.
 */
const STEPS_MAX = 150;

/**
 * Folds one run's events into its items. Mutable and cheap to call once per
 * event: the modal keeps one per live run.
 */
export class RunProjector {
  readonly items: ConversationItem[] = [];
  lastSeq = 0;
  private readonly tools = new Map<string, number>();
  private readonly asks = new Map<string, number>();
  /** A subagent's own tool calls, by id: where its results land. */
  private readonly steps = new Map<string, Extract<AgentStep, { kind: 'tool' }>>();

  constructor(prompt?: string | null) {
    if (prompt?.trim()) this.items.push({ kind: 'prompt', id: 'prompt', text: prompt });
  }

  /**
   * Carry on from a run already projected — the server's `/conversation` —
   * so the live tail folds in only what came after it.
   */
  static resume(run: Pick<ConversationRun, 'items' | 'lastSeq'>): RunProjector {
    const p = new RunProjector();
    // Copied as deep as `add` writes: a subagent's view and its steps change
    // in place as its events arrive.
    p.items.push(...run.items.map((i) =>
      i.kind === 'tool' && i.agent ? { ...i, agent: { ...i.agent, steps: i.agent.steps.map((s) => ({ ...s })) } } : { ...i },
    ) as ConversationItem[]);
    p.lastSeq = run.lastSeq;
    p.items.forEach((item, index) => {
      if (item.kind === 'tool') p.tools.set(item.toolUseId, index);
      if (item.kind === 'ask' && item.askId) p.asks.set(item.askId, index);
      if (item.kind === 'tool' && item.agent) {
        for (const step of item.agent.steps) if (step.kind === 'tool') p.steps.set(step.toolUseId, step);
      }
    });
    return p;
  }

  /** The event kinds `add` reads, for an EventSource that must name what it listens to. */
  static readonly KINDS = [
    'user_message', 'assistant', 'tool_result', 'ask', 'ask_answered', 'refused', 'allowed', 'submitted', 'error',
    'system:task_started', 'system:task_progress', 'system:task_notification',
  ] as const;

  add(event: RunEventInput): void {
    if (event.seq <= this.lastSeq) return;
    this.lastSeq = event.seq;
    const payload = typeof event.payload === 'string' ? safeParse(event.payload) : event.payload;
    if (!isRecord(payload)) return;
    const at = event.at ?? Date.now();
    const id = `e${event.seq}`;

    switch (event.kind) {
      case 'user_message':
        this.items.push({
          kind: 'user', id,
          text: String(payload['text'] ?? ''),
          actor: payload['actor'] === 'claude' ? 'claude' : 'human',
          source: (payload['source'] as MessageSource | undefined) ?? 'chat',
          live: payload['live'] === true,
          at: typeof payload['at'] === 'number' ? payload['at'] : at,
        });
        return;

      case 'assistant': {
        if (payload['parent_tool_use_id']) return this.addStep(payload, id, at);
        const content = (payload['message'] as { content?: unknown } | undefined)?.content;
        if (!Array.isArray(content)) return;
        content.forEach((block: unknown, i) => {
          if (!isRecord(block)) return;
          const bid = `${id}.${i}`;
          if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim()) {
            this.items.push({ kind: 'text', id: bid, text: block['text'], at });
          } else if (block['type'] === 'thinking' && typeof block['thinking'] === 'string' && block['thinking'].trim()) {
            this.items.push({ kind: 'thinking', id: bid, text: block['thinking'].trim(), at });
          } else if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
            const name = block['name'];
            const input = isRecord(block['input']) ? block['input'] : {};
            // AskUserQuestion is shown as the question it parks on, below.
            if (name === 'AskUserQuestion') return;
            const { verb, target } = toolLabel(name, input);
            const toolUseId = String(block['id'] ?? bid);
            this.tools.set(toolUseId, this.items.length);
            const agent: AgentView | undefined = name === 'Agent' || name === 'Task'
              ? {
                  type: typeof input['subagent_type'] === 'string' ? input['subagent_type'] : null,
                  // The SDK's default, so an unsaid flag is background too. A
                  // foreground call's result corrects it.
                  background: input['run_in_background'] !== false,
                  status: 'running', progress: null, usage: null, steps: [], dropped: 0, endedAt: null,
                }
              : undefined;
            this.items.push({
              kind: 'tool', id: bid, toolUseId, name, verb, target, input: clip(JSON.stringify(input, null, 2), INPUT_MAX).text, result: null,
              ...(agent ? { agent } : {}), at,
            });
          }
        });
        return;
      }

      case 'tool_result': {
        const sub = Boolean(payload['parent_tool_use_id']);
        const content = (payload['message'] as { content?: unknown } | undefined)?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (!isRecord(block) || block['type'] !== 'tool_result') continue;
          const toolUseId = String(block['tool_use_id'] ?? '');
          const index = sub ? undefined : this.tools.get(toolUseId);
          const top = index === undefined ? undefined : this.items[index];
          const item = sub ? this.steps.get(toolUseId) : top?.kind === 'tool' ? top : undefined;
          if (!item) continue;
          const text = resultText(block['content']);
          const isError = block['is_error'] === true;
          item.result = { ...clip(text, RESULT_MAX), isError, seq: event.seq };
          // A foreground subagent ends with its call. A background one's call
          // only says it was launched; its end is a task_notification.
          if (!sub && top?.kind === 'tool' && top.agent && (isError || !/^Async agent launched/.test(text))) {
            top.agent.status = isError ? 'failed' : 'completed';
            top.agent.background = false;
            top.agent.endedAt = at;
          } else if (!sub && top?.kind === 'tool' && top.agent) {
            top.agent.background = true;
          }
        }
        return;
      }

      case 'system:task_started':
      case 'system:task_progress':
      case 'system:task_notification': {
        const index = typeof payload['tool_use_id'] === 'string' ? this.tools.get(payload['tool_use_id']) : undefined;
        const item = index === undefined ? undefined : this.items[index];
        // The subagent's own commands report as tasks too, under ids of their
        // own: only the task an Agent call launched is shown.
        if (item?.kind !== 'tool' || !item.agent) return;
        const agent = item.agent;
        if (event.kind === 'system:task_started') {
          if (payload['is_backgrounded'] === true) agent.background = true;
          return;
        }
        const usage = payload['usage'];
        if (isRecord(usage)) {
          agent.usage = {
            tokens: Number(usage['total_tokens'] ?? 0),
            toolUses: Number(usage['tool_uses'] ?? 0),
            durationMs: Number(usage['duration_ms'] ?? 0),
          };
        }
        if (event.kind === 'system:task_progress') {
          if (typeof payload['summary'] === 'string' && payload['summary'].trim()) agent.progress = payload['summary'].trim();
          return;
        }
        const status = payload['status'];
        agent.status = status === 'failed' ? 'failed' : status === 'stopped' ? 'stopped' : 'completed';
        agent.endedAt = at;
        return;
      }

      case 'ask': {
        const askId = typeof payload['id'] === 'string' ? payload['id'] : null;
        const request: AskView = payload['kind'] === 'question'
          ? { kind: 'question', questions: (payload['questions'] as AskQuestionView[] | undefined) ?? [] }
          : {
            kind: 'permission',
            toolName: String(payload['toolName'] ?? 'a tool'),
            input: isRecord(payload['input']) ? payload['input'] : {},
            ...(typeof payload['session'] === 'string' ? { session: payload['session'] } : {}),
          };
        if (askId) this.asks.set(askId, this.items.length);
        this.items.push({ kind: 'ask', id, askId, request, outcome: null, ...(payload['agent'] === 'worker' ? { agent: 'worker' as const } : {}), at });
        return;
      }

      case 'ask_answered': {
        const outcome = payload as unknown as AskOutcome;
        const index = typeof payload['askId'] === 'string' ? this.asks.get(payload['askId']) : undefined;
        const item = index === undefined ? undefined : this.items[index];
        if (item?.kind === 'ask') {
          item.outcome = outcome;
          return;
        }
        // VIBES MODE answers a question without parking on it: there is no
        // ask to attach to, so the answer stands on its own.
        if (outcome.kind === 'question') {
          this.items.push({
            kind: 'ask', id, askId: null,
            request: { kind: 'question', questions: Object.keys(outcome.answers).map((q) => ({ question: q, options: [] })) },
            outcome, at,
          });
        }
        return;
      }

      case 'refused':
        this.items.push({
          kind: 'refused', id,
          toolUseId: String(payload['toolUseId'] ?? ''),
          toolName: String(payload['toolName'] ?? 'a tool'),
          input: isRecord(payload['input']) ? payload['input'] : {},
          allowed: false,
          ...(payload['agent'] === 'worker' ? { agent: 'worker' as const } : {}),
          at,
        });
        return;

      case 'allowed': {
        const item = this.items.find((i) => i.kind === 'refused' && i.toolUseId === payload['toolUseId']);
        if (item?.kind === 'refused') item.allowed = true;
        return;
      }

      case 'submitted':
        this.items.push({ kind: 'submitted', id, summary: String(payload['summary'] ?? ''), at });
        return;

      case 'error':
        this.items.push({ kind: 'error', id, text: String(payload['message'] ?? 'error'), at });
        return;
    }
  }

  /** One of a subagent's own messages, under the Agent call that launched it. */
  private addStep(payload: Record<string, unknown>, id: string, at: number): void {
    const index = this.tools.get(String(payload['parent_tool_use_id']));
    const parent = index === undefined ? undefined : this.items[index];
    if (parent?.kind !== 'tool' || !parent.agent) return;
    const agent = parent.agent;
    const content = (payload['message'] as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    content.forEach((block: unknown, i) => {
      if (!isRecord(block)) return;
      const bid = `${id}.${i}`;
      if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim()) {
        agent.steps.push({ kind: 'text', id: bid, text: block['text'], at });
      } else if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
        const input = isRecord(block['input']) ? block['input'] : {};
        const { verb, target } = toolLabel(block['name'], input);
        const step: Extract<AgentStep, { kind: 'tool' }> = {
          kind: 'tool', id: bid, toolUseId: String(block['id'] ?? bid), name: block['name'], verb, target,
          input: clip(JSON.stringify(input, null, 2), INPUT_MAX).text, result: null, at,
        };
        this.steps.set(step.toolUseId, step);
        agent.steps.push(step);
      }
    });
    while (agent.steps.length > STEPS_MAX) {
      const gone = agent.steps.shift()!;
      if (gone.kind === 'tool') this.steps.delete(gone.toolUseId);
      agent.dropped++;
    }
  }

  /**
   * What the run is still waiting on a person for: the lead's ask before its
   * worker's, since while a worker runs the two can each be waiting on one.
   */
  pendingAsk(): Extract<ConversationItem, { kind: 'ask' }> | null {
    let worker: Extract<ConversationItem, { kind: 'ask' }> | null = null;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i]!;
      if (item.kind !== 'ask' || item.outcome !== null || !item.askId) continue;
      if (!item.agent) return item;
      worker ??= item;
    }
    return worker;
  }
}

/** A tool call as a verb and the thing it acted on, for one collapsed line. */
export function toolLabel(name: string, input: Record<string, unknown>): { verb: string; target: string } {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  if (name.startsWith('mcp__reeve__submit_')) return { verb: 'Submit', target: name.slice('mcp__reeve__submit_'.length).replace('_', ' ') };
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return { verb: name, target: str('file_path') || str('notebook_path') };
    case 'Bash':
      return { verb: 'Bash', target: str('command').replace(/\s+/g, ' ').trim() };
    case 'Grep':
      return { verb: 'Grep', target: [str('pattern'), str('path') || str('glob')].filter(Boolean).join(' in ') };
    case 'Glob':
      return { verb: 'Glob', target: str('pattern') };
    case 'WebFetch':
      return { verb: 'Fetch', target: str('url') };
    case 'WebSearch':
      return { verb: 'Search', target: str('query') };
    case 'Task':
    case 'Agent':
      return { verb: 'Agent', target: str('description') || str('prompt').slice(0, 80) };
    case 'TodoWrite': {
      const todos = Array.isArray(input['todos']) ? input['todos'].length : 0;
      return { verb: 'Todos', target: `${todos} item${todos === 1 ? '' : 's'}` };
    }
    case 'ToolSearch':
      return { verb: 'Find tool', target: str('query') };
    case 'SendMessage':
      return { verb: 'Message', target: [str('to'), str('summary') || str('message').slice(0, 80)].filter(Boolean).join(': ') };
    case 'TaskStop':
      return { verb: 'Stop', target: str('task_id') };
    case 'SubagentHandback':
      return { verb: 'Report', target: str('message').replace(/\s+/g, ' ').slice(0, 120) };
    default:
      return { verb: name.replace(/^mcp__/, '').replace(/__/g, ' · '), target: Object.values(input).find((v) => typeof v === 'string') as string ?? '' };
  }
}

/**
 * The whole output of one tool call, out of the stored `tool_result` event the
 * conversation clipped it from — what a row shows once it is opened.
 */
export function toolResultIn(payload: unknown, toolUseId: string): string | null {
  const parsed = typeof payload === 'string' ? safeParse(payload) : payload;
  const content = isRecord(parsed) ? (parsed['message'] as { content?: unknown } | undefined)?.content : undefined;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (isRecord(block) && block['type'] === 'tool_result' && block['tool_use_id'] === toolUseId) return resultText(block['content']);
  }
  return null;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (isRecord(b) && b['type'] === 'text' && typeof b['text'] === 'string' ? b['text'] : isRecord(b) && b['type'] === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: `${text.slice(0, max)}…`, truncated: true } : { text, truncated: false };
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
