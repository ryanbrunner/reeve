import { parseArgs } from 'node:util';
import { STAGE_LABELS, isRunnable, type ApiCard } from '@reeve/shared';
import { api } from '../../client.js';
import type { Command } from '../../command.js';
import { cardRef, parseCount, parseOrUsage, print, printJson, usageError } from '../../output.js';
import { appendIndex, findProject, requireStage, resolveTarget, whereAmI } from '../../resolve.js';
import { runIds, watchPullRequest, watchStart } from '../../setOff.js';

/**
 * A move from the terminal is the same human action as a drag, and the server
 * treats it as one: the event is recorded as yours, and entering a column
 * sets off what entering it always does.
 */
export const move: Command = {
  usage: `  reeve card move <card> <stage> [--index N] [--project <project> | --no-project] [--json]
      Move a card to the end of a column, or to slot N in it, exactly as dragging it there would —
      which in Reeve is a human action, and is recorded as yours whoever runs the command.
      Moving a card INTO Planning, In Progress or Testing starts a Claude run there, which spends
      money, unless its last run in that column is still waiting on your review or your answers.
      Moving it INTO Done pushes its branch and opens a pull request on GitHub.
      Reordering within a column starts nothing. The command waits a few seconds to say what the
      move set off — the run's id, or the pull request's link — on stderr.
      --project files it under a project's lane as it goes; --no-project takes it out of one.`,

  async run(args) {
    const { values, positionals } = parseOrUsage(() =>
      parseArgs({
        args,
        allowPositionals: true,
        options: {
          index: { type: 'string' },
          project: { type: 'string' },
          'no-project': { type: 'boolean' },
          json: { type: 'boolean' },
        },
      }),
    );
    const [ref, stageArg] = positionals;
    if (ref === undefined || stageArg === undefined || positionals.length > 2) {
      throw usageError('card move needs a card and a stage, as in: reeve card move reeve#12 in-progress');
    }
    if (values.project !== undefined && values['no-project']) throw usageError('give --project or --no-project, not both');
    const stage = requireStage(stageArg);
    const index = values.index === undefined ? undefined : parseCount('--index', values.index);

    const board = await api.board();
    const target = resolveTarget(board, ref, whereAmI(board, process.cwd()));
    const projectId = values['no-project'] ? null : values.project === undefined ? undefined : findProject(board, values.project).id;
    // Taken before the move, so a run it starts is the one not among them.
    const before = isRunnable(stage) ? await runIds(target.id) : new Set<string>();

    // A project is refused here by the server, which is the one that knows why.
    const answer = await api.moveCard(target.id, { stage, index: index ?? appendIndex(board, target.id, stage), projectId });
    // The move answers without the repo's name; the card had it a moment ago.
    const moved: ApiCard = { ...answer, repoName: target.card?.repoName ?? null, laneColor: target.card?.laneColor ?? null };
    const from = target.card?.stage ?? moved.stage;
    let card = moved;
    // The answer itself, not a fresh read: `openingPr` in it is the push this
    // move began, where a later read could find it already over.
    if (from !== moved.stage && moved.stage === 'done') card = await watchPullRequest(moved);
    else if (from !== moved.stage && isRunnable(moved.stage)) card = await watchStart(moved, before);

    if (values.json) return printJson(card);
    print(
      from === card.stage
        ? `Moved ${cardRef(card)} within ${STAGE_LABELS[card.stage]}`
        : `Moved ${cardRef(card)} from ${STAGE_LABELS[from]} to ${STAGE_LABELS[card.stage]}`,
    );
  },
};
