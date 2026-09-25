import type { CardActivity } from '@reeve/shared';

/**
 * An error meant for whoever is at the terminal: printed as its message alone,
 * with no stack. Exit code 2 is a usage mistake and gets the usage text too.
 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 = 1,
  ) {
    super(message);
  }
}

export const usageError = (message: string) => new CliError(message, 2);

/** Runs a `parseArgs` call, so an unknown flag or a missing value is a usage error rather than a stack. */
export function parseOrUsage<T>(parse: () => T): T {
  try {
    return parse();
  } catch (e) {
    if ((e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) throw usageError((e as Error).message);
    throw e;
  }
}

/**
 * With `--json`, stdout carries the JSON and nothing else, so another tool can
 * parse it whole. Everything said to a person goes through `note`, to stderr.
 */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function note(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * How much of an id the human output shows. Eight, because that is what a
 * card's worktree and branch are already named after (`reeve/5b701c1d-…`), so
 * the id in a listing is one a person has seen before.
 */
export const SHORT_ID = 8;

export const shortId = (id: string) => id.slice(0, SHORT_ID);

/** `needs_review` as `needs review`. */
export const activityLabel = (activity: CardActivity) => activity.replace(/_/g, ' ');

export function formatCost(usd: number | null): string {
  return usd === null ? '-' : `$${usd.toFixed(3)}`;
}

export function formatTime(ms: number | null): string {
  if (ms === null) return '-';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Rows of cells as aligned columns, two spaces apart, one line per row. Put
 * the long free-text cell last: it is never padded, so a long title runs on
 * rather than pushing every other column across.
 */
export function table(rows: string[][], indent = ''): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) => (indent + row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ')).trimEnd());
}
