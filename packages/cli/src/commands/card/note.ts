import { parseArgs } from 'node:util';
import { api } from '../../client.js';
import type { Command } from '../../command.js';
import { readText } from '../../input.js';
import { parseOrUsage, print, printJson, usageError } from '../../output.js';
import { resolveTarget, whereAmI } from '../../resolve.js';

export const note: Command = {
  usage: `  reeve card note <card> <text> [--json]
  reeve card note <card> - [--json]
      A note for Claude's next run on the card, as the Activity tab takes one. It starts
      nothing: the run that comes next reads it. \`-\` reads the note from stdin.`,

  async run(args) {
    const { values, positionals } = parseOrUsage(() =>
      parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } }),
    );
    const [ref, ...words] = positionals;
    if (ref === undefined) throw usageError('card note needs a card and the note');
    const text = (words.length === 1 && words[0] === '-' ? await readText('-') : words.join(' ')).trim();
    if (!text) throw usageError('card note needs the note itself');

    const board = await api.board();
    const target = resolveTarget(board, ref, whereAmI(board, process.cwd()));
    const event = await api.addNote(target.id, text);
    if (values.json) return printJson(event);
    print(`Noted on ${target.label}.`);
  },
};
