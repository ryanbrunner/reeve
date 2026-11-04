import { STAGE_LABELS, hookOutput, type HookOutput, type Stage } from '@reeve/shared';
import { fillVars, renderPrompt } from './template.js';
import type { ClaudeTask, StageContext } from './types.js';

/** One move, and the hooks it set off: the column it left's `leave`, the one it entered's `enter`. */
export interface HookMove {
  /** Null when the card was just made, straight into `to`. */
  from: Stage | null;
  to: Stage;
  leave: string | null;
  enter: string | null;
}

/**
 * The `{{vars}}` a hook's own text is filled with, which are the ones its
 * prompt shows Claude too: Settings lists them (`HOOK_VARS`), so a person can
 * write "move {{ref}} to In Review and link {{prUrl}}" and have it mean the card.
 */
function hookVars(ctx: StageContext, move: HookMove): Record<string, string> {
  const { card, repo } = ctx;
  return {
    ref: `${repo.name}#${card.number}`,
    number: String(card.number),
    title: card.title,
    body: ctx.brief,
    repo: repo.name,
    from: move.from ? STAGE_LABELS[move.from] : 'none',
    to: STAGE_LABELS[move.to],
    branch: card.branchName ?? 'none yet',
    prUrl: card.prUrl ?? 'none yet',
  };
}

/**
 * A hook, as Claude is asked to carry it out: Settings' text for the column a
 * card left and the column it entered, run once for the move.
 *
 * One run per move rather than one per hook, so a card going from In Progress
 * to Testing spends one small session on both halves rather than two, and the
 * two halves are done in the order they happened.
 *
 * Out of band, like Suggest: it is not the card's work, never becomes its
 * current run, and never answers the review gate, but it is a real run that
 * costs money and sits in the card's history where a person can read what it
 * did. Uncapped, unlike Suggest — see `uncapped` and hooks.ts.
 */
export function stageHookTask(move: HookMove): ClaudeTask<HookOutput> {
  return {
    id: 'stage_hook',
    outOfBand: true,
    uncapped: true,
    schema: hookOutput,
    // Small: a hook updates something and reports back. A hook that needs
    // more is a stage's work, not a side task's.
    maxBudgetUsd: 1,
    maxTurns: 30,
    effort: 'low',
    // Nothing here to check; the advisor's whole-session read is pure cost.
    advisor: false,

    buildPrompt(ctx) {
      const vars = hookVars(ctx, move);
      const fill = (text: string) => fillVars(text, vars).trim();
      const sections = [
        ...(move.from && move.leave ? [`### On leaving ${vars.from}\n\n${fill(move.leave)}`] : []),
        ...(move.enter ? [`### On entering ${vars.to}\n\n${fill(move.enter)}`] : []),
      ];
      return renderPrompt('hook', {
        ...vars,
        worktreePath: ctx.worktreePath,
        moved: move.from ? `moved from ${vars.from} to ${vars.to}` : `was just made, in ${vars.to}`,
        instructions: sections.join('\n\n'),
      });
    },

    // Nothing to write: what a hook does happens outside Reeve.
    onComplete: () => [],

    summarise: (output) => output.summary,
  };
}
