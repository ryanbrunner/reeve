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
 * A subagent's own messages are skipped too — what it was asked and what it
 * reported are already the Task call and its result.
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
  | { kind: 'permission'; toolName: string; input: Record<string, unknown> }
  | { kind: 'question'; questions: AskQuestionView[] };

export type AskOutcome =
  | { kind: 'permission'; allow: boolean; reason?: string | null; actor: 'human' | 'claude' }
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
      at: number;
    }
  | { kind: 'ask'; id: string; askId: string | null; request: AskView; outcome: AskOutcome | null; at: number }
  /** A call auto mode's classifier refused on its own, which a person may allow once. */
  | { kind: 'refused'; id: string; toolUseId: string; toolName: string; input: Record<string, unknown>; allowed: boolean; at: number }
  | { kind: 'submitted'; id: string; summary: string; at: number }
  | { kind: 'error'; id: string; text: string; at: number };

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
 * Folds one run's events into its items. Mutable and cheap to call once per
 * event: the modal keeps one per live run.
 */
export class RunProjector {
  readonly items: ConversationItem[] = [];
  lastSeq = 0;
  private readonly tools = new Map<string, number>();
  private readonly asks = new Map<string, number>();

  constructor(prompt?: string | null) {
    if (prompt?.trim()) this.items.push({ kind: 'prompt', id: 'prompt', text: prompt });
  }

  /**
   * Carry on from a run already projected — the server's `/conversation` —
   * so the live tail folds in only what came after it.
   */
  static resume(run: Pick<ConversationRun, 'items' | 'lastSeq'>): RunProjector {
    const p = new RunProjector();
    p.items.push(...run.items.map((i) => ({ ...i })) as ConversationItem[]);
    p.lastSeq = run.lastSeq;
    p.items.forEach((item, index) => {
      if (item.kind === 'tool') p.tools.set(item.toolUseId, index);
      if (item.kind === 'ask' && item.askId) p.asks.set(item.askId, index);
    });
    return p;
  }

  /** The event kinds `add` reads, for an EventSource that must name what it listens to. */
  static readonly KINDS = ['user_message', 'assistant', 'tool_result', 'ask', 'ask_answered', 'refused', 'allowed', 'submitted', 'error'] as const;

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
        // A subagent's own turns: its call and result already say enough.
        if (payload['parent_tool_use_id']) return;
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
            this.items.push({ kind: 'tool', id: bid, toolUseId, name, verb, target, input: clip(JSON.stringify(input, null, 2), INPUT_MAX).text, result: null, at });
          }
        });
        return;
      }

      case 'tool_result': {
        if (payload['parent_tool_use_id']) return;
        const content = (payload['message'] as { content?: unknown } | undefined)?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (!isRecord(block) || block['type'] !== 'tool_result') continue;
          const index = this.tools.get(String(block['tool_use_id'] ?? ''));
          const item = index === undefined ? undefined : this.items[index];
          if (!item || item.kind !== 'tool') continue;
          const { text, truncated } = clip(resultText(block['content']), RESULT_MAX);
          item.result = { text, isError: block['is_error'] === true, truncated, seq: event.seq };
        }
        return;
      }

      case 'ask': {
        const askId = typeof payload['id'] === 'string' ? payload['id'] : null;
        const request: AskView = payload['kind'] === 'question'
          ? { kind: 'question', questions: (payload['questions'] as AskQuestionView[] | undefined) ?? [] }
          : { kind: 'permission', toolName: String(payload['toolName'] ?? 'a tool'), input: isRecord(payload['input']) ? payload['input'] : {} };
        if (askId) this.asks.set(askId, this.items.length);
        this.items.push({ kind: 'ask', id, askId, request, outcome: null, at });
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

  /** The asks still waiting on a person. Only ever the last one, in practice. */
  pendingAsk(): Extract<ConversationItem, { kind: 'ask' }> | null {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i]!;
      if (item.kind === 'ask') return item.outcome === null && item.askId ? item : null;
    }
    return null;
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
