import { parseArgs } from 'node:util';
import { STAGE_LABELS } from '@reeve/shared';
import { api } from '../../client.js';
import type { Command } from '../../command.js';
import { cardRef, parseOrUsage, print, printJson, usageError } from '../../output.js';
import { resolveCard, resolveTarget, whereAmI } from '../../resolve.js';

function parse(args: string[], name: string) {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } }),
  );
  const [ref, ...extra] = positionals;
  if (ref === undefined || extra.length) throw usageError(`card ${name} needs one card`);
  return { ref, json: values.json ?? false };
}

export const archive: Command = {
  usage: `  reeve card archive <card> [--json]
      Take a card, or a project, off the board. Nothing is deleted, and \`card restore\` puts it
      back. Refused while the card has a run or a dev server going: stop them first.`,

  async run(args) {
    const { ref, json } = parse(args, 'archive');
    const board = await api.board();
    const target = resolveTarget(board, ref, whereAmI(board, process.cwd()));
    await api.archiveCard(target.id);
    if (json) return printJson({ id: target.id, archived: true });
    print(`Archived ${target.label}.`);
  },
};

export const restore: Command = {
  usage: `  reeve card restore <card> [--json]
      Put an archived card back on the board, in the column it left. <card> is looked for among
      the archived: its number or id, as for any other card.`,

  async run(args) {
    const { ref, json } = parse(args, 'restore');
    const [board, archived] = await Promise.all([api.board(), api.archived()]);
    const card = resolveCard(board, ref, whereAmI(board, process.cwd()), archived);
    const restored = await api.restoreCard(card.id);
    if (json) return printJson(restored);
    print(
      restored.kind === 'project'
        ? `Restored ${cardRef(restored)}.`
        : `Restored ${cardRef(restored)} to ${STAGE_LABELS[restored.stage]}.`,
    );
  },
};
