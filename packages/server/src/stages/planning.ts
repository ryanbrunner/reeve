import { planningOutput, type PlanningOutput } from '@reeve/shared';
import { addCriterion, criteriaFor, replaceQuestions } from '../db/queries.js';
import { blockquote, renderNotes, renderPrompt } from './template.js';
import type { StageDefinition } from './types.js';

/**
 * The first stage, and deliberately the safest one to build the machinery
 * against: `permissionMode: 'plan'` means no tool execution at all, so the whole
 * spawn -> ingest -> SSE -> review loop can be debugged with Claude unable to
 * modify anything.
 *
 * Claude returns the plan as data. The SERVER writes `.reeve/plan.md`, which is
 * what lets the stage stay read-only and still produce a durable artifact — and
 * what keeps the document and the structured plan from ever disagreeing, since
 * one is composed from the other.
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
      ? renderPrompt('revision', { notes: blockquote(ctx.reviewNotes) })
      : '';
    const answers = ctx.answers?.length
      ? renderPrompt('answers', {
          answers: ctx.answers.map((a) => `**${a.question}**\n${a.answer}`).join('\n\n'),
        })
      : '';
    return renderPrompt('planning', {
      worktreePath: ctx.worktreePath,
      title: ctx.card.title,
      body: ctx.card.body.trim() || '_No further detail was given._',
      reviewNotes,
      answers,
      notes: renderNotes(ctx.notes),
    });
  },

  onComplete(_ctx, output) {
    return [{ kind: 'plan', content: composePlan(output), path: '.reeve/plan.md' }];
  },

  /**
   * The questions become rows so they can be answered one at a time, and the
   * criteria become rows so Testing has a checklist to mark off.
   *
   * Criteria are only seeded when the card has none: after the first plan the
   * list is the human's, and a revision must not quietly rewrite what they
   * decided done means.
   */
  onPersist(db, ctx, output, runId) {
    replaceQuestions(db, ctx.card.id, runId, 'planning', output.open_questions);
    if (criteriaFor(db, ctx.card.id).length === 0) {
      for (const text of output.acceptance_criteria) {
        addCriterion(db, ctx.card.id, text, 'claude');
      }
    }
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

/**
 * `.reeve/plan.md`, composed rather than transcribed.
 *
 * This is the file In Progress reads, so it has to carry everything the modal
 * shows: a metadata block, the prose sections Claude chose, the numbered steps
 * with their files, and any question still hanging over them.
 */
function composePlan(output: PlanningOutput): string {
  const out: string[] = [
    `> ${output.summary}`,
    '>',
    `> **Risk:** ${output.risk}`,
    ...(output.files_to_touch.length ? [`> **Files:** ${output.files_to_touch.join(', ')}`] : []),
    '',
  ];

  for (const section of output.details) {
    out.push(`## ${section.heading}`, '', section.body.trim(), '');
  }

  if (output.open_questions.length) {
    out.push('## Open questions', '');
    output.open_questions.forEach((q, i) => {
      out.push(`${i + 1}. ${q.question}`);
      if (q.suggestions.length) out.push(`   _Options: ${q.suggestions.join(' · ')}_`);
    });
    out.push('');
  }

  if (output.steps.length) {
    out.push('## Steps', '');
    output.steps.forEach((step, i) => {
      const blocked = step.blocked_on_question ? ` _(waits on question ${step.blocked_on_question})_` : '';
      out.push(`${i + 1}. **${step.title}**${blocked}`);
      if (step.detail.trim()) out.push(`   ${step.detail.trim()}`);
      if (step.files.length) out.push(`   \`${step.files.join('` `')}\``);
    });
    out.push('');
  }

  if (output.captures.length) {
    out.push('## Captures', '');
    for (const c of output.captures) out.push(`- ${c.label} — \`${c.path}\` at ${c.viewport}px`);
    out.push('');
  }

  if (output.acceptance_criteria.length) {
    out.push('## Acceptance criteria', '');
    for (const c of output.acceptance_criteria) out.push(`- [ ] ${c}`);
    out.push('');
  }

  return `${out.join('\n').trimEnd()}\n`;
}
