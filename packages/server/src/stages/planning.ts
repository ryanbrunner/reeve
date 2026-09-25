import { planningOutput, type PlanningOutput } from '@reeve/shared';
import { deleteAsset, relativeAssetPath, writeAsset } from '../assets/store.js';
import { renderMockups } from '../capture/screenshot.js';
import type { Db } from '../db/client.js';
import {
  addCriterion,
  assetsFor,
  criteriaFor,
  getCard,
  insertAsset,
  replaceGeneratedMockups,
  replaceQuestions,
} from '../db/queries.js';
import { blockquote, renderNotes, renderPrompt } from './template.js';
import type { StageDefinition } from './types.js';

/** Enough to show the states a change alters, few enough to stay in budget. */
const MAX_MOCKUPS = 3;

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
  // Up to three HTML documents is real output on top of the plan, and running
  // out of budget fails the run with no plan at all.
  maxBudgetUsd: 4,
  maxTurns: 60,
  effort: 'high',

  /**
   * The mockup instructions, only for a card that asks for them — and with the
   * labels a person has already drawn, so Claude does not draw them again.
   */
  async prepare(db, _writer, ctx) {
    if (!ctx.card.generateMockups) return {};
    const labels = attachedMockupLabels(db, ctx.card.id);
    const attached = labels.size
      ? `\nA person has already attached mockups for these, so do not draw them again: ${[...labels]
          .map((l) => `"${l}"`)
          .join(', ')}.\n`
      : '';
    return { mockups: renderPrompt('mockups', { attached }) };
  },

  buildPrompt(ctx, prepared) {
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
      mockups: prepared?.['mockups'] ?? '',
      notes: renderNotes(ctx.notes),
    });
  },

  onComplete(ctx, output) {
    const mockups = ctx.card.generateMockups ? mockupsToDraw(output) : [];
    return [{ kind: 'plan', content: composePlan(output, mockups), path: '.reeve/plan.md' }];
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

  /**
   * Draw the mockups and store them as the card's own, tagged with this run —
   * which is what tells them apart from a person's, and what lets the next
   * plan replace them.
   *
   * Rendered before anything is deleted, so a missing browser leaves the last
   * plan's mockups in place rather than none. A plan that draws nothing still
   * clears them: they showed a plan that has been superseded. The box has to
   * have been ticked when the run started, since that is what asked for them,
   * and still be ticked now, so clearing it mid-plan is heard.
   */
  async onPersistAsync(db, writer, ctx, output, runId) {
    if (!ctx.card.generateMockups || !getCard(db, ctx.card.id)?.generateMockups) return;
    const attached = attachedMockupLabels(db, ctx.card.id);
    const wanted = mockupsToDraw(output).filter((m) => !attached.has(m.label));

    const result = await renderMockups(wanted);
    if (result.unavailable) {
      writer.append(runId, 'error', { message: `No mockups: ${result.unavailable}` });
      return;
    }
    for (const f of result.failures) {
      writer.append(runId, 'error', { message: `Mockup "${f.label}" could not be drawn: ${f.reason}` });
    }

    for (const path of replaceGeneratedMockups(db, ctx.card.id, runId)) deleteAsset(path);
    for (const mockup of result.captures) {
      const id = crypto.randomUUID();
      const rel = relativeAssetPath(ctx.card.id, id, 'image/png');
      writeAsset(rel, mockup.bytes);
      insertAsset(db, {
        cardId: ctx.card.id, runId, kind: 'mockup',
        label: mockup.label, url: mockup.path, viewport: mockup.viewport,
        path: rel, contentType: 'image/png', width: mockup.width, height: mockup.height,
      });
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
 *
 * `mockups` is passed separately because not every mockup in the output is
 * drawn: a card with the box cleared has none, whatever Claude returned.
 */
function composePlan(output: PlanningOutput, mockups: PlanningOutput['mockups']): string {
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

  if (mockups.length) {
    out.push('## Mockups', '');
    for (const m of mockups) out.push(`- ${m.label} — \`${m.path}\` at ${m.viewport}px`);
    out.push('');
  }

  if (output.acceptance_criteria.length) {
    out.push('## Acceptance criteria', '');
    for (const c of output.acceptance_criteria) out.push(`- [ ] ${c}`);
    out.push('');
  }

  return `${out.join('\n').trimEnd()}\n`;
}

/** The plan's mockups as they will be drawn: one per label, and no more than the cap. */
function mockupsToDraw(output: PlanningOutput): PlanningOutput['mockups'] {
  const seen = new Set<string>();
  return output.mockups
    .filter((m) => !seen.has(m.label) && seen.add(m.label))
    .slice(0, MAX_MOCKUPS);
}

/** Labels of the mockups a person attached, which a drawn one never replaces. */
function attachedMockupLabels(db: Db, cardId: string): Set<string> {
  return new Set(assetsFor(db, cardId).filter((a) => a.kind === 'mockup' && a.runId === null).map((a) => a.label));
}
