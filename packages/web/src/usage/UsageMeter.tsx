import { useEffect, useState } from 'react';
import type { UsageLevel, UsageState, UsageWindow } from '@reeve/shared';
import { duration } from '../card/format.js';

/**
 * The subscription's rate limits, as the last Claude run reported them: a
 * readout in the header, and a strip under it once either limit is close.
 *
 * Both say nothing at all without a reading. Under API-key auth there never is
 * one, and a 0% there would be a number nobody measured.
 */

const WINDOWS = [
  { key: 'fiveHour', short: '5H', long: '5-hour' },
  { key: 'sevenDay', short: '7D', long: '7-day' },
] as const;

const PILL: Record<UsageLevel, string> = {
  ok: 'border-(--color-edge)',
  warning: 'border-(--color-activity-input-border)',
  rejected: 'border-(--color-activity-error-border)',
};

const FIGURE: Record<UsageLevel, string> = {
  ok: '',
  warning: 'font-semibold text-(--color-activity-input-mark)',
  rejected: 'font-semibold text-(--color-activity-error-mark)',
};

const pct = (w: UsageWindow) => `${Math.round(w.utilization * 100)}%`;

/** `5H 93% · 7D 23%`, beside the card count. Only the window that is close takes the colour. */
export function UsageMeter({ usage }: { usage: UsageState | null }) {
  if (!usage) return null;
  const shown = WINDOWS.flatMap((d) => {
    const w = usage[d.key];
    return w ? [{ ...d, w }] : [];
  });
  return (
    <span
      className={`shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[11px]/4 font-medium tracking-[0.06em] whitespace-nowrap text-(--color-muted) ${PILL[usage.level]}`}
      title={shown
        .map(({ long, w }) =>
          // A window past its reset is shown at 0%; a reset time in the past would contradict it.
          w.resetsAt > Date.now() ? `${long} limit resets ${resetTime(w.resetsAt)}` : `${long} limit has reset`,
        )
        .join(' · ')}
    >
      {shown.map(({ key, short, w }, i) => (
        <span key={key}>
          {i > 0 && ' · '}
          {short} <span className={FIGURE[w.level]}>{pct(w)}</span>
        </span>
      ))}
    </span>
  );
}

// Laid over the board's ink rather than straight onto whatever is behind: in
// SICKO MODE that is the lights, and the warning is the one thing on the board
// that has to stay legible.
const STRIP = {
  warning: {
    style: { background: 'linear-gradient(var(--color-activity-input-fill), var(--color-activity-input-fill)), var(--color-ink)' },
    className: 'border-(--color-activity-input-border) text-amber-100',
    dot: 'bg-(--color-activity-input-mark)',
    lead: 'text-amber-200',
  },
  rejected: {
    style: { background: 'linear-gradient(var(--color-activity-error-fill), var(--color-activity-error-fill)), var(--color-ink)' },
    className: 'border-(--color-activity-error-border) text-red-100',
    dot: 'bg-(--color-activity-error-mark)',
    lead: 'text-red-200',
  },
} as const;

/**
 * The strip under the header, while either window is at the server's warning
 * line or past it.
 *
 * Rejected says outright that runs will fail. Nothing stops them being started
 * — SICKO MODE keeps starting them — so this is the only thing that says why
 * each one dies on arrival.
 */
export function UsageWarning({ usage }: { usage: UsageState | null }) {
  const now = useNow(30_000);
  if (!usage || usage.level === 'ok') return null;
  const tone = STRIP[usage.level];
  const close = WINDOWS.flatMap((d) => {
    const w = usage[d.key];
    return w && w.level !== 'ok' ? [{ ...d, w }] : [];
  });
  return (
    <div
      role="status"
      className={`flex items-center gap-2.5 border-b px-4 py-1.5 text-xs/5 ${tone.className}`}
      style={tone.style}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
      <p className="min-w-0 flex-1">
        {close.map(({ key, long, w }, i) => (
          <span key={key}>
            {i > 0 && ' '}
            <strong className={`font-semibold ${tone.lead}`}>{long} limit {pct(w)} used.</strong>{' '}
            {w.level === 'rejected' ?
              `Runs will fail until it resets at ${resetTime(w.resetsAt)}.`
            : `Runs will start failing at 100%. Resets at ${resetTime(w.resetsAt)}.`}
          </span>
        ))}
      </p>
      {/* The reading only moves while Reeve is running something, and Claude
          used anywhere else spends the same limits. */}
      <span className="shrink-0 font-mono text-[11px]/4 tracking-[0.06em] whitespace-nowrap text-(--color-muted)">
        as of {ago(now - usage.asOf)}
      </span>
    </div>
  );
}

/**
 * Clock time, with the day in front when it is not today. Not `when`, which
 * drops the time for any other day: a 7-day reset — or a 5-hour one past
 * midnight — is no use as a bare date.
 */
function resetTime(ms: number): string {
  const d = new Date(ms);
  const clock = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return d.toDateString() === new Date().toDateString()
    ? clock
    : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${clock}`;
}

/** To the minute: the reading is only as fresh as the last run, and seconds would suggest otherwise. */
function ago(ms: number): string {
  return ms < 60_000 ? 'just now' : `${duration(Math.floor(ms / 60_000) * 60_000)} ago`;
}

/**
 * The board only re-renders when a poll brings something new, and a quiet
 * board brings nothing — so the age would sit still without a clock of its own.
 */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
