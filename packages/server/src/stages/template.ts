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
 *
 * With suggestions off, the server is the guarantee — `recordSuggestions`
 * returns early regardless of what a run sends back — so the only thing this
 * saves is Claude's effort thinking of something nobody will see.
 */
export function renderSuggesting(enabled: boolean): string {
  return renderPrompt(enabled ? 'suggested_tasks' : 'no_suggested_tasks', {});
}

/**
 * How a stage that builds or checks code should run its tests, worded once
 * for In Progress and Testing. Big repos are why: a whole suite run after
 * every edit is most of a run's time, and its output most of its context.
 * So the tests near the change while working — the plan's own focused
 * tests, or the repo's focused command, or the narrowest the runner allows —
 * and the whole suite once, at the end, kept to its tail.
 */
export function renderTests(repo: { testCommand: string | null; focusedTestCommand: string | null }, final: string): string {
  const focused = repo.focusedTestCommand?.trim()
    ? `the plan's focused tests if it names them, or \`${repo.focusedTestCommand.trim()}\` with \`{{paths}}\` replaced by the test files or directories that cover what you changed`
    : "the plan's focused tests if it names them, or else the narrowest command the repo's own runner allows for what you changed";
  return renderPrompt('tests', {
    focused,
    final: repo.testCommand?.trim() ? final.replace('{{command}}', `\`${repo.testCommand.trim()}\``) : '',
  });
}

/** The notes block, or nothing at all when there are none. Every stage renders it. */
export function renderNotes(notes: string[] | undefined): string {
  if (!notes?.length) return '';
  return renderPrompt('notes', { notes: notes.map((n) => `- ${n}`).join('\n') });
}
