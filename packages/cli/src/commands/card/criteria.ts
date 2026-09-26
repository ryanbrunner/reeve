import { parseArgs } from 'node:util';
import type { ApiCriterion } from '@reeve/shared';
import { api } from '../../client.js';
import { group, type Command } from '../../command.js';
import { CliError, parseCount, parseOrUsage, print, printJson, usageError } from '../../output.js';
import { resolveTarget, whereAmI } from '../../resolve.js';

/**
 * Acceptance criteria: what done means for a card, which Testing judges one
 * by one. They are numbered as the Brief tab and Testing's verdicts number
 * them, from 1 in their order, so `rm 2` is the second one `list` shows.
 */

async function parse(args: string[], name: string) {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } }),
  );
  const [ref, ...rest] = positionals;
  if (ref === undefined) throw usageError(`criteria ${name} needs a card`);
  const board = await api.board();
  return { target: resolveTarget(board, ref, whereAmI(board, process.cwd())), rest, json: values.json ?? false };
}

function show(criteria: ApiCriterion[]): void {
  criteria.forEach((c, i) => {
    const verdict = c.verdict === 'pass' ? '✓' : c.verdict === 'fail' ? '✕' : ' ';
    print(`${verdict} ${String(i + 1).padStart(2)}. ${c.text}`);
    if (c.evidence) print(`       ${c.evidence}`);
  });
}

const list: Command = {
  usage: `  reeve card criteria list <card> [--json]
      A card's acceptance criteria, numbered, with Testing's verdict on each once it has one.`,
  async run(args) {
    const { target, rest, json } = await parse(args, 'list');
    if (rest.length) throw usageError('criteria list takes only a card');
    const criteria = await api.criteria(target.id);
    if (json) return printJson(criteria);
    if (!criteria.length) return print(`${target.label} has no acceptance criteria yet.`);
    show(criteria);
  },
};

const add: Command = {
  usage: `  reeve card criteria add <card> <text> [--json]
      Add one criterion, after the others. Quote the text or not: the words are joined.`,
  async run(args) {
    const { target, rest, json } = await parse(args, 'add');
    const text = rest.join(' ').trim();
    if (!text) throw usageError('criteria add needs the criterion itself');
    const added = await api.addCriterion(target.id, text);
    if (json) return printJson(added);
    const count = (await api.criteria(target.id)).length;
    print(`Added criterion ${count} to ${target.label}: ${added.text}`);
  },
};

const rm: Command = {
  usage: `  reeve card criteria rm <card> <n> [--json]
      Remove criterion n, as \`criteria list\` numbers it. The ones after it move up.`,
  async run(args) {
    const { target, rest, json } = await parse(args, 'rm');
    const [n, ...extra] = rest;
    if (n === undefined || extra.length) throw usageError('criteria rm needs a card and one criterion number');
    const index = parseCount('the criterion number', n);
    const criteria = await api.criteria(target.id);
    const doomed = criteria[index - 1];
    if (index < 1 || !doomed) {
      throw new CliError(`${target.label} has ${criteria.length} criteria, so there is no number ${index}`);
    }
    await api.deleteCriterion(target.id, doomed.id);
    if (json) return printJson(doomed);
    print(`Removed criterion ${index} from ${target.label}: ${doomed.text}`);
  },
};

/**
 * Not a command, only the answer to one that would be reasonable to try. A
 * verdict belongs to the Testing run that reached it, with the evidence it
 * found; ticking one by hand would be a claim nobody checked.
 */
const check: Command = {
  usage: '',
  async run() {
    throw new CliError(
      'criteria are checked by Testing, not by hand: each verdict belongs to the run that reached it. ' +
        '`reeve card criteria list` shows them.',
    );
  },
};

export const criteria = group('card criteria', { list, add, rm, check });
