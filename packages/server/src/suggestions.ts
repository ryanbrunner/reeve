import type { PlanningOutput } from '@reeve/shared';
import type { Db } from './db/client.js';
import { cardsSuggestedBy, createCard, getCard, liveProject } from './db/queries.js';
import type { StageContext } from './stages/types.js';

/** One stage's suggestion: the three contracts share the fragment. */
export type SuggestedTask = PlanningOutput['suggested_tasks'][number];

/**
 * Enough for a run that genuinely tripped over several things, few enough that
 * a chatty one cannot bury the Backlog. Under board-wide VIBES MODE every one
 * of these is built, so this is also what one run can cost.
 */
const MAX_PER_RUN = 5;

/**
 * The cards a stage run suggested, made in Backlog beside the card that
 * suggested them: the same repo, and the same project while it is live. Every
 * stage calls this from `onPersist`, so they land only once the run has
 * succeeded, never from one that failed or was stopped halfway.
 *
 * They start nothing, and they do not inherit the suggester's own VIBES flag:
 * a person reads them first, unless the board-wide switch is on, and then the
 * sweep takes them like any other Backlog card.
 *
 * A title this card has suggested before is skipped, archived cards included,
 * since those were taken off on purpose — so a stage rejected and run again,
 * or resumed after its questions were answered, does not suggest the same
 * thing twice. The cap is counted after that, so a rerun can still add what is
 * new.
 */
export function recordSuggestions(db: Db, ctx: StageContext, tasks: SuggestedTask[]): void {
  const have = new Set(cardsSuggestedBy(db, ctx.card.id).map((c) => key(c.title)));
  // Read now rather than off `ctx`, which is the card as it was when the run
  // started: it may have been dragged into another lane while Claude worked.
  const suggester = getCard(db, ctx.card.id) ?? ctx.card;
  const projectId = suggester.projectId && liveProject(db, suggester.projectId) ? suggester.projectId : null;
  let made = 0;
  for (const task of tasks) {
    const title = task.title.trim();
    if (!title || have.has(key(title))) continue;
    if (made === MAX_PER_RUN) break;
    createCard(db, {
      title,
      body: task.body,
      repoId: suggester.repoId,
      stage: 'backlog',
      kind: 'task',
      projectId,
      suggestedById: ctx.card.id,
      actor: 'claude',
    });
    have.add(key(title));
    made++;
  }
}

const key = (title: string) => title.trim().toLowerCase();
