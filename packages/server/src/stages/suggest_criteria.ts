import { criteriaOutput, type CriteriaOutput } from '@reeve/shared';
import { addCriterion, criteriaFor } from '../db/queries.js';
import { renderPrompt } from './template.js';
import type { ClaudeTask } from './types.js';

/**
 * The brief's Suggest button: read the card, propose what done would mean.
 *
 * A task rather than a stage. It is not a column, it can happen to a card
 * sitting in Backlog, and nothing reviews or approves it — but it is still a
 * real run, because it costs money and a person should be able to see in the
 * card's history that Claude wrote those words rather than they did.
 *
 * Read-only, like Planning, for the same reason: there is nothing here it
 * should be able to change.
 *
 * Out of band: a card awaiting review of its plan is still awaiting review of
 * its plan after someone asks for suggestions. The only thing that shows this
 * running is the button that started it.
 */
export const suggestCriteriaTask: ClaudeTask<CriteriaOutput> = {
  id: 'suggest_criteria',
  outOfBand: true,
  schema: criteriaOutput,
  permissionMode: 'plan',
  allowedTools: ['Read', 'Glob', 'Grep'],
  maxBudgetUsd: 1,
  maxTurns: 20,
  effort: 'medium',

  buildPrompt(ctx) {
    const existing = ctx.criteria?.length
      ? ctx.criteria.map((c) => `- ${c}`).join('\n')
      : '_None yet._';
    return renderPrompt('suggest_criteria', {
      worktreePath: ctx.worktreePath,
      title: ctx.card.title,
      body: ctx.card.body.trim() || '_No further detail was given._',
      existing,
    });
  },

  // Nothing to write to disk: suggestions are rows, and only rows.
  onComplete: () => [],

  /**
   * Appended, never replacing. These land in a list a person is editing, and
   * silently dropping something they typed would be the worst thing this
   * button could do. Exact duplicates are skipped so pressing it twice does
   * not double the list.
   */
  onPersist(db, ctx, output) {
    const have = new Set(criteriaFor(db, ctx.card.id).map((c) => c.text.trim().toLowerCase()));
    for (const text of output.criteria) {
      if (have.has(text.trim().toLowerCase())) continue;
      addCriterion(db, ctx.card.id, text, 'claude');
      have.add(text.trim().toLowerCase());
    }
  },

  summarise(output) {
    const n = output.criteria.length;
    return `Suggested ${n} acceptance criteri${n === 1 ? 'on' : 'a'}`;
  },
};
