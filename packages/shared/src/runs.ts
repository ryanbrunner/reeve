export const RUN_KINDS = ['claude', 'shell', 'server'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_STATUSES = [
  'queued',
  'running',
  'stopping',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

const TERMINAL: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled', 'interrupted'];

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
  if (status === 'succeeded') return [];
  if (reason === 'invalid_output') return ['retry'];
  if (reason === 'budget_exhausted' || reason === 'max_turns' || status === 'interrupted' || status === 'cancelled') {
    return ['resume', 'retry'];
  }
  return ['retry', 'resume'];
}
