import { STAGE_LABELS, ideasOutput, type IdeasOutput } from '@reeve/shared';
import { addCriterion, cardsInRepo, createCard } from '../db/queries.js';
import { renderPrompt } from './template.js';
import type { ClaudeTask } from './types.js';

/** However many Claude proposes, no more than this lands on the board from one run. */
export const MAX_IDEAS = 3;

/**
 * How much of the repo's history the prompt lists. Enough to stop Claude
 * proposing last week's work again; not so much that a long-lived repo's
 * backlog is most of the prompt.
 */
const CARDS_LISTED = 60;

/**
 * VIBES MODE thinking of its own work. When a repo on the board runs out, the
 * sweep starts this on the card that finished last, and what it proposes lands
 * in Backlog — where, with the switch still on, the next sweep starts it.
 *
 * Out of band on the card it is started on, for the reasons Suggest is: it is
 * not that card's work, but it is a real run that costs money, and a person
 * wondering where a card came from should find the run that made it in the
 * history of the card that prompted it. Read-only like Planning, because all it
 * does is read and propose; the server makes the cards.
 */
export const ideasTask: ClaudeTask<IdeasOutput> = {
  id: 'ideas',
  outOfBand: true,
  schema: ideasOutput,
  permissionMode: 'plan',
  allowedTools: ['Read', 'Glob', 'Grep'],
  maxBudgetUsd: 2,
  maxTurns: 30,
  effort: 'medium',

  // The prompt lists what the repo already has, and `buildPrompt` has no
  // database to ask.
  async prepare(db, _writer, ctx) {
    const cards = ctx.card.repoId ? cardsInRepo(db, ctx.card.repoId).slice(0, CARDS_LISTED) : [];
    return {
      cards: cards.length
        ? cards.map((c) => `- #${c.number} ${c.title} (${c.archivedAt ? 'archived' : STAGE_LABELS[c.stage]})`).join('\n')
        : '_None._',
    };
  },

  buildPrompt(ctx, prepared = {}) {
    return renderPrompt('ideas', {
      ...prepared,
      worktreePath: ctx.worktreePath,
      repo: ctx.repo.name,
      title: ctx.card.title,
      body: ctx.brief,
      max: String(MAX_IDEAS),
    });
  },

  // Nothing to write to disk: ideas are cards, and only cards.
  onComplete: () => [],

  /**
   * Into Backlog as Claude's, each suggested by the card it was had after, so
   * the board draws where it came from the way it does for a stage's suggested
   * tasks. The `created` event still says `ideaFrom`, because a suggested task
   * is Claude's too, and that is what the HUD tells an idea apart by. Nothing
   * is flagged for VIBES MODE on its own: these go because the board's switch
   * is on, and wait for a person like any other card if it has gone off by the
   * time they land.
   *
   * Clamped here as well as asked for in the prompt, because each one is a
   * card that will be built unread. A title the repo has already had, archived
   * included, is skipped, and so is one with no words in it, which would sit in
   * Backlog as a placeholder the sweep never starts. Wider than
   * `recordSuggestions`, which only skips what its own card suggested before:
   * an idea is built with nobody reading it, so one that repeats shipped work
   * is that work built twice.
   */
  onPersist(db, ctx, output, runId) {
    const repoId = ctx.card.repoId;
    if (!repoId) return;
    const have = new Set(cardsInRepo(db, repoId).map((c) => c.title.trim().toLowerCase()));
    let made = 0;
    for (const idea of output.ideas) {
      if (made >= MAX_IDEAS) break;
      const title = idea.title.trim();
      const key = title.toLowerCase();
      if (!title || have.has(key)) continue;
      const created = createCard(db, {
        title,
        body: idea.body,
        repoId,
        stage: 'backlog',
        suggestedById: ctx.card.id,
        actor: 'claude',
        meta: { ideaFrom: ctx.card.id, runId },
      });
      have.add(key);
      made += 1;
      for (const text of idea.criteria) addCriterion(db, created.id, text, 'claude');
    }
  },

  summarise(output) {
    const n = Math.min(output.ideas.length, MAX_IDEAS);
    return n === 0 ? 'Thought of nothing worth doing' : `Thought of ${n} thing${n === 1 ? '' : 's'} to build next`;
  },
};
