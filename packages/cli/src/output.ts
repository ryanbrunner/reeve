import type { ApiCard, CardActivity } from '@reeve/shared';

/**
 * An error meant for the person at the terminal: printed as its message alone,
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

/** A whole number from a flag, for `--index` and `--port`. */
export function parseCount(flag: string, value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n)) {
    throw usageError(`--${flag} must be a whole number, not '${value}'`);
  }
  return n;
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

/** The `reeve#142` a person says out loud. A card with no repo is just `#142`. */
export function cardRef(card: Pick<ApiCard, 'repoName' | 'number'>): string {
  return `${card.repoName ?? ''}#${card.number}`;
}

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
