import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STAGE_LABELS, type HandoffResponse } from '@reeve/shared';
import type { Db } from './db/client.js';
import { answeredQuestionsFor, latestClaudeRunForStage } from './db/queries.js';
import type { Card, Repo } from './db/schema.js';
import { stageContextFor } from './runs/claude.js';
import { renderNotes, renderPrompt } from './stages/template.js';

const HANDOFF_PATH = '.reeve/handoff.md';

/** The files the stages leave in the tree, and the artifact each was written from. */
const STAGE_FILES = [
  { path: '.reeve/plan.md', kind: 'plan', label: 'The approved plan' },
  { path: '.reeve/implementation.md', kind: 'summary', label: 'What In Progress built' },
  { path: '.reeve/test-report.md', kind: 'test_report', label: 'What Testing found' },
] as const;

/**
 * Hand a card to Claude Code in the terminal.
 *
 * Writes `.reeve/handoff.md` into the worktree, the same way a stage writes its
 * plan or report, and returns the command that starts a session on it. The
 * file carries the context rather than the command line, because the card's
 * title and brief are user text: quotes, backticks or `$` in them would break
 * the shell quoting or run. The command interpolates the worktree path and
 * nothing else.
 */
export function writeHandoff(db: Db, card: Card, repo: Repo, worktreePath: string): HandoffResponse {
  // No stage excluded: the person taking over wants the latest of everything,
  // including whatever the current stage last produced.
  const ctx = stageContextFor(db, { card, repo, worktreePath });
  const last = latestClaudeRunForStage(db, card.id, card.stage);
  const answered = answeredQuestionsFor(db, card.id);

  const pointers: string[] = [];
  const inlined: string[] = [];
  for (const f of STAGE_FILES) {
    if (existsSync(join(worktreePath, f.path))) {
      pointers.push(`- ${f.label}: \`${f.path}\``);
      continue;
    }
    // The row outlives the file, which can be deleted by hand or cleaned away.
    const content = ctx.priorArtifacts?.find((a) => a.kind === f.kind)?.content;
    if (content) inlined.push(`### ${f.label}\n\n${content.trim()}`);
  }
  const files =
    [...pointers, ...(pointers.length && inlined.length ? [''] : []), ...inlined].join('\n') ||
    '_Nothing yet. No stage has finished a run on this card._';

  const content = renderPrompt('handoff', {
    title: card.title,
    body: card.body.trim() || '_No further detail was given._',
    stage: STAGE_LABELS[card.stage],
    worktreePath,
    branch: card.branchName ?? '(unknown)',
    baseBranch: repo.defaultBranch,
    // Where the branch was cut, so the log is the card's commits alone: the
    // local default branch may never have heard of what the card started from.
    baseRef: card.baseSha ?? `origin/${repo.defaultBranch}`,
    lastRun: last
      ? `${last.status}${last.stopReason && last.stopReason !== 'completed' ? ` (${last.stopReason})` : ''}`
      : 'none yet',
    lastError: last?.errorMessage
      ? `\nThat run ended with this error:\n\n\`\`\`\n${last.errorMessage.trim()}\n\`\`\`\n`
      : '',
    criteria: ctx.criteria?.length
      ? ctx.criteria.map((c) => `- [ ] ${c}`).join('\n')
      : '_None written yet._',
    files,
    answers: answered.length
      ? `\n## Questions already answered\n\n${answered.map((q) => `**${q.text}**\n${q.answer}`).join('\n\n')}\n`
      : '',
    notes: renderNotes(ctx.notes),
    testCommand: repo.testCommand
      ? `Run \`${repo.testCommand}\` before you call the work finished, and get it green.`
      : 'This repo defines no test command, so check the work by other means.',
  });

  const path = join(worktreePath, HANDOFF_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');

  return {
    path,
    command: `cd ${shellQuote(worktreePath)} && claude "Read ${HANDOFF_PATH} and take over this card."`,
  };
}

/** Single quotes, with any inside closed, escaped and reopened. Nothing expands. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
