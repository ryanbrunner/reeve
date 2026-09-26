import { parseArgs } from 'node:util';
import { STAGE_LABELS } from '@reeve/shared';
import { api } from '../../client.js';
import type { Command } from '../../command.js';
import { cardRef, parseOrUsage, print, printJson, usageError } from '../../output.js';
import { resolveCard, resolveTarget, whereAmI } from '../../resolve.js';

/** `--detach-open` is archive's alone, so restore still refuses it as a typo. */
function parse(args: string[], name: string, detachOpen = false) {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      allowPositionals: true,
      options: { json: { type: 'boolean' }, ...(detachOpen ? { 'detach-open': { type: 'boolean' } } : {}) },
    }),
  );
  const [ref, ...extra] = positionals;
  if (ref === undefined || extra.length) throw usageError(`card ${name} needs one card`);
  return { ref, json: values.json ?? false, detachOpen: values['detach-open'] === true };
}

const cards = (n: number) => `${n} ${n === 1 ? 'card' : 'cards'}`;

export const archive: Command = {
  usage: `  reeve card archive <card> [--detach-open] [--json]
      Take a card, or a project, off the board. Nothing is deleted, and \`card restore\` puts it
      back. Refused while the card has a run or a dev server going: stop them first.
      A project takes its Done cards with it. One with cards not yet Done is refused, naming
      them, unless --detach-open says to move them to No project, where they carry on.
      --json prints the server's answer: for a project, how many cards went and how many moved.`,

  async run(args) {
    const { ref, json, detachOpen } = parse(args, 'archive', true);
    const board = await api.board();
    const target = resolveTarget(board, ref, whereAmI(board, process.cwd()));
    const done = await api.archiveCard(target.id, detachOpen ? { detachOpen } : undefined);
    if (json) return printJson(done);
    const taken = done.archived ? `, with ${cards(done.archived)} from Done` : '';
    const moved = done.detached ? ` Moved ${cards(done.detached)} to No project.` : '';
    print(`Archived ${target.label}${taken}.${moved}`);
  },
};

export const restore: Command = {
  usage: `  reeve card restore <card> [--json]
      Put an archived card back on the board, in the column it left. <card> is looked for among
      the archived: its number or id, as for any other card. A project brings back the Done
      cards archived with it, but not cards archived on their own or moved to No project.`,

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
