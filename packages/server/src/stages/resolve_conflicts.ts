import { conflictResolutionOutput, type ConflictResolutionOutput } from '@reeve/shared';
import { inProgressStage } from './in_progress.js';
import { renderPrompt } from './template.js';
import type { ClaudeTask } from './types.js';

export const RESOLVE_CONFLICTS_TASK = 'resolve_conflicts';

/**
 * The Done band's Resolve conflicts button: finish a merge of the base branch
 * that the server has already started and stopped on conflicts.
 *
 * Made per merge rather than declared once like Suggest, because the prompt
 * needs what only the merge knows — which branch came in and which files it
 * left conflicted — and a run's context has no other way to carry it.
 *
 * Claude edits and commits, and that is all. The server fetched and merged
 * before the run, and afterwards it checks the result and does the pushing
 * itself, so nothing here can merge, reset, check out or push. `git show` is
 * for reading each side of a conflict, and `git mv` and `git rm` for moving a
 * migration out of the way of the base's: the Write tool can make a file but
 * never rename or remove one.
 *
 * Out of band: a Done card has no stage run to take over, and the card's own
 * model and effort are for its work, not for this.
 */
export function resolveConflictsTask(merge: { base: string; conflicts: string[] }): ClaudeTask<ConflictResolutionOutput> {
  return {
    id: RESOLVE_CONFLICTS_TASK,
    outOfBand: true,
    schema: conflictResolutionOutput,
    permissionMode: 'acceptEdits',
    allowedTools: [...inProgressStage.allowedTools, 'Bash(git show *)', 'Bash(git mv *)', 'Bash(git rm *)'],
    maxBudgetUsd: 5,
    maxTurns: 100,
    effort: 'high',

    buildPrompt(ctx) {
      const plan = ctx.priorArtifacts?.find((a) => a.kind === 'plan')?.content;
      const notes = ctx.priorArtifacts?.find((a) => a.kind === 'summary')?.content;
      return renderPrompt('resolve_conflicts', {
        worktreePath: ctx.worktreePath,
        branch: ctx.card.branchName ?? 'this branch',
        base: merge.base,
        title: ctx.card.title,
        body: ctx.brief,
        plan: plan ?? '_No plan was recorded for this card._',
        implementation: notes ?? '_No implementation notes were recorded for this card._',
        conflicts: merge.conflicts.map((p) => `- \`${p}\``).join('\n'),
        testCommand: ctx.repo.testCommand
          ? `Run \`${ctx.repo.testCommand}\` once every file is resolved, before you commit, and get it green if the merge is what broke it. Report the result in \`tests_passed\`.`
          : 'This repo defines no test command, so there is nothing to run. Set `tests_passed` to null.',
      });
    },

    // The record is the run's own output and the event the server writes once
    // it has checked the merge. A `summary` artifact would displace the card's
    // implementation notes, which Testing and handoff read as the newest one.
    onComplete: () => [],

    summarise(output) {
      const n = output.files.length;
      return `Resolved conflicts in ${n} file${n === 1 ? '' : 's'}`;
    },
  };
}
