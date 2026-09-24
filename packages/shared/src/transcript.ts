/**
 * Reading one line of "what is happening" out of a run's transcript.
 *
 * Lives here rather than in the web package so the spike that checks it against
 * real SDK messages is checking the function the modal actually calls. A copy
 * in a test is a test of the copy.
 *
 * Deliberately shallow. The stream carries forty-odd message shapes and this
 * needs exactly two facts: whether a turn happened, and the most recent
 * human-readable thing to say after the turn count. Anything unrecognised is
 * skipped rather than guessed at — the band showing nothing is much better
 * than the band being confidently wrong.
 */

export interface TranscriptLine {
  /** One short phrase, or null when the message carried nothing to say. */
  text: string | null;
  /** Whether this message counts as a turn Claude took. */
  turn: boolean;
}

/** Longest a line may be before the band would wrap. */
const MAX = 120;

export function describeMessage(raw: string): TranscriptLine | null {
  let msg: { type?: string; message?: { content?: unknown } };
  try {
    msg = JSON.parse(raw) as typeof msg;
  } catch {
    return null;
  }
  if (msg.type !== 'assistant') return null;

  const content = msg.message?.content;
  if (!Array.isArray(content)) return { text: null, turn: true };

  for (const block of content as Array<{ type?: string; name?: string; text?: string }>) {
    if (block.type === 'tool_use' && block.name) return { text: toolLine(block.name), turn: true };
    if (block.type === 'text' && block.text?.trim()) {
      return { text: block.text.trim().split('\n')[0]!.slice(0, MAX), turn: true };
    }
  }
  return { text: null, turn: true };
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
