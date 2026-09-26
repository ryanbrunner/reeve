import { deriveActivity, isRunnable, type ApiCard, type CardActivity, type RunnableStage, type Stage } from '@reeve/shared';
import type { Db } from './db/client.js';
import { dependencyLinks, latestClaudeRunForStage, type DependencyLinks } from './db/queries.js';
import type { Card, Run } from './db/schema.js';
import { toApiCard } from './mappers.js';
import { isOpeningPr, isPrConflicting, isResolvingConflicts } from './pullRequest.js';
import { stageDefinition } from './stages/index.js';
// A cycle, as startStage reads cardActivity from here. Harmless: neither side
// calls the other while the modules are still loading.
import { isStartingStage } from './startStage.js';

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

/**
 * `links` is for a caller mapping many cards, which reads the dependency table
 * once and hands the lookup to each. Left out, only this card's rows are read.
 */
export function toBoardCard(
  db: Db,
  card: Card,
  repoName: string | null,
  laneColor: string | null,
  links: (id: string) => DependencyLinks = dependencyLinks(db, card.id),
): ApiCard {
  const { activity, run } = cardActivity(db, card);
  // Only Done offers a resolution. A card dragged back for another round keeps
  // its pull request, and its conflicts wait until it returns.
  const openInDone = card.stage === 'done' && card.prUrl !== null && card.mergedAt === null;
  return toApiCard(card, repoName, laneColor, run, activity, {
    openingPr: isOpeningPr(card.id),
    prConflicting: openInDone && isPrConflicting(card),
    resolvingConflicts: isResolvingConflicts(card.id),
    startingStage: isStartingStage(card.id),
  }, links(card.id));
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
