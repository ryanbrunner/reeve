import type { ApiRunSummary, ApiTokenBreakdown } from '@reeve/shared';

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

/** A path under a home directory, from `~`: the part that tells two apart is at the end. */
export function fromHome(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~');
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

const UNITS = ['k', 'M', 'B'] as const;

/**
 * A token count, compact: "840", "1.4 k", "412 k", "2 M".
 *
 * Exact under a thousand, then one decimal while it still says something and
 * whole numbers once it does not. The unit is chosen after rounding, so
 * 999,950 is "1 M" rather than "1000 k". Not `Intl.NumberFormat`'s compact
 * notation, which writes "1.4K" and rounds differently from one locale to the
 * next. The space is non-breaking because the card footer wraps.
 */
export function tokens(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1000) return String(Math.round(n));
  let unit = 0;
  let v = n / 1000;
  const round = (x: number) => (x < 10 ? Math.round(x * 10) / 10 : Math.round(x));
  while (round(v) >= 1000 && unit < UNITS.length - 1) {
    v /= 1000;
    unit++;
  }
  // `String` drops a trailing ".0" on its own: 2 M, not 2.0 M.
  return `${round(v)} ${UNITS[unit]}`;
}

/** With its unit, which a bare "1.4 k" no longer has a `$` to say. Never split across a line. */
export function tok(n: number | null | undefined): string {
  return n == null ? '—' : `${tokens(n)} tok`;
}

/**
 * What a token figure is made of, for its tooltip. Cache reads are listed but
 * marked, so the parts on screen visibly add up to the figure they explain.
 */
export function tokenTitle(b: ApiTokenBreakdown | null | undefined): string | undefined {
  if (!b) return undefined;
  const n = (x: number) => x.toLocaleString();
  return [
    `${n(b.input)} input`,
    `${n(b.output)} output`,
    `${n(b.cacheWrite)} cache write`,
    `${n(b.cacheRead)} cache read, not counted`,
  ].join('\n');
}

/**
 * Several runs' tokens as one figure, with the breakdown summed alongside so a
 * total's tooltip adds up the same way a run's does. Null while none of them
 * has a count: every one still running, or finished without a result.
 */
export function sumTokens(runs: ApiRunSummary[]): { total: number; breakdown: ApiTokenBreakdown } | null {
  const counted = runs.filter((r) => r.totalTokens != null && r.tokenBreakdown != null);
  if (counted.length === 0) return null;
  const breakdown: ApiTokenBreakdown = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let total = 0;
  for (const r of counted) {
    total += r.totalTokens ?? 0;
    breakdown.input += r.tokenBreakdown?.input ?? 0;
    breakdown.output += r.tokenBreakdown?.output ?? 0;
    breakdown.cacheWrite += r.tokenBreakdown?.cacheWrite ?? 0;
    breakdown.cacheRead += r.tokenBreakdown?.cacheRead ?? 0;
  }
  return { total, breakdown };
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
