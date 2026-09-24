import { planningOutput, type PlanningOutput } from '@reeve/shared';
import { renderPrompt } from './template.js';
import type { StageDefinition } from './types.js';

/**
 * The first stage, and deliberately the safest one to build the machinery
 * against: `permissionMode: 'plan'` means no tool execution at all, so the whole
 * spawn -> ingest -> SSE -> review loop can be debugged with Claude unable to
 * modify anything.
 *
 * Claude returns the plan as data. The SERVER writes `.reeve/plan.md`, which is
 * what lets the stage stay read-only and still produce a durable artifact.
 */
export const planningStage: StageDefinition<PlanningOutput> = {
  id: 'planning',
  schema: planningOutput,
  permissionMode: 'plan',
  // Read-only. No Write/Edit even scoped, because the server owns artifacts.
  allowedTools: ['Read', 'Glob', 'Grep', 'Bash(git log *)', 'Bash(git diff *)', 'Bash(git status *)'],
  maxBudgetUsd: 3,
  maxTurns: 60,
  effort: 'high',

  buildPrompt(ctx) {
    const reviewNotes = ctx.reviewNotes
      ? renderPrompt('revision', { notes: ctx.reviewNotes })
      : '';
    return renderPrompt('planning', {
      worktreePath: ctx.worktreePath,
      title: ctx.card.title,
      body: ctx.card.body.trim() || '_No further detail was given._',
      reviewNotes,
    });
  },

  onComplete(_ctx, output) {
    // A compact metadata block, then Claude's plan verbatim. Conditional lines
    // are `null` rather than '' so filtering them cannot also strip the blank
    // lines markdown needs for paragraph breaks.
    const meta: Array<string | null> = [
      `> ${output.summary}`,
      '>',
      `> **Risk:** ${output.risk}`,
      output.files_to_touch.length ? `> **Files:** ${output.files_to_touch.join(', ')}` : null,
      '',
      output.open_questions.length ? '## Open questions' : null,
      output.open_questions.length ? '' : null,
      ...(output.open_questions.length ? output.open_questions.map((q) => `- ${q}`) : []),
      output.open_questions.length ? '' : null,
      '---',
      '',
    ];
    const header = meta.filter((l): l is string => l !== null).join('\n');

    return [
      { kind: 'plan', content: `${header}\n${output.plan_markdown.trim()}\n`, path: '.reeve/plan.md' },
    ];
  },

  // Open questions are the plan asking for a decision, not offering one. The
  // card goes yellow and waits rather than green and inviting approval.
  awaitsInput(output) {
    return output.open_questions.length > 0;
  },

  summarise(output) {
    const q = output.open_questions.length;
    return `${output.summary}${q ? ` (${q} open question${q === 1 ? '' : 's'})` : ''}`;
  },
};
