import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ApiCard, ApiQuestion } from '@reeve/shared';
import { api } from '../client.js';
import { EXIT, waitOutcome, type WaitExit } from '../exit.js';
import {
  CliError,
  cardRef,
  note,
  parseOrUsage,
  print,
  printJson,
  stageLabel,
  textOrFile,
  usageError,
} from '../output.js';
import { resolveCard } from '../resolve.js';
import { followRun } from './run.js';

/** How often `wait` asks. The board polls at about this pace while a card is running. */
const POLL_MS = 2_000;

/** The one card every `reeve card` command starts from. */
function oneCard(command: string, positionals: string[]): string {
  const [ref] = positionals;
  if (!ref || positionals.length > 1) throw usageError(`reeve card ${command} takes one card`);
  return ref;
}

/** Hand a started run to `--follow`, or say how to follow it. The id alone goes to stdout. */
async function started(runId: string, what: string, follow: boolean, json: boolean): Promise<void> {
  if (follow) {
    process.exitCode = await followRun(runId, { json });
    return;
  }
  note(`${what} — follow it with \`reeve run follow ${runId}\``);
  print(runId);
}

async function run(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      allowPositionals: true,
      options: { follow: { type: 'boolean', short: 'f' }, json: { type: 'boolean' } },
    }),
  );
  const card = await resolveCard(oneCard('run', positionals));
  const result = await api.startRun(card.id);
  if (values.json && !values.follow) return printJson(result);
  await started(result.runId, `started ${stageLabel(card.stage)} on ${cardRef(card)}`, !!values.follow, !!values.json);
}

/**
 * Passing the gate by hand. Nothing in the CLI calls this on its own: a person
 * or their script chose to, which is what keeps it a human action. SICKO MODE
 * is the switch for approving with nobody deciding.
 */
async function approve(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      allowPositionals: true,
      options: { notes: { type: 'string' }, 'notes-file': { type: 'string' }, json: { type: 'boolean' } },
    }),
  );
  const notes = textOrFile(values.notes, values['notes-file'], 'notes');
  const card = await resolveCard(oneCard('approve', positionals));
  const result = await api.approve(card.id, notes?.trim() || undefined);
  if (values.json) return printJson(result);
  note(
    result.moved
      ? `approved ${stageLabel(result.fromStage)} on ${cardRef(card)}; it is in ${stageLabel(result.toStage)} now`
      : `approved ${stageLabel(result.fromStage)} on ${cardRef(card)}; it has nowhere further to go`,
  );
}

async function reject(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      allowPositionals: true,
      options: {
        notes: { type: 'string' },
        'notes-file': { type: 'string' },
        follow: { type: 'boolean', short: 'f' },
        json: { type: 'boolean' },
      },
    }),
  );
  const notes = textOrFile(values.notes, values['notes-file'], 'notes')?.trim();
  // The server says the same, but only after the card has been looked up.
  if (!notes) throw usageError('a rejection needs --notes: they are the prompt for the next run');
  const card = await resolveCard(oneCard('reject', positionals));
  const result = await api.reject(card.id, notes);
  if (values.json && !values.follow) return printJson(result);
  await started(
    result.revisionRunId,
    `sent ${stageLabel(result.stage)} on ${cardRef(card)} back for revision`,
    !!values.follow,
    !!values.json,
  );
}

function printQuestion(q: ApiQuestion): void {
  print(`${q.position}. ${q.text}`);
  print(`   id: ${q.id}`);
  for (const [i, s] of q.suggestions.entries()) print(`   ${i + 1}) ${s}`);
  print(q.answer === null ? '   unanswered' : `   answered: ${q.answer}`);
}

async function questions(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } }),
  );
  const card = await resolveCard(oneCard('questions', positionals));
  const list = await api.questions(card.id);
  if (values.json) return printJson(list);
  if (list.length === 0) return note(`${cardRef(card)} has no questions in ${stageLabel(card.stage)}`);
  list.forEach((q, i) => {
    if (i > 0) print();
    printQuestion(q);
  });
}

