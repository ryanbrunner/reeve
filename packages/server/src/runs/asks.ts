import type { CardEventActor } from '../db/schema.js';

/**
 * What a live run is waiting on a person for, mid-turn: a call auto mode
 * escalated rather than decided, or a question Claude put with
 * AskUserQuestion. Either holds the run's process open, its status `asking`,
 * until someone answers, the request times out, or the run is stopped.
 *
 * In memory, like the runs themselves: a restart reaps the run, and its ask
 * goes with it. The request and its answer are also written to the run's
 * events, which is what the conversation shows; this is only the half that
 * can resolve a promise.
 */
export interface AskQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export type AskRequest =
  | { kind: 'permission'; toolName: string; input: Record<string, unknown> }
  | { kind: 'question'; questions: AskQuestion[] };

export type AskAnswer =
  | { kind: 'permission'; allow: boolean; reason?: string | null; actor: CardEventActor }
  | { kind: 'question'; answers: Record<string, string>; actor: CardEventActor }
  /** Nobody answered in time, or the run was stopped first. */
  | { kind: 'unanswered'; why: 'timeout' | 'stopped' };

export type PendingAsk = AskRequest & {
  id: string;
  runId: string;
  cardId: string;
  createdAt: number;
};

interface Entry {
  ask: PendingAsk;
  settle: (answer: AskAnswer) => void;
  timer: NodeJS.Timeout;
}

class AskRegistry {
  private readonly open = new Map<string, Entry>();

  /**
   * Park until answered. One ask per run at a time is all the SDK produces —
   * a turn waits on its permission before it does anything else — so the run
   * id is enough to find it again.
   */
  wait(runId: string, cardId: string, request: AskRequest, timeoutMs: number): { ask: PendingAsk; answer: Promise<AskAnswer> } {
    const ask = { ...request, id: crypto.randomUUID(), runId, cardId, createdAt: Date.now() } as PendingAsk;
    let settle!: (answer: AskAnswer) => void;
    const answer = new Promise<AskAnswer>((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => this.settle(ask.id, { kind: 'unanswered', why: 'timeout' }), timeoutMs);
    this.open.set(ask.id, { ask, settle, timer });
    return { ask, answer };
  }

  /** False when it is no longer open: answered already, timed out, or stopped. */
  settle(askId: string, answer: AskAnswer): boolean {
    const entry = this.open.get(askId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.open.delete(askId);
    entry.settle(answer);
    return true;
  }

  forRun(runId: string): PendingAsk | undefined {
    for (const { ask } of this.open.values()) if (ask.runId === runId) return ask;
    return undefined;
  }

  forCard(cardId: string): PendingAsk | undefined {
    for (const { ask } of this.open.values()) if (ask.cardId === cardId) return ask;
    return undefined;
  }

  /** On Stop, so the run's turn can unwind and the stop can finish. */
  stopRun(runId: string): void {
    for (const { ask } of [...this.open.values()]) {
      if (ask.runId === runId) this.settle(ask.id, { kind: 'unanswered', why: 'stopped' });
    }
  }
}

export const askRegistry = new AskRegistry();

/**
 * A person's typed message, read as the answer to what the run is waiting on:
 * for a question, their own answer to every question it put; for a
 * permission, a refusal with their words as the reason — the composer's
 * "Deny, and say why".
 */
export function answerFromText(ask: PendingAsk, text: string, actor: CardEventActor): AskAnswer {
  if (ask.kind === 'question') {
    return { kind: 'question', answers: Object.fromEntries(ask.questions.map((q) => [q.question, text])), actor };
  }
  return { kind: 'permission', allow: false, reason: text, actor };
}

/**
 * Calls a person has allowed once, after auto mode's classifier refused them.
 *
 * The classifier decides most refusals itself, without ever asking
 * `canUseTool`, so parking on an escalation alone would leave a person nothing
 * to approve for the calls that are actually refused. Instead the refusal is
 * shown in the conversation; a person's Allow once puts the exact call here,
 * Claude is told to make it again, and the run's PreToolUse hook lets that one
 * call through — a hook's allow is honoured over the classifier, checked by
 * spike. Exact means the same tool and the same input: for Bash the command
 * itself, since the description beside it is Claude's to reword.
 */
export interface Allowance {
  toolName: string;
  key: string;
  expiresAt: number;
}

/** How long an allowance waits for Claude to make the call again. */
const ALLOWANCE_MS = 30 * 60_000;

export function callKey(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof input['command'] === 'string') return input['command'].trim();
  const { description: _description, ...rest } = input;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

class Allowances {
  private readonly byCard = new Map<string, Allowance[]>();

  grant(cardId: string, toolName: string, input: Record<string, unknown>): void {
    const list = (this.byCard.get(cardId) ?? []).filter((a) => a.expiresAt > Date.now());
    list.push({ toolName, key: callKey(toolName, input), expiresAt: Date.now() + ALLOWANCE_MS });
    this.byCard.set(cardId, list);
  }

  /** True, once, for a call a person allowed. */
  take(cardId: string, toolName: string, input: Record<string, unknown>): boolean {
    const list = this.byCard.get(cardId);
    if (!list) return false;
    const key = callKey(toolName, input);
    const i = list.findIndex((a) => a.toolName === toolName && a.key === key && a.expiresAt > Date.now());
    if (i < 0) return false;
    list.splice(i, 1);
    return true;
  }
}

export const allowances = new Allowances();
