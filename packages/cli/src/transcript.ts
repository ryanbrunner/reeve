/**
 * A run's transcript as lines for a terminal.
 *
 * Fuller than `describeParsed` in @reeve/shared, which boils each message down
 * to the one phrase the card's band has room for: here there is a whole
 * terminal, and the text Claude wrote is the thing worth reading. Still
 * shallow in the same way — a kind this does not know is skipped rather than
 * dumped, and `--json` is there for anything that wants all of it.
 *
 * Kinds are the event names the server writes: a Claude run's are classified
 * in the server's runs/claude.ts, a shell run's in runs/shell.ts.
 */

const MAX = 160;

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
  is_error?: boolean;
  content?: unknown;
}

/** The input field that says which call it was, in the order a person would look for one. */
const INPUT_KEYS = ['command', 'file_path', 'pattern', 'url', 'query', 'description', 'path'] as const;

const oneLine = (text: string) => {
  const first = text.trim().split('\n')[0] ?? '';
  return first.length > MAX ? `${first.slice(0, MAX - 1)}…` : first;
};

function toolCall(block: Block): string {
  const input = block.input ?? {};
  const key = INPUT_KEYS.find((k) => typeof input[k] === 'string' && input[k]);
  return key ? `→ ${block.name} ${oneLine(input[key] as string)}` : `→ ${block.name}`;
}

/** A tool result's text, whichever of its two shapes it came in. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[]).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n');
}

const blocksOf = (payload: { message?: { content?: unknown } }): Block[] => {
  const content = payload.message?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
};

export function renderEvent(kind: string, data: string): string[] {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return [];
  }

  switch (kind) {
    case 'system:init':
      return [`· session started${typeof payload.model === 'string' ? ` on ${payload.model}` : ''}`];

    case 'assistant': {
      const lines: string[] = [];
      for (const block of blocksOf(payload)) {
        if (block.type === 'text' && block.text?.trim()) lines.push(block.text.trim());
        else if (block.type === 'tool_use' && block.name) lines.push(toolCall(block));
        // Empty unless summaries were asked for, which is most of the time.
        else if (block.type === 'thinking' && block.thinking?.trim()) {
          lines.push(...block.thinking.trim().split('\n').map((l) => `  ┆ ${l}`));
        }
      }
      return lines;
    }

    // What a tool gave back is the bulk of any transcript and rarely worth a
    // line. A failure is: it is usually why the next thing Claude did happened.
    case 'tool_result':
      return blocksOf(payload)
        .filter((b) => b.type === 'tool_result' && b.is_error)
        .map((b) => `  ✗ ${oneLine(resultText(b.content)) || 'tool failed'}`);

    case 'result': {
      const parts = [String(payload.subtype ?? 'finished')];
      if (typeof payload.num_turns === 'number') parts.push(`${payload.num_turns} turns`);
      if (typeof payload.total_cost_usd === 'number') parts.push(`$${payload.total_cost_usd.toFixed(3)}`);
      return [`· result: ${parts.join(', ')}`];
    }

    case 'error':
      return [`! ${String(payload.message ?? 'error')}`];

    // A stage is a conversation: what the person said, what Claude asked,
    // and what it submitted are the turns worth seeing.
    case 'user_message': {
      const who = payload.actor === 'claude' ? 'VIBES MODE' : 'you';
      const via = typeof payload.source === 'string' && payload.source !== 'chat' ? ` (${payload.source})` : '';
      return [`» ${who}${via}: ${oneLine(String(payload.text ?? ''))}`];
    }
    case 'ask': {
      if (payload.kind === 'question') {
        const qs = Array.isArray(payload.questions) ? (payload.questions as Array<{ question?: string; options?: Array<{ label?: string }> }>) : [];
        return qs.map((q) => `? Claude asks: ${q.question ?? ''}${q.options?.length ? ` [${q.options.map((o) => o.label).join(' / ')}]` : ''}`);
      }
      const input = (payload.input ?? {}) as Record<string, unknown>;
      const what = typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : '';
      return [`? Claude asks to use ${String(payload.toolName ?? 'a tool')}${what ? `: ${oneLine(what)}` : ''} — reeve card permit <card> allow|deny`];
    }
    case 'ask_answered': {
      if (payload.kind === 'permission') return [`· ${payload.allow ? 'allowed' : 'denied'}${payload.reason ? `: ${oneLine(String(payload.reason))}` : ''}`];
      if (payload.kind === 'question') return [`· answered: ${Object.values((payload.answers ?? {}) as Record<string, string>).join('; ')}`];
      return [`· not answered (${String(payload.why ?? '')})`];
    }
    case 'submitted':
      return [`◆ submitted: ${oneLine(String(payload.summary ?? ''))}`];

    case 'command':
      return [`$ ${String(payload.command ?? '')}`];
    case 'stdout':
    case 'stderr':
      return [String(payload.line ?? '')];
    case 'exit':
      return [`· exited ${payload.code ?? payload.signal ?? ''}`.trimEnd()];

    default:
      return [];
  }
}
