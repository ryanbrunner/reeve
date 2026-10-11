/**
 * Reading one line of "what is happening" out of a run's transcript.
 *
 * Lives here rather than in the web package so the spike that checks it against
 * real SDK messages is checking the function the modal actually calls. A copy
 * in a test is a test of the copy.
 *
 * Deliberately shallow. The stream carries forty-odd message shapes and this
 * needs two facts: the most recent human-readable thing to say about what
 * Claude is doing, and the latest summary of its reasoning. Anything unrecognised is skipped rather than guessed at — the
 * band showing nothing is much better than the band being confidently wrong.
 */

export interface TranscriptLine {
  /** One short phrase, or null when the message carried nothing to say. */
  text: string | null;
  /**
   * A summary of Claude's reasoning, whole. Kept apart from `text` because it
   * runs to paragraphs, and the first-line cut `text` gets would leave almost
   * nothing of it. Absent on anything that is not a thinking block; null on
   * one whose text was omitted or redacted.
   */
  thinking?: string | null;
}

/** Longest a line may be before the band would wrap. */
const MAX = 120;

/** The loose shape the fields read here are found in, whatever the message type. */
export interface TranscriptMessage {
  type?: string;
  subtype?: string;
  message?: { content?: unknown };
  /** Set on a subagent's own messages: the Agent call that launched it. */
  parent_tool_use_id?: string | null;
  /** On `system:task_progress`, every half minute or so, when summaries are asked for. */
  summary?: string;
}

export function describeMessage(raw: string): TranscriptLine | null {
  let msg: TranscriptMessage;
  try {
    msg = JSON.parse(raw) as TranscriptMessage;
  } catch {
    return null;
  }
  return describeParsed(msg);
}

/** describeMessage for a message already in hand, as the server has it. */
export function describeParsed(msg: TranscriptMessage): TranscriptLine | null {
  // Sent while Claude is still thinking, before the block itself lands. Says
  // so, rather than leaving the last tool call on screen as if it were current.
  if (msg.type === 'system' && msg.subtype === 'thinking_tokens') return { text: 'thinking' };
  // A background worker's own summary of where it has got to: the best line
  // there is while the lead sits waiting for it.
  if (msg.type === 'system' && msg.subtype === 'task_progress' && msg.summary?.trim()) {
    return { text: `worker: ${msg.summary.trim().split('\n')[0]!.slice(0, MAX - 8)}` };
  }
  if (msg.type !== 'assistant') return null;
  // A subagent's step, said as one, and never its reasoning: the band's
  // thinking is the lead's, which is what a person is talking to.
  if (msg.parent_tool_use_id) {
    const line = describeParsed({ ...msg, parent_tool_use_id: null });
    return line?.text ? { text: `worker: ${line.text}`.slice(0, MAX) } : null;
  }

  const content = msg.message?.content;
  if (!Array.isArray(content)) return { text: null };

  let thinking: TranscriptLine | null = null;
  for (const block of content as Array<{ type?: string; name?: string; text?: string; thinking?: string }>) {
    if (block.type === 'tool_use' && block.name) return { text: toolLine(block.name) };
    if (block.type === 'text' && block.text?.trim()) {
      return { text: block.text.trim().split('\n')[0]!.slice(0, MAX) };
    }
    // Unless summaries are asked for, the block arrives with an empty string
    // and only a signature, so there may be nothing to show even though Claude
    // did think.
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      thinking ??= { text: 'thinking', thinking: block.thinking?.trim() || null };
    }
  }
  return thinking ?? { text: null };
}

/** What Claude was last doing and last thinking, as the band shows it. */
export interface Thought {
  activity: string | null;
  thinking: string | null;
}

/**
 * Folds one line into the last thought. The server stores the result and the
 * modal shows it, so both go through here and cannot disagree about what a
 * line replaces.
 *
 * A line only ever adds. An empty or redacted thinking block leaves the last
 * summary standing, and `thinking_tokens` moves the activity without touching
 * the summary — the reasoning it announces has not arrived yet.
 */
export function nextThought(prev: Thought, line: TranscriptLine): Thought {
  return {
    activity: line.text ?? prev.activity,
    thinking: line.thinking ?? prev.thinking,
  };
}

/** A tool's name as a thing someone is doing, not as an API surface. */
function toolLine(name: string): string {
  switch (name) {
    case 'Read':
      return 'reading a file';
    case 'Glob':
    case 'Grep':
      return 'searching the codebase';
    case 'Edit':
    case 'Write':
      return 'editing a file';
    case 'Bash':
      return 'running a command';
    default:
      return `using ${name}`;
  }
}
