import { readFileSync } from 'node:fs';
import { STAGE_LABELS, type ApiCard, type CardActivity, type Stage } from '@reeve/shared';
import { EXIT, type ExitCode } from './exit.js';

/**
 * An error meant for whoever is at the terminal: printed as its message alone,
 * with no stack. A usage mistake gets the usage text too. The codes past 2 are
 * `card wait`'s, which says how a run ended by the status it exits with — see
 * ./exit.ts.
 */
export class CliError extends Error {
  /** Filled in by the group the error came from, so a usage mistake gets that verb's help and no other. */
  usage: string | null = null;

  constructor(
    message: string,
    readonly exitCode: ExitCode = EXIT.error,
  ) {
    super(message);
  }
}

export const usageError = (message: string) => new CliError(message, EXIT.usage);

/** A flag that has to be a count: rejected here rather than reaching the server as NaN. */
export function parseCount(name: string, value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n)) {
    throw usageError(`${name} must be a whole number, not '${value}'`);
  }
  return n;
}

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

const UNITS = ['k', 'M', 'B'];

/**
 * A token count, as the card footer writes it: exact under a thousand, then one
 * decimal while it still says something and whole numbers once it does not. The
 * unit is chosen after rounding, so 999,950 is "1 M" rather than "1000 k".
 */
export function formatTokens(n: number | null): string {
  if (n === null) return '-';
  if (n < 1000) return `${Math.round(n)} tok`;
  let unit = 0;
  let v = n / 1000;
  const round = (x: number) => (x < 10 ? Math.round(x * 10) / 10 : Math.round(x));
  while (round(v) >= 1000 && unit < UNITS.length - 1) {
    v /= 1000;
    unit++;
  }
  // `String` drops a trailing ".0" on its own: 2 M, not 2.0 M.
  return `${round(v)} ${UNITS[unit]} tok`;
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

/** A flag's text, or the file it names — `-` for stdin — for notes too long to quote on a command line. */
export function textOrFile(text: string | undefined, file: string | undefined, flag: string): string | undefined {
  if (text !== undefined && file !== undefined) throw usageError(`give --${flag} or --${flag}-file, not both`);
  if (file === undefined) return text;
  try {
    return readFileSync(file === '-' ? 0 : file, 'utf8');
  } catch (e) {
    throw new CliError(`could not read ${file === '-' ? 'stdin' : file}: ${(e as Error).message}`);
  }
}

/** The `reeve#142` a person says out loud. A card with no repo is just `#142`. */
export function cardRef(card: Pick<ApiCard, 'repoName' | 'number'>): string {
  return `${card.repoName ?? ''}#${card.number}`;
}

export const stageLabel = (stage: Stage) => STAGE_LABELS[stage];
