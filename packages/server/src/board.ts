import { deriveActivity, isRunnable, type ApiCard, type CardActivity, type RunnableStage, type Stage } from '@reeve/shared';
import type { Db } from './db/client.js';
import { dependenciesOf, dependentsOf, latestClaudeRunForStage } from './db/queries.js';
import type { Card, Run } from './db/schema.js';
import { toApiCard, toApiCardLink } from './mappers.js';
import { isOpeningPr, isPrConflicting, isResolvingConflicts } from './pullRequest.js';
import { stageDefinition } from './stages/index.js';

/**
 * How a card is presented on the board: which column it sits in is the human's
 * decision and lives on the row, but the colour of the card is read fresh from
 * the runs every time. Nothing about the sub-state is stored, so it cannot
 * drift out of sync with the run that produced it.
 */
export function cardActivity(db: Db, card: Card): { activity: CardActivity; run: Run | null } {
  const stage = card.stage as Stage;
  // Backlog and Done are holding areas — no Claude work, so nothing to colour.
  if (!isRunnable(stage)) return { activity: 'idle', run: null };

  const run = latestClaudeRunForStage(db, card.id, stage) ?? null;
  if (!run) return { activity: 'idle', run: null };
  return { activity: deriveActivity({ status: run.status, awaitsInput: awaitsInput(stage, run) }), run };
}

export function toBoardCard(
  db: Db,
  card: Card,
  repoName: string | null,
  laneColor: string | null,
): ApiCard {
  const { activity, run } = cardActivity(db, card);
  // Only Done offers a resolution. A card dragged back for another round keeps
  // its pull request, and its conflicts wait until it returns.
  const openInDone = card.stage === 'done' && card.prUrl !== null && card.mergedAt === null;
  return toApiCard(
    card,
    repoName,
    laneColor,
    run,
    activity,
    {
      openingPr: isOpeningPr(card.id),
      prConflicting: openInDone && isPrConflicting(card),
      resolvingConflicts: isResolvingConflicts(card.id),
    },
    // Two indexed lookups a card, on the same footing as its latest run above.
    // A board is tens of cards, not thousands.
    {
      dependsOn: dependenciesOf(db, card.id).map((d) => toApiCardLink(d.card, d.repoName, dependencyDone(d.card))),
      dependents: dependentsOf(db, card.id),
    },
  );
}

/**
 * Whether a card has stopped holding up the cards that wait on it: it reached
 * Done, or its pull request merged. The one place that says so, so the board's
 * marker and anything that later refuses to start a waiting card cannot
 * disagree.
 *
 * Merged counts even outside Done, because a card dragged back for another
 * round after landing has still landed. Archived does not count on its own: a
 * card taken off the board unfinished was abandoned, and whatever waited on it
 * is still waiting — which the board should go on saying, not quietly drop.
 */
export function dependencyDone(card: Card): boolean {
  return card.stage === 'done' || card.mergedAt !== null;
}

/**
 * Only the stage that produced an output can say whether it contains a
 * question, and `STAGE_DEFINITIONS` is partial while `in_progress` and
 * `testing` are unbuilt — so an unimplemented stage, a stage with no
 * `awaitsInput`, or output that no longer parses all degrade to "nothing
 * pending" rather than throwing inside the board query.
 */
function awaitsInput(stage: RunnableStage, run: Run): boolean {
  if (run.status !== 'succeeded') return false;
  const definition = stageDefinition(stage);
  if (!definition?.awaitsInput) return false;
  const parsed = definition.schema.safeParse(run.structuredOutput);
  return parsed.success ? definition.awaitsInput(parsed.data) : false;
}
