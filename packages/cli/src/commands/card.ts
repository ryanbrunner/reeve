import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import {
  STAGE_LABELS,
  needsWorktree,
  type ApiCard,
  type ApiDiff,
  type ApiQuestion,
  type BoardResponse,
  type CardDetail,
} from '@reeve/shared';
import { api, baseUrl } from '../client.js';
import { type Command } from '../command.js';
import { EXIT, waitOutcome, type WaitExit } from '../exit.js';
import {
  CliError,
  activityLabel,
  cardRef,
  formatTokens,
  formatTime,
  note,
  parseOrUsage,
  print,
  printJson,
  stageLabel,
  textOrFile,
  usageError,
} from '../output.js';
import { resolveCard, resolveCardRef, whereAmI } from '../resolve.js';
import { add } from './card/add.js';
import { archive, restore } from './card/archive.js';
import { criteria } from './card/criteria.js';
import { edit } from './card/edit.js';
import { move } from './card/move.js';
// `note` is already the stderr printer here; this is the verb that writes one.
import { note as noteCard } from './card/note.js';
import { followRun } from './run.js';
import { renderRuns, totalTokens } from './runs.js';

/**
 * `reeve card <action> [<card>]`: the buttons on a card's rail and its
 * attention band, for a caller who is not looking at either.
 *
 * Each prints the one thing a script would want on stdout — a path, a URL, the
 * diff — and says everything else on stderr, so `cd "$(reeve card worktree 12)"`
 * and `open "$(reeve card server 12)"` work as they read.
 */

/** Everything an action is handed: the parsed flags, the card, and the board it was found on. */
interface ActionTarget {
  values: Record<string, unknown>;
  card: ApiCard;
  board: BoardResponse;
}

/**
 * The card named, or with none, the one whose worktree the cwd is in — the
 * same rule as `reeve show`, so a session inside a card can act on it
 * without knowing its number.
 */
async function target(
  action: string,
  args: string[],
  flags: Record<string, { type: 'boolean' }> = {},
): Promise<ActionTarget> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, allowPositionals: true, options: { ...flags, json: { type: 'boolean' } } }),
  );
  if (positionals.length > 1) throw usageError(`card ${action} takes at most one card`);
  const [ref] = positionals;

  const board = await api.board();
  const here = whereAmI(board, process.cwd());
  const card = ref === undefined ? here.card : resolveCard(board, ref, here);
  if (!card) throw usageError(`no card given, and ${process.cwd()} is not inside a card's worktree`);
  return { values: values as Record<string, unknown>, card, board };
}

const baseBranchOf = (board: BoardResponse, card: ApiCard) =>
  board.repos.find((r) => r.id === card.repoId)?.defaultBranch ?? 'the base branch';

/**
 * Prints the card's worktree path, making the worktree first if it has none.
 * Making one also starts the repo's setup command, in the background, as it
 * does when a card enters Planning.
 */
async function worktree(args: string[]): Promise<void> {
  const { values, card } = await target('worktree', args, { remove: { type: 'boolean' } });

  if (values.remove) {
    note(
      `Removing ${cardRef(card)}'s worktree: its dev server stops, the repo's teardown command runs, ` +
        'and the directory goes, uncommitted work included. The branch stays.',
    );
    const removed = await api.removeWorktree(card.id);
    if (values.json) return printJson(removed);
    print(`Removed ${cardRef(card)}'s worktree${card.worktreePath ? ` at ${card.worktreePath}` : ''}`);
    if (removed.forced) note('It had uncommitted changes, and they were removed with it.');
    return;
  }

  // The server makes worktrees only for the columns that need one, but a card
  // dragged back to Backlog keeps the one it had, and that is still worth a cd.
  if (!needsWorktree(card.stage) && card.worktreePath && existsSync(card.worktreePath)) {
    if (values.json) return printJson({ ok: true, reused: true, path: card.worktreePath });
    return print(card.worktreePath);
  }
  // The server's refusal names the stage and nothing else. Said as the card's
  // rail says it, so the way to a worktree is in the message.
  if (!needsWorktree(card.stage)) {
    throw new CliError(`${cardRef(card)} is in ${STAGE_LABELS[card.stage]}, which has no worktree. Move it to Planning to get one`);
  }

  const made = await api.createWorktree(card.id);
  if (values.json) return printJson(made);
  if (!made.reused) {
    note(`Made a worktree for ${cardRef(card)}${made.branch ? ` on ${made.branch}` : ''}.`);
    if (made.setupRunId) note(`The repo's setup command is running in it (run ${made.setupRunId}).`);
  }
  print(made.path);
}

