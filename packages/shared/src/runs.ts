export const RUN_KINDS = ['claude', 'shell', 'server'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_STATUSES = [
  'queued',
  'running',
  // Live, but parked mid-turn on a person: a permission auto mode escalated,
  // or a question Claude asked with AskUserQuestion. The process is held open
  // until they answer, the request times out, or the run is stopped.
  'asking',
  'stopping',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  // Claude ended its turn without submitting the stage's work: it asked
  // something in plain text, or answered something it was asked. Terminal, and
  // not an error — the conversation goes on when the person replies, which
  // forks this session the way every follow-up does.
  'awaiting_reply',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * How hard Claude is asked to think, lowest first. The SDK's own vocabulary;
 * which of these a given model accepts is its `supportedEffortLevels`.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

const TERMINAL: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled', 'interrupted', 'awaiting_reply'];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.includes(status);
}

/**
 * Why a run stopped, recorded from the harness's own state.
 *
 * Deliberately NOT derived from the SDK result message: an aborted run was
 * measured emitting `subtype=success, terminal_reason=completed`, so trusting
 * the result would mark cancelled runs as successful.
 */
export const STOP_REASONS = [
  'completed',
  'cancelled_by_user',
  'budget_exhausted',
  'max_turns',
  'invalid_output',
  'sdk_error',
  'process_died',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/**
 * Recovery affordances. These are not interchangeable: resume continues the same
 * session (right when the run just needs more room), retry forks a fresh one
 * (right when the accumulated context is itself the problem).
 */
export function recoveryFor(status: RunStatus, reason: StopReason | null): Array<'resume' | 'retry'> {
  if (status === 'succeeded' || status === 'awaiting_reply') return [];
  if (reason === 'invalid_output') return ['retry'];
  if (reason === 'budget_exhausted' || reason === 'max_turns' || status === 'interrupted' || status === 'cancelled') {
    return ['resume', 'retry'];
  }
  return ['retry', 'resume'];
}
