import { parseArgs } from 'node:util';
import { STAGE_LABELS, STAGES, type Stage } from '@reeve/shared';
import { api } from '../client.js';
import { activityLabel, cardRef, parseOrUsage, print, printJson } from '../output.js';
import { findRepo, requireStage } from '../resolve.js';

/** The board, column by column. `--json` is the cards alone, in board order. */
export async function list(args: string[]): Promise<void> {
  const { values } = parseOrUsage(() =>
    parseArgs({
      args,
      options: { stage: { type: 'string' }, repo: { type: 'string' }, json: { type: 'boolean' } },
    }),
  );
  const stage = values.stage === undefined ? null : requireStage(values.stage);
  const board = await api.board();
  const repo = values.repo === undefined ? null : findRepo(board, values.repo);
  const cards = board.cards.filter((c) => (!stage || c.stage === stage) && (!repo || c.repoId === repo.id));
  if (values.json) return printJson(cards);

  const width = Math.max(0, ...cards.map((c) => cardRef(c).length));
  const stages: readonly Stage[] = stage ? [stage] : STAGES;
  const columns = stages.map((s) => {
    const inColumn = cards.filter((c) => c.stage === s);
    const lines = inColumn.map((c) => {
      const activity = c.activity === 'idle' ? '' : `  [${activityLabel(c.activity)}]`;
      return `  ${cardRef(c).padEnd(width)}  ${c.title}${activity}`;
    });
    return [`${STAGE_LABELS[s]} (${inColumn.length})`, ...lines].join('\n');
  });
  print(columns.join('\n\n'));
}