/**
 * Pushes a Done card's branch and opens its pull request, or pushes to the
 * one already open. Entering Done tries this once on its own; this is the
 * retry once whatever stopped it has been put right.
 */
async function pr(args: string[]): Promise<void> {
  const { values, card } = await target('pr', args);
  // Only where a push can happen: the server refuses anything else before it tries.
  if (card.stage === 'done') note(`Pushing ${cardRef(card)}'s branch to origin…`);
  const opened = await api.openPr(card.id);
  if (values.json) return printJson(opened);
  note(opened.reused ? `Pushed to the open pull request #${opened.number}.` : `Opened pull request #${opened.number}.`);
  print(opened.url);
}

/**
 * Merges the base branch into a Done card's branch and pushes it. When the
 * merge conflicts, Claude resolves it in a run of its own and the push waits
 * for that run; a clean merge is pushed before this returns.
 */
async function resolveConflicts(args: string[]): Promise<void> {
  const { values, card, board } = await target('resolve-conflicts', args);
  const base = baseBranchOf(board, card);
  note(`Merging ${base} into ${cardRef(card)}'s branch…`);
  const result = await api.resolveConflicts(card.id);
  if (values.json) return printJson(result);
  if (result.runId) {
    print(`Claude is resolving the conflicts with ${base} in run ${result.runId}. The branch is pushed when it is done.`);
  } else {
    print(`${base} merged cleanly into ${cardRef(card)}'s branch${result.pushed ? ', and it is pushed' : ''}.`);
  }
}

/**
 * Starts the repo's dev server in the card's worktree and prints its URL. One
 * already running is not an error: its URL is the answer either way.
 */
async function server(args: string[]): Promise<void> {
  const { values, card } = await target('server', args, { stop: { type: 'boolean' } });

  if (values.stop) {
    const stopped = await api.stopServer(card.id);
    if (values.json) return printJson(stopped);
    return print(`Stopped ${cardRef(card)}'s dev server`);
  }

  // A running server with no URL yet is still running: starting it again would
  // only be refused.
  const running = (await api.detail(card.id)).worktree.server;
  if (running?.running) {
    if (values.json) return printJson({ ok: true, runId: running.runId, port: running.port, url: running.url });
    note(`${cardRef(card)}'s dev server was already running.`);
    return running.url ? print(running.url) : note(NO_URL_YET);
  }

  const started = await api.startServer(card.id);
  if (values.json) return printJson(started);
  const on = started.port === null ? '' : ` on port ${started.port}`;
  note(`Started ${cardRef(card)}'s dev server${on} (run ${started.runId}).`);
  if (started.url) print(started.url);
  else note(NO_URL_YET);
}

/**
 * The URL is only ever one the server announced, the repo's template, or a
 * `{{port}}` in the command, so a server that has not printed one yet has none.
 */
const NO_URL_YET = "It hasn't said where it is serving yet; run this again once it has to get its URL.";

/**
 * The diff as git would print it, rebuilt from the parsed files the Diff tab
 * reads. It is for reading: it has no index lines, so it will not always
 * `git apply`. For that, run git in the worktree.
 */
function renderDiff(diff: ApiDiff): string {
  const out: string[] = [];
  for (const file of diff.files) {
    const from = file.oldPath ?? file.path;
    out.push(`diff --git a/${from} b/${file.path}`);
    if (file.status === 'added') out.push('new file');
    if (file.status === 'deleted') out.push('deleted file');
    if (file.status === 'renamed') out.push(`rename from ${from}`, `rename to ${file.path}`);
    if (file.binary) {
      out.push('Binary files differ');
      continue;
    }
    if (file.hunks.length === 0) continue;
    out.push(file.status === 'added' ? '--- /dev/null' : `--- a/${from}`);
    out.push(file.status === 'deleted' ? '+++ /dev/null' : `+++ b/${file.path}`);
    for (const hunk of file.hunks) {
      out.push(hunk.header);
      for (const line of hunk.lines) {
        out.push(`${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`);
      }
    }
  }
  return out.join('\n');
}

