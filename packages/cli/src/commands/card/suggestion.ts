import { parseArgs } from 'node:util';
import { api } from '../../client.js';
import type { Command } from '../../command.js';
import { cardRef, parseOrUsage, print, printJson, usageError } from '../../output.js';
import { resolveCard, whereAmI } from '../../resolve.js';

/**
 * A person's decision on a card a run suggested: the Accept and Reject buttons
 * on its face. Not `approve` and `reject`, which are the review gate. Whether
 * the card is a suggestion still waiting on someone is the server's to say,
 * and its refusal names which reason applies, so nothing here checks first.
 *
 * The card is always named. A Backlog suggestion has no worktree to be in, and
 * guessing the card is the wrong default for a verb that archives one.
 */
function parse(args: string[], name: string) {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } }),
  );
  const [ref, ...extra] = positionals;
  if (ref === undefined || extra.length) throw usageError(`card ${name} needs one card`);
  return { ref, json: values.json ?? false };
}

async function decide(args: string[], name: string, decision: 'accepted' | 'rejected') {
  const { ref, json } = parse(args, name);
  const board = await api.board();
  const card = resolveCard(board, ref, whereAmI(board, process.cwd()));
  // The route answers with the card's repo name, so it names itself.
  const decided = await api.decideSuggestion(card.id, decision);
  return { decided, json };
}

export const accept: Command = {
  usage: `  reeve card accept <card> [--json]
      Keep a card a run suggested: the board's Accept button. It stays in Backlog, where it
      was, and loses only its suggestion badge. Refused for a card a person made, or one
      already accepted, archived or out of Backlog.`,

  async run(args) {
    const { decided, json } = await decide(args, 'accept', 'accepted');
    if (json) return printJson(decided);
    print(`Accepted ${cardRef(decided)}; it stays in Backlog.`);
  },
};

export const dismiss: Command = {
  usage: `  reeve card dismiss <card> [--json]
      Turn down a card a run suggested: the board's Reject button. The card is archived, not
      deleted, which also stops the same title being suggested again; \`card restore\` brings
      it back. Refused as \`card accept\` is, and while the card's Suggest run is going.`,

  async run(args) {
    const { decided, json } = await decide(args, 'dismiss', 'rejected');
    if (json) return printJson(decided);
    print(`Dismissed ${cardRef(decided)}: it is archived, and \`reeve card restore\` brings it back.`);
  },
};
