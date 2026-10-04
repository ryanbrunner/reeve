import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

/**
 * Prompts live as editable files, not string literals buried in logic. They are
 * the part of this system most likely to be rewritten once real runs start, and
 * they are where stage quality actually lives. Where they live on disk is
 * `config.promptsDir`'s call, not this file's, since that is the one place
 * that already knows a checkout from a published package.
 */
export function renderPrompt(name: string, vars: Record<string, string>): string {
  const template = readFileSync(join(config.promptsDir, `${name}.md`), 'utf8');
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '');
}

/**
 * Every line quoted, not just the first. A template's `> {{notes}}` quotes one
 * line, and feedback from a review in Crit runs to many.
 */
export function blockquote(text: string): string {
  return text.trim().split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
}

/**
 * What to do with an aside, worded once for every stage. Its own section
 * rather than a line in each stage's list of what to return, so it reads as
 * something to keep in mind while working and not one more thing to produce.
 */
export function renderSuggesting(): string {
  return renderPrompt('suggested_tasks', {});
}

/** The notes block, or nothing at all when there are none. Every stage renders it. */
export function renderNotes(notes: string[] | undefined): string {
  if (!notes?.length) return '';
  return renderPrompt('notes', { notes: notes.map((n) => `- ${n}`).join('\n') });
}
