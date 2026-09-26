import { readFile } from 'node:fs/promises';
import type { ApiCardRef } from '@reeve/shared';
import { api } from './client.js';
import { CliError, usageError } from './output.js';

/** A file's text, or stdin's when the path is `-`, so another tool can pipe a brief in. */
export async function readText(path: string): Promise<string> {
  if (path === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    throw new CliError(`could not read ${path}: ${(e as Error).message}`);
  }
}

/** `--body TEXT` or `--body-file PATH|-`, or undefined when neither was given. */
export async function bodyFrom(values: { body?: string; 'body-file'?: string }): Promise<string | undefined> {
  if (values.body !== undefined && values['body-file'] !== undefined) {
    throw usageError('give --body or --body-file, not both');
  }
  return values['body-file'] === undefined ? values.body : readText(values['body-file']);
}

/** The flags every command that writes a brief takes. */
export const BODY_OPTIONS = {
  body: { type: 'string' },
  'body-file': { type: 'string' },
} as const;

/**
 * Context pinned to a card with `--ref`. The same rule as the Brief tab's
 * field: a value that looks like a link is one, and anything else is a path.
 */
export async function addRefs(cardId: string, values: string[] | undefined): Promise<ApiCardRef[]> {
  const added: ApiCardRef[] = [];
  for (const value of values ?? []) {
    added.push(await api.addRef(cardId, { kind: /^https?:\/\//.test(value) ? 'url' : 'file', value }));
  }
  return added;
}