/**
 * The question is its id or its number, 1 being the first. The answer is the
 * rest of the command line, or one of the question's own suggestions.
 */
async function answer(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      allowPositionals: true,
      options: { suggestion: { type: 'string', short: 's' }, json: { type: 'boolean' } },
    }),
  );
  const [ref, which, ...words] = positionals;
  if (!ref || !which) throw usageError('reeve card answer takes a card, a question and an answer');
  if (words.length > 0 && values.suggestion !== undefined) throw usageError('give an answer or --suggestion, not both');

  const card = await resolveCard(ref);
  const list = await api.questions(card.id);
  const question = /^\d+$/.test(which) ? list.find((q) => q.position === Number(which)) : list.find((q) => q.id === which);
  if (!question) throw new CliError(`${cardRef(card)} has no question ${which} in ${stageLabel(card.stage)}`);

  let text = words.join(' ').trim();
  if (values.suggestion !== undefined) {
    const picked = question.suggestions[Number(values.suggestion) - 1];
    if (!/^\d+$/.test(values.suggestion) || picked === undefined) {
      throw usageError(`question ${question.position} has no suggestion ${values.suggestion}`);
    }
    text = picked;
  }
  if (!text) throw usageError('an answer needs words, or --suggestion N');

  const result = await api.answer(card.id, question.id, text);
  if (values.json) return printJson(result);
  if (result.resumed) {
    note(`all ${result.of} answered; Claude is back at work — follow it with \`reeve run follow ${result.resumed}\``);
    return print(result.resumed);
  }
  if (result.blocked) {
    // The answer is saved; only the resume failed. Answering again would not help.
    throw new CliError(`all ${result.of} answered, but the run could not resume: ${result.blocked}`);
  }
  note(`answered ${result.answered} of ${result.of}`);
}

const OUTCOMES: Record<WaitExit, string> = {
  [EXIT.ok]: 'is waiting for review',
  [EXIT.needsInput]: 'has questions',
  [EXIT.failed]: 'failed',
  [EXIT.idle]: 'is idle',
  [EXIT.timeout]: 'is still running',
};

const describe = (card: ApiCard) => `${cardRef(card)} in ${stageLabel(card.stage)}`;

/**
 * Block until the card needs a person, and exit saying which way: see
 * ../exit.ts, which is the contract. A card that needs one already returns at
 * once — the question is "is it my turn", not "has something changed".
 */
async function wait(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      allowPositionals: true,
      options: { timeout: { type: 'string' }, json: { type: 'boolean' } },
    }),
  );
  let deadline = Infinity;
  if (values.timeout !== undefined) {
    const seconds = Number(values.timeout);
    if (!(seconds > 0)) throw usageError(`--timeout is a number of seconds, not '${values.timeout}'`);
    deadline = Date.now() + seconds * 1000;
  }

  let card = await resolveCard(oneCard('wait', positionals));
  let said = '';
  for (;;) {
    const outcome = waitOutcome(card) ?? (Date.now() >= deadline ? EXIT.timeout : null);
    if (outcome !== null) {
      if (values.json) printJson(card);
      else note(`${describe(card)} ${OUTCOMES[outcome]}${failure(card, outcome)}`);
      process.exitCode = outcome;
      return;
    }
    // Once per change rather than once per poll: a run that approves into the
    // next column says so, and a long run says nothing for its length.
    const now = `${describe(card)} is ${card.startingStage ? 'starting' : 'running'}`;
    if (now !== said && !values.json) note(`${now}…`);
    said = now;
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    card = await api.card(card.id);
  }
}

/** Why a failed run failed, when the server kept a reason. */
function failure(card: ApiCard, outcome: WaitExit): string {
  if (outcome !== EXIT.failed || !card.latestRun) return '';
  const { stopReason, errorMessage } = card.latestRun;
  return `: ${errorMessage ?? stopReason ?? card.latestRun.status}`;
}

export const cardCommands: Record<string, (args: string[]) => Promise<void>> = {
  run,
  approve,
  reject,
  questions,
  answer,
  wait,
};
