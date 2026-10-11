import type { ApiRunPulse } from '@reeve/shared';
import { duration } from './format.js';

/**
 * Reading a live run's pulse as a person wants it: is it working, and on
 * what, or has it gone quiet? One reading, so the card face and the modal's
 * status line say the same thing about the same run.
 *
 * A long call is not a stuck run: a test suite can take ten minutes and say
 * nothing. So the call under way is named with how long it has been going,
 * and only silence with nothing under way, or a call far past any normal
 * length, is called out.
 */

/** No word at all for this long, with nothing in flight, reads as possibly stuck. */
export const QUIET_MS = 3 * 60_000;
/** A single call going this long is worth pointing at, even if it is fine. */
export const LONG_CALL_MS = 15 * 60_000;
/** Under this, a call is just what the run is doing; not worth a clock. */
const SHOWN_AFTER_MS = 10_000;

/** Calls that wait on a person or end the turn, rather than doing work. */
const NOT_WORK = new Set(['AskUserQuestion', 'Submit']);

export interface PulseReading {
  /** What to say, or null when there is nothing worth saying beyond "working". */
  text: string | null;
  /** `warn` is amber: quiet too long, or a call far past normal. */
  tone: 'calm' | 'warn';
}

export function readPulse(pulse: ApiRunPulse | null | undefined, now: number, lastLiveAt?: number | null): PulseReading {
  if (!pulse) return { text: null, tone: 'calm' };
  const work = pulse.inFlight.filter((c) => !NOT_WORK.has(c.verb));
  // The newest call in the foreground is what the run is doing now; an older
  // one still open is usually the call that launched it, like an agent's.
  const current = work.filter((c) => !c.background).at(-1);
  if (current) {
    const age = now - current.since;
    if (age < SHOWN_AFTER_MS) return { text: null, tone: 'calm' };
    const what = describe(current);
    return age >= LONG_CALL_MS
      ? { text: `${what} has been running ${duration(age)}`, tone: 'warn' }
      : { text: `${what} · ${duration(age)}`, tone: 'calm' };
  }
  // Nothing in the foreground, but a shell left running in the background —
  // a test suite, most often — is what the run is waiting on. A dev server
  // can run for the whole stage, so it is never called long.
  const shell = work.filter((c) => c.background).at(-1);
  const heard = Math.max(pulse.lastEventAt, lastLiveAt ?? 0);
  const quiet = now - heard;
  if (shell && quiet < LONG_CALL_MS) {
    return quiet >= SHOWN_AFTER_MS ? { text: `waiting on ${describe(shell)} · ${duration(now - shell.since)}`, tone: 'calm' } : { text: null, tone: 'calm' };
  }
  if (quiet >= QUIET_MS) return { text: `No word from Claude for ${duration(quiet)}: it may be stuck`, tone: 'warn' };
  return { text: null, tone: 'calm' };
}

function describe(call: ApiRunPulse['inFlight'][number]): string {
  const who = call.worker ? 'worker: ' : '';
  const verb = call.background ? 'background' : call.verb;
  return `${who}${verb}${call.target ? ` ${call.target}` : ''}`;
}

/** Spend against the budget: `≈ $3.10 of $10`, amber from 80%. */
export function readSpend(pulse: ApiRunPulse | null | undefined): { text: string; tone: 'calm' | 'warn' } | null {
  if (!pulse || pulse.costUsd === null) return null;
  const spent = `${pulse.costExact ? '' : '≈ '}$${pulse.costUsd.toFixed(2)}`;
  if (!pulse.budgetUsd) return { text: spent, tone: 'calm' };
  return {
    text: `${spent} of $${pulse.budgetUsd % 1 === 0 ? pulse.budgetUsd : pulse.budgetUsd.toFixed(2)}`,
    tone: pulse.costUsd >= pulse.budgetUsd * 0.8 ? 'warn' : 'calm',
  };
}

/** Turns against maxTurns, worth saying only once the run is getting close. */
export function readTurns(pulse: ApiRunPulse | null | undefined): string | null {
  if (!pulse?.maxTurns || pulse.turns < pulse.maxTurns * 0.8) return null;
  return `${pulse.turns} of ${pulse.maxTurns} turns`;
}
