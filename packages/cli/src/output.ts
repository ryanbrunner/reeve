import type { ApiCard } from '@reeve/shared';

/**
 * An error meant for the person at the terminal: printed as its message alone,
 * with no stack. Exit code 2 is a usage mistake and gets the usage text too —
 * the command's own, once the command it came from has put it there.
 */
export class CliError extends Error {
  usage: string | null = null;

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

/** A whole number from a flag or an argument, for `--index` and a criterion's number. */
export function parseCount(name: string, value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n)) {
    throw usageError(`${name} must be a whole number, not '${value}'`);
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

/**
 * The `reeve#142` a person says out loud. A card with no repo is just `#142`,
 * and a project, which has no number, is its title.
 */
export function cardRef(card: Pick<ApiCard, 'repoName' | 'number' | 'kind' | 'title'>): string {
  if (card.kind === 'project') return `project "${card.title}"`;
  return `${card.repoName ?? ''}#${card.number}`;
}
