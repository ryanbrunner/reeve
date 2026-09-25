import { readFileSync } from 'node:fs';
import { STAGE_LABELS, type ApiCard, type Stage } from '@reeve/shared';
import { EXIT, type ExitCode } from './exit.js';

/**
 * An error meant for the person at the terminal: printed as its message alone,
 * with no stack. A usage mistake gets the usage text too.
 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode = EXIT.error,
  ) {
    super(message);
  }
}

export const usageError = (message: string) => new CliError(message, EXIT.usage);

/** Runs a `parseArgs` call, so an unknown flag or a missing value is a usage error rather than a stack. */
export function parseOrUsage<T>(parse: () => T): T {
  try {
    return parse();
  } catch (e) {
    if ((e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) throw usageError((e as Error).message);
    throw e;
  }
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

/**
 * With `--json`, stdout carries the JSON and nothing else, so another tool can
 * parse it whole. Everything said to a person goes through `note`, to stderr.
 * Without it, stdout carries only what a script would capture — a run id — so
 * `reeve run follow $(reeve card run 142)` works.
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

export const stageLabel = (stage: Stage) => STAGE_LABELS[stage];