function renderStat(diff: ApiDiff): string {
  const width = Math.max(0, ...diff.files.map((f) => f.path.length));
  const lines = diff.files.map((f) =>
    f.binary ? `  ${f.path.padEnd(width)}  binary` : `  ${f.path.padEnd(width)}  +${f.additions} -${f.deletions}`,
  );
  const files = diff.files.length === 1 ? '1 file' : `${diff.files.length} files`;
  return [...lines, `${files} changed, +${diff.additions} -${diff.deletions}`].join('\n');
}

/**
 * What the card has changed against the commit its worktree started from,
 * committed or not. A merged card's is the commit it landed as.
 */
async function diff(args: string[]): Promise<void> {
  const { values, card } = await target('diff', args, { stat: { type: 'boolean' } });
  const changes = await api.diff(card.id);
  if (values.json) return printJson(changes);
  if (changes.files.length === 0) {
    note(card.worktreePath || card.mergedSha ? `${cardRef(card)} has changed nothing.` : `${cardRef(card)} has no worktree.`);
    return;
  }
  print(values.stat ? renderStat(changes) : renderDiff(changes));
}

/** The card's commits, newest first, the same list as the rail. */
async function commits(args: string[]): Promise<void> {
  const { values, card } = await target('commits', args);
  const list = await api.commits(card.id);
  if (values.json) return printJson(list);
  if (list.length === 0) {
    note(card.worktreePath ? `${cardRef(card)} has no commits yet.` : `${cardRef(card)} has no worktree.`);
    return;
  }
  print(list.map((c) => `${c.sha}  ${c.subject}`).join('\n'));
}

/** Runs listed before the rest are only counted. `reeve runs` has them all. */
const RUNS_SHOWN = 5;

const indent = (text: string, by = '  ') =>
  text
    .split('\n')
    .map((line) => (line ? `${by}${line}` : line))
    .join('\n');

function render(detail: CardDetail, projectTitle: string | null): string {
  const { card, worktree } = detail;
  const sections: string[] = [];

  const facts: Array<[string, string | null]> = [
    ['Id', card.id],
    // A project sits in no column, whatever its row says, so it has no stage to show.
    card.kind === 'project'
      ? ['Kind', 'project']
      : ['Stage', `${STAGE_LABELS[card.stage]} · ${activityLabel(card.activity)}`],
    ['Repo', card.repoName],
    ['Project', projectTitle],
    ['Archived', card.archivedAt === null ? null : formatTime(card.archivedAt)],
    ['Branch', worktree.branch],
    ['Worktree', worktree.path && (worktree.exists ? worktree.path : `${worktree.path} (removed)`)],
    ['PR', card.prUrl ?? (card.openingPr ? 'opening…' : null)],
    ['Merged', card.mergedAt === null ? null : formatTime(card.mergedAt)],
    ['Link', `${baseUrl()}/?card=${encodeURIComponent(card.id)}`],
  ];
  const shown = facts.filter((f): f is [string, string] => f[1] !== null);
  const width = Math.max(...shown.map(([label]) => label.length));
  sections.push([card.title, ...shown.map(([label, value]) => `${label.padEnd(width)}  ${value}`)].join('\n'));

  if (card.body.trim()) sections.push(indent(card.body.trim()));

  if (detail.criteria.length > 0) {
    const lines = detail.criteria.map((c) => `  [${(c.verdict ?? '').padEnd(4)}] ${c.text}`);
    sections.push(['Criteria', ...lines].join('\n'));
  }

  // Only the open ones: an answered question is history, and the events have it.
  const open = detail.questions.filter((q) => q.answer === null);
  if (open.length > 0) {
    const lines = open.flatMap((q) => [`  ${q.position}. ${q.text}`, ...q.suggestions.map((s) => `     - ${s}`)]);
    sections.push(['Open questions', ...lines].join('\n'));
  }

  if (detail.plan) {
    const { plan } = detail;
    sections.push(`Plan v${plan.version} (${plan.risk} risk, ${plan.steps.length} steps)\n${indent(plan.summary)}`);
  }
  if (detail.implementation) sections.push(`Implementation\n${indent(detail.implementation.summary)}`);
  if (detail.checks) {
    const { checks } = detail;
    const verdict = checks.passed ? 'passed' : 'failed';
    sections.push(
      `Checks ${verdict} (${checks.criteriaVerified}/${checks.criteriaTotal} criteria)\n${indent(checks.summary)}`,
    );
  }

  if (detail.runs.length > 0) {
    const lines = renderRuns(detail.runs.slice(0, RUNS_SHOWN), '  ');
    const more = detail.runs.length - RUNS_SHOWN;
    if (more > 0) lines.push(`  …and ${more} more`);
    sections.push([`Runs (${detail.runs.length} · ${formatTokens(totalTokens(detail.runs))})`, ...lines].join('\n'));
  }

  return sections.join('\n\n');
}

