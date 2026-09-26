import { implementationOutput, type ImplementationOutput } from '@reeve/shared';
import { absoluteAssetPath } from '../assets/store.js';
import { assetsFor } from '../db/queries.js';
import { recordSuggestions } from '../suggestions.js';
import { blockquote, renderNotes, renderPrompt, renderSuggesting } from './template.js';
import { GIT_COMMIT, GIT_READ, NODE_TOOLING } from './tools.js';
import type { StageDefinition } from './types.js';

/**
 * The stage that actually writes code, and the first one with teeth.
 *
 * `acceptEdits` rather than `bypassPermissions`: nobody is watching, so edits
 * inside the worktree go through without asking, but the mode still refuses the
 * things that reach outside it. The worktree is the blast radius, and it is a
 * throwaway branch — which is the whole reason a card gets one.
 *
 * It commits as it goes. A card's work being four commits rather than one diff
 * is what lets the Commits rail show the shape of the work, and what makes a bad
 * run something to drop rather than unpick.
 */
export const inProgressStage: StageDefinition<ImplementationOutput> = {
  id: 'in_progress',
  schema: implementationOutput,
  permissionMode: 'acceptEdits',
  // Scoped so a run can build, test and commit its own work, but not reach for
  // the network or rewrite history it did not create.
  allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', ...GIT_READ, ...GIT_COMMIT, ...NODE_TOOLING],
  maxBudgetUsd: 10,
  maxTurns: 200,
  effort: 'high',

  /**
   * The card's mockups, as files Claude can Read: the pictures Testing will
   * hold the build up against, handed over before the build rather than after.
   */
  // Annotated because TypeScript 7 widens the early `{}` to `{ mockups?: undefined }`,
  // which the hook's `Record<string, string>` refuses.
  async prepare(db, _writer, ctx): Promise<Record<string, string>> {
    const mockups = assetsFor(db, ctx.card.id).filter((a) => a.kind === 'mockup');
    if (mockups.length === 0) return {};
    const lines = mockups.map((m) => {
      const where = m.url ? ` (${m.url} at ${m.viewport ?? '?'}px)` : '';
      const drawn = m.runId ? ' — drawn by Claude while planning' : '';
      return `- **${m.label}**${where}: \`${absoluteAssetPath(m.path)}\`${drawn}`;
    });
    return { mockups: renderPrompt('in_progress_mockups', { mockups: lines.join('\n') }) };
  },

  buildPrompt(ctx, prepared) {
    const plan = ctx.priorArtifacts?.find((a) => a.kind === 'plan')?.content;
    return renderPrompt('in_progress', {
      worktreePath: ctx.worktreePath,
      title: ctx.card.title,
      body: ctx.brief,
      plan: plan ?? '_No plan was recorded for this card. Work from the card itself._',
      mockups: prepared?.['mockups'] ?? '',
      testCommand: ctx.repo.testCommand
        ? `Run \`${ctx.repo.testCommand}\` before you finish, and get it green.`
        : 'This repo defines no test command, so there is nothing to run.',
      suggesting: renderSuggesting(),
      reviewNotes: ctx.reviewNotes ? renderPrompt('revision', { notes: blockquote(ctx.reviewNotes) }) : '',
      notes: renderNotes(ctx.notes),
    });
  },

  onComplete(_ctx, output) {
    return [{ kind: 'summary', content: composeNotes(output), path: '.reeve/implementation.md' }];
  },

  // The only rows this stage writes: what it noticed, or deliberately left
  // out of scope, as cards of their own.
  onPersist(db, ctx, output) {
    recordSuggestions(db, ctx, output.suggested_tasks);
  },

  // Implementation reports; it does not ask. Anything it could not decide should
  // have been an open question at planning time, and if it genuinely wasn't, the
  // place to say so is `deviations_from_plan` — which the human then reviews.
  awaitsInput: undefined,

  summarise(output) {
    const n = output.files_changed.length;
    return `${output.summary} (${n} file${n === 1 ? '' : 's'} changed)`;
  },
};

/** `.reeve/implementation.md` — what Testing reads, and what the Changes tab shows. */
function composeNotes(output: ImplementationOutput): string {
  const out: string[] = [`> ${output.summary}`, ''];

  if (output.deviations_from_plan.length) {
    out.push('## Where this departed from the plan', '');
    for (const d of output.deviations_from_plan) out.push(`- ${d}`);
    out.push('');
  }
  // Testing reads this, and work left out on purpose is worth it knowing about
  // before it fails a criterion for it.
  if (output.suggested_tasks.length) {
    out.push('## Suggested as separate cards', '');
    for (const t of output.suggested_tasks) out.push(`- ${t.title}`);
    out.push('');
  }
  if (output.commits.length) {
    out.push('## Commits', '');
    for (const c of output.commits) out.push(`- ${c}`);
    out.push('');
  }
  if (output.files_changed.length) {
    out.push('## Files', '');
    for (const f of output.files_changed) out.push(`- \`${f}\``);
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}
