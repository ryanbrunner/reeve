import { releaseOutput, type ReleaseOutput } from '@reeve/shared';
import { getCard, insertCardEvent } from '../db/queries.js';
import { editPullRequest } from '../git/github.js';
import { GitError, commitsSince } from '../git/worktree.js';
import { openPullRequest } from '../pullRequest.js';
import { recordSuggestions } from '../suggestions.js';
import { renderNotes, renderPrompt, renderSuggesting } from './template.js';
import type { StageDefinition } from './types.js';

/**
 * The last stage, where the work is made ready to merge with the person who
 * will merge it. It used to be Done, a column where a card waited with its pull
 * request; now it is a conversation like the others.
 *
 * The server still opens the pull request when the card arrives, before this
 * starts — but nothing starts the conversation itself by default. Asked to,
 * Claude reviews the branch, runs the repo's finish command, and writes the
 * title, description and release notes, which the server sets on the pull
 * request — Claude returns data and the server acts on it, the same
 * inversion every stage runs on. It may commit a small fix; the server pushes
 * it. It never merges: `mergeGuard` refuses `gh pr merge` in every stage, and
 * the Merge button is the person's.
 */
export const releaseStage: StageDefinition<ReleaseOutput> = {
  id: 'release',
  schema: releaseOutput,
  submit: {
    description:
      'Submit what the pull request should say — title, description, release notes — with your verdict on whether it ' +
      'is ready and anything the person should know before merging. Reeve sets them on the pull request and pushes ' +
      'anything you committed. It ends your turn. Call it again after any revision.',
  },
  maxBudgetUsd: 4,
  maxTurns: 80,
  effort: 'high',

  async prepare(db, _writer, ctx): Promise<Record<string, string>> {
    const card = getCard(db, ctx.card.id) ?? ctx.card;
    const commits = card.baseSha
      ? await commitsSince(ctx.worktreePath, card.baseSha).catch(() => [])
      : [];
    return {
      pullRequest: card.prUrl
        ? `Its pull request is open: ${card.prUrl}.`
        : 'It has no pull request yet — opening one failed or has not happened. Say so if it matters to what you find.',
      commits: commits.length ? commits.map((c) => `- \`${c.sha}\` ${c.subject}`).join('\n') : '_None found._',
    };
  },

  buildPrompt(ctx, prepared) {
    const artifact = (kind: string, heading: string) => {
      const content = ctx.priorArtifacts?.find((a) => a.kind === kind)?.content;
      return content ? `### ${heading}\n\n${content.trim()}` : '';
    };
    return renderPrompt('release', {
      worktreePath: ctx.worktreePath,
      title: ctx.card.title,
      body: ctx.brief,
      pullRequest: prepared?.['pullRequest'] ?? '',
      branch: ctx.card.branchName ?? 'the card’s branch',
      base: ctx.repo.defaultBranch,
      commits: prepared?.['commits'] ?? '',
      plan: artifact('plan', 'The plan'),
      implementation: artifact('summary', 'What was built'),
      testReport: artifact('test_report', 'The test report'),
      finishCommand: ctx.repo.finishCommand
        ? `The repo's finish command is \`${ctx.repo.finishCommand}\`, its own last check before merging. Run it from the worktree and report what it did, if asked.`
        : 'This repo defines no finish command.',
      suggesting: renderSuggesting(ctx.suggestTasks !== false),
      notes: renderNotes(ctx.notes),
    });
  },

  onComplete(_ctx, output) {
    return [{ kind: 'release', content: composeRelease(output), path: '.reeve/release.md' }];
  },

  onPersist(db, ctx, output) {
    recordSuggestions(db, ctx, output.suggested_tasks);
  },

  /**
   * Push what Release committed, then set the pull request's title and body.
   * A pull request that failed to open on entry is opened here. Failures are
   * written to the card as `pr_failed`, as the opening itself writes them,
   * and never fail the run: what Claude wrote is valid either way.
   */
  async onPersistAsync(db, writer, ctx, output, runId) {
    const card = getCard(db, ctx.card.id);
    if (!card || card.mergedAt || card.stage !== 'release') return;
    const opened = await openPullRequest(db, card, ctx.repo);
    const url = opened.ok ? opened.url : card.prUrl;
    if (!url) return;
    const body = [
      output.pr_body.trim(),
      output.release_notes.trim() ? `## Release notes\n\n${output.release_notes.trim()}` : '',
      `Reeve #${card.number}`,
    ].filter(Boolean).join('\n\n');
    try {
      await editPullRequest(ctx.worktreePath, url, output.pr_title.trim() || card.title, body);
    } catch (e) {
      const detail = e instanceof GitError ? e.stderr || e.message : String(e);
      writer.append(runId, 'error', { message: `Could not update the pull request: ${detail}` });
      insertCardEvent(db, {
        cardId: card.id, actor: 'human', kind: 'pr_failed', stage: card.stage,
        body: `could not update the pull request: ${detail}`, meta: { url },
      });
    }
  },

  summarise(output) {
    return output.ready ? `Ready to merge. ${output.summary}` : output.summary;
  },
};

/** `.reeve/release.md`: what the pull request says, and what to know before merging. */
function composeRelease(output: ReleaseOutput): string {
  const out: string[] = [`> ${output.summary}`, '', `**${output.ready ? 'Ready to merge' : 'Not ready yet'}**`, ''];
  if (output.concerns.length) {
    out.push('## Before merging', '');
    for (const c of output.concerns) out.push(`- ${c}`);
    out.push('');
  }
  if (output.finish.ran || output.finish.notes) {
    out.push('## Finish command', '', `${output.finish.ran ? (output.finish.passed ? 'Passed.' : 'Failed.') : 'Not run.'} ${output.finish.notes}`.trim(), '');
  }
  out.push('## Pull request', '', `### ${output.pr_title}`, '', output.pr_body.trim(), '');
  if (output.release_notes.trim()) out.push('## Release notes', '', output.release_notes.trim(), '');
  return `${out.join('\n').trimEnd()}\n`;
}
