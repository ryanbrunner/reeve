import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * A live run's input: the stream `query()` reads its user messages from,
 * which stays open between them so a person can talk to Claude while it works.
 *
 * Its first message is the stage's prompt. Anything pushed after that while
 * a tool is running is folded into the same turn at the next tool boundary —
 * the interjection — and anything pushed after a turn has ended starts the
 * next one. No `priority` is sent: `'now'` cuts the turn off instead, with an
 * empty result, which the board would read as Claude having finished. Both
 * measured in spikes/conversation-check.ts.
 *
 * The run closes it at a turn boundary with nothing left to say, and `push`
 * then refuses, synchronously, so a message that loses that race is told so
 * and goes to a resumed session instead of vanishing into a closed stream.
 */
export class Inbox implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private isClosed = false;

  constructor(first: string) {
    this.push(first);
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** Messages pushed that the SDK has not read yet. */
  get pending(): number {
    return this.queue.length;
  }

  /** False once the run has stopped listening: the caller must resume instead. */
  push(text: string): boolean {
    if (this.isClosed) return false;
    const message: SDKUserMessage = {
      type: 'user',
      session_id: '',
      parent_tool_use_id: null,
      message: { role: 'user', content: text },
      timestamp: new Date().toISOString(),
    };
    const w = this.waiting;
    if (w) {
      this.waiting = null;
      w({ value: message, done: false });
    } else {
      this.queue.push(message);
    }
    return true;
  }

  close(): void {
    this.isClosed = true;
    const w = this.waiting;
    if (w) {
      this.waiting = null;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const head = this.queue.shift();
        if (head) return Promise.resolve({ value: head, done: false });
        if (this.isClosed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
