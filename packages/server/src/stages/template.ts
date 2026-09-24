import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const promptsDir = join(import.meta.dirname, 'prompts');

/**
 * Prompts live as editable files, not string literals buried in logic. They are
 * the part of this system most likely to be rewritten once real runs start, and
 * they are where stage quality actually lives.
 */
export function renderPrompt(name: string, vars: Record<string, string>): string {
  const template = readFileSync(join(promptsDir, `${name}.md`), 'utf8');
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '');
}