/** One card in full, by id or a unique prefix of one. `--json` is the detail endpoint's answer as it came. */
async function show(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } }),
  );
  if (positionals.length !== 1) throw usageError('card show takes one card');
  const { card, board } = await resolveCardRef(positionals[0]!);
  const detail = await api.detail(card.id);
  if (values.json) return printJson(detail);
  const project = detail.card.projectId ? board.projects.find((p) => p.id === detail.card.projectId) : undefined;
  print(render(detail, project?.title ?? null));
}

/** The run-driving verbs want the card alone; the board comes back with it for `show`. */
const oneCardOnBoard = async (ref: string) => (await resolveCardRef(ref)).card;

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
  const card = await oneCardOnBoard(oneCard('run', positionals));
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
  const card = await oneCardOnBoard(oneCard('approve', positionals));
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
  const card = await oneCardOnBoard(oneCard('reject', positionals));
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
  const card = await oneCardOnBoard(oneCard('questions', positionals));
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

  const card = await oneCardOnBoard(ref);
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

  let card = await oneCardOnBoard(oneCard('wait', positionals));
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

/**
 * `reeve card <verb>`: everything done to one card, under the noun it is done
 * to — reading it, driving the stage it is in, and writing it.
 *
 * The verbs that came with the board's own reader are plain functions and take
 * their help from the one usage page in `main.ts`; the ones that write a card
 * carry their own, and `--help` after such a verb prints that.
 */
const VERBS: Record<string, Command> = {
  show: { usage: '', run: show },
  run: { usage: '', run },
  approve: { usage: '', run: approve },
  reject: { usage: '', run: reject },
  questions: { usage: '', run: questions },
  answer: { usage: '', run: answer },
  wait: { usage: '', run: wait },
  add,
  edit,
  criteria,
  note: noteCard,
  move,
  archive,
  restore,
  worktree: { usage: '', run: worktree },
  pr: { usage: '', run: pr },
  'resolve-conflicts': { usage: '', run: resolveConflicts },
  server: { usage: '', run: server },
  diff: { usage: '', run: diff },
  commits: { usage: '', run: commits },
};

/** The verbs that carry help, and a line for the ones that take theirs from `main.ts`. */
const CARD_USAGE = [
  `reeve card <verb>. Reading and driving a run: ${Object.entries(VERBS)
    .filter(([, c]) => !c.usage)
    .map(([name]) => name)
    .join(', ')} — see reeve --help.`,
  '',
  ...Object.values(VERBS)
    .map((c) => c.usage)
    .filter(Boolean),
].join('\n');

export async function card(args: string[]): Promise<void> {
  const [verb, ...rest] = args;
  if (verb === undefined || verb === 'help' || verb === '--help' || verb === '-h') return print(CARD_USAGE);
  const command = Object.hasOwn(VERBS, verb) ? VERBS[verb] : undefined;
  if (!command) throw usageError(`unknown card verb '${verb}'`);
  if (command.usage && !command.isGroup && (rest.includes('--help') || rest.includes('-h'))) {
    return print(command.usage);
  }
  try {
    return await command.run(rest);
  } catch (e) {
    // The verb's own help if it has any; otherwise main.ts falls back to the page.
    if (e instanceof CliError && e.exitCode === 2 && e.usage === null) e.usage = command.usage || null;
    throw e;
  }}
