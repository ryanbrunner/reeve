/**
 * Turning machine facts into things a person reads.
 *
 * All of it deliberately terse: the design puts these in 11px mono beside
 * something that matters more, so "8m 40s" earns its place and
 * "8 minutes, 40 seconds ago" does not.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** A duration, at the coarsest unit that still says something. */
export function duration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${pad(s % 60)}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

/** Clock time for today, a date for anything older. Nobody needs "Sep 24" today. */
export function when(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  return sameDay
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Costs are small and the third decimal is where the difference lives. */
export function cost(usd: number | null | undefined): string {
  return usd == null ? '—' : `$${usd.toFixed(3)}`;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
