import { parseArgs } from 'node:util';
import { isRunnable, STAGE_LABELS } from '@reeve/shared';
import { api } from '../client.js';
import { cardRef, note, parseCount, parseOrUsage, print, printJson, usageError } from '../output.js';
import { appendIndex, requireStage, resolveCard, whereAmI } from '../resolve.js';

/**
 * Moves a card to the end of a column, or to `--index`. The server treats it
 * exactly as a drag: entering a column Claude works in starts a run, and
 * entering Done opens the pull request.
 */
export async function move(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      allowPositionals: true,
      options: { index: { type: 'string' }, json: { type: 'boolean' } },
    }),
  );
  const [ref, stageArg] = positionals;
  if (ref === undefined || stageArg === undefined || positionals.length > 2) {
    throw usageError('move needs a card and a stage, as in: reeve move reeve#12 in-progress');
  }
  const stage = requireStage(stageArg);
  const index = values.index === undefined ? undefined : parseCount('index', values.index);

  const board = await api.board();
  const card = resolveCard(board, ref, whereAmI(board, process.cwd()));
  if (card.stage !== stage && card.repoId) {
    if (stage === 'done' && card.worktreePath && !card.mergedAt) {
      note(`Done opens a pull request for ${cardRef(card)}'s branch.`);
    } else if (isRunnable(stage)) {
      note(`${STAGE_LABELS[stage]} runs Claude: ${cardRef(card)} starts a run there unless it is waiting on a review.`);
    }
  }

  const moved = await api.moveCard(card.id, { stage, index: index ?? appendIndex(board, card.id, stage) });
  // The move answers without the repo's name; the card had it a moment ago.
  const result = { ...moved, repoName: card.repoName, laneColor: card.laneColor };
  if (values.json) return printJson(result);
  print(
    card.stage === result.stage
      ? `Moved ${cardRef(result)} within ${STAGE_LABELS[result.stage]}`
      : `Moved ${cardRef(result)} from ${STAGE_LABELS[card.stage]} to ${STAGE_LABELS[result.stage]}`,
  );
}
