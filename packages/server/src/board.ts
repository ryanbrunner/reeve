import {
  deriveActivity,
  isRunnable,
  stageEntryRefusal,
  type ApiCard,
  type CardActivity,
  type RunnableStage,
  type Stage,
} from '@reeve/shared';
import type { Db } from './db/client.js';
import {
  cardLinks,
  hasImplementationRun,
  isPendingSuggestion,
  latestClaudeRunForStage,
  type CardLinks,
} from './db/queries.js';
import type { Card, Run } from './db/schema.js';
import { toApiCard } from './mappers.js';
import { canMergePr, isMergingPr, isOpeningPr, isPrConflicting, isResolvingConflicts } from './pullRequest.js';
import { askRegistry } from './runs/asks.js';
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
  // Backlog and Release are holding areas — no Claude work, so nothing to colour.
  if (!isRunnable(stage)) return { activity: 'idle', run: null };

  const run = latestClaudeRunForStage(db, card.id, stage) ?? null;
  if (!run) return { activity: 'idle', run: null };
  return { activity: deriveActivity({ status: run.status, awaitsInput: awaitsInput(stage, run) }), run };
}

/**
 * `links` is for a caller mapping many cards, which reads every link once and
 * hands the lookup to each. Left out, only this card's rows are read.
 */
export function toBoardCard(
  db: Db,
  card: Card,
  repoName: string | null,
  laneColor: string | null,
  links: (id: string) => CardLinks = cardLinks(db, card.id),
): ApiCard {
  const { activity, run } = cardActivity(db, card);
  // Only Release offers a resolution. A card dragged back for another round keeps
  // its pull request, and its conflicts wait until it returns.
  const openInDone = card.stage === 'release' && card.prUrl !== null && card.mergedAt === null;
  return toApiCard(card, repoName, laneColor, run, activity, {
    openingPr: isOpeningPr(card.id),
    prConflicting: openInDone && isPrConflicting(card),
    prMergeable: canMergePr(card),
    resolvingConflicts: isResolvingConflicts(card.id),
    mergingPr: isMergingPr(card.id),
    startingStage: isStartingStage(card.id),
    implemented: hasImplementationRun(db, card.id),
    pendingSuggestion: isPendingSuggestion(card),
    waitingOn: activity === 'needs_input' && run ? waitingOn(card, run) : null,
  }, links(card.id));
}

/**
 * The one line a waiting card shows on the board: what a live run is parked
 * on, or the end of what Claude said before it ended its turn — which is
 * where it puts its question.
 */
function waitingOn(card: Card, run: Run): string | null {
  if (run.status === 'asking') {
    const ask = askRegistry.forCard(card.id);
    if (!ask) return 'Waiting on you';
    if (ask.kind === 'question') return ask.questions[0]?.question ?? 'Asking you a question';
    const command = typeof ask.input['command'] === 'string' ? ask.input['command'] : null;
    return command ? `Asks to run ${oneLine(command, 80)}` : `Asks to use ${ask.toolName}`;
  }
  if (run.status !== 'awaiting_reply' || !run.resultText) return null;
  const lines = run.resultText.split('\n').map((l) => l.replace(/[*_`#>]/g, '').trim()).filter(Boolean);
  const question = [...lines].reverse().find((l) => l.endsWith('?'));
  return oneLine(question ?? lines.at(-1) ?? '', 160) || null;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Why this card may not go to `to`, or null if it may. For anything that would
 * put a card into a column on a person's behalf — the move route, approval,
 * VIBES MODE — and not for `moveCard`, which the spikes call directly to set a
 * card up wherever they need it.
 */
export function entryRefusal(db: Db, card: Card, to: Stage): string | null {
  return stageEntryRefusal(card.stage as Stage, to, hasImplementationRun(db, card.id));
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
