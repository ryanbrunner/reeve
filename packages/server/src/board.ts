import { deriveActivity, isRunnable, type ApiCard, type CardActivity, type RunnableStage, type Stage } from '@reeve/shared';
import type { Db } from './db/client.js';
import { latestClaudeRunForStage } from './db/queries.js';
import type { Card, Run } from './db/schema.js';
import { toApiCard } from './mappers.js';
import { isOpeningPr } from './pullRequest.js';
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
  return toApiCard(card, repoName,laneColor, run, activity, isOpeningPr(card.id));
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
