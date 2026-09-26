import { parseArgs } from 'node:util';
import { PLACEHOLDER_TITLE, type BoardResponse, type SickoState } from '@reeve/shared';
import { api } from '../client.js';
import { formatCost, formatTime, note, parseOrUsage, print, printJson, usageError } from '../output.js';

/**
 * `reeve sicko on|off`: SICKO MODE, from a script.
 *
 * Its own command rather than a key under `reeve settings set`, because it is
 * not a preference. It takes Reeve's human gates off every card on the board:
 * reviews approved unread, questions answered by Claude, Backlog started and
 * pull requests merged, with nobody watching. A switch that big should be
 * spelled out where it is flipped.
 *
 * Like the switch on the board there is no "are you sure": the command is its
 * own undo, and what it does instead of asking is say exactly what just came
 * off, the same list the arming overlay shows.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What the next sweep does to this board, counted from it. The same rules
 * as the sweep in the server's sicko/engine.ts: a card with no repo is left
 * alone, and so is a Backlog card nobody has written anything on yet.
 */
function whatComesOff(board: BoardResponse): string[] {
  const live = board.cards.filter((c) => c.repoId !== null);
  const backlog = live.filter(
    (c) => c.stage === 'backlog' && !(c.title.trim() === PLACEHOLDER_TITLE && c.body.trim() === ''),
  ).length;
  const reviews = live.filter((c) => c.activity === 'needs_review').length;
  const questions = live.filter((c) => c.activity === 'needs_input').length;
  const done = live.filter((c) => c.stage === 'done' && !c.mergedAt).length;
  return [
    'SICKO MODE takes you out of the loop. Until `reeve sicko off`:',
    `  Human review    off: plans, work and test reports are approved unread (${reviews} waiting now)`,
    `  Questions       Claude answers its own (${plural(questions, 'card')} asking now)`,
    '  Stage gates     off: approved cards move on, and idle or failed stages are started again',
    `  Planning        skipped: Backlog goes straight to In Progress (${plural(backlog, 'card')} there now)`,
    `  Merge to main   automatic: Done opens its pull request and merges it (${plural(done, 'card')} in Done now)`,
    '  New ideas       run on arrival: a card added to Backlog starts once it has a title or a brief',
    "Tool permissions, the concurrency cap and the repository's branch protection stay as they are.",
  ];
}

function summary(state: SickoState): string {
  return [
    `${plural(state.moves, 'move')}, ${plural(state.merged, 'merge')}`,
    `${plural(state.reviewsSkipped, 'review')} skipped`,
    `${plural(state.questionsSelfAnswered, 'question')} self-answered`,
    `${formatCost(state.spendUsd)} spent`,
  ].join(', ');
}

async function status(json: boolean): Promise<void> {
  const { sicko } = await api.board();
  if (json) return printJson(sicko);
  if (!sicko) return print('SICKO MODE is off.');
  print(`SICKO MODE has been on since ${formatTime(sicko.since)}: ${summary(sicko)}.`);
  for (const line of sicko.log) print(`  ${line}`);
}

async function on(json: boolean): Promise<void> {
  const board = await api.board();
  if (board.sicko) {
    // Saying on again is harmless — the server keeps the clock — but it is
    // not what the caller thought was happening.
    note(`SICKO MODE was already on, since ${formatTime(board.sicko.since)}.`);
    if (json) return printJson(await api.settings());
    return;
  }
  for (const line of whatComesOff(board)) note(line);
  const saved = await api.updateSettings({ sicko: true });
  if (json) return printJson(saved);
  print('SICKO MODE is on.');
}

async function off(json: boolean): Promise<void> {
  const { sicko } = await api.board();
  const saved = await api.updateSettings({ sicko: false });
  if (json) return printJson(saved);
  if (!sicko) return print('SICKO MODE was already off.');
  print(`SICKO MODE is off. You're back in the loop. While it was on: ${summary(sicko)}.`);
  note('Runs it started carry on to the end; nothing new starts without you.');
}

export async function sicko(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } }),
  );
  if (positionals.length > 1) throw usageError('sicko takes on, off, or nothing');
  const [state] = positionals;
  const json = values.json ?? false;
  if (state === undefined) return status(json);
  if (state === 'on') return on(json);
  if (state === 'off') return off(json);
  throw usageError(`'${state}' is not on or off`);
}
