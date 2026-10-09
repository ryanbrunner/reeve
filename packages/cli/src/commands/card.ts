import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import {
  STAGE_LABELS,
  isTerminal,
  needsWorktree,
  type ApiCard,
  type ApiDiff,
  type ApiConversation,
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
import { accept, dismiss } from './card/suggestion.js';
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
  if (!made.reused) note(`Made a worktree for ${cardRef(card)}${made.branch ? ` on ${made.branch}` : ''}.`);
  // A reused one too, when its setup never finished there.
  if (made.setupRunId) note(`The repo's setup command is running in it (run ${made.setupRunId}).`);
  print(made.path);
}

/**
 * Pushes a Release card's branch and opens its pull request, or pushes to the
 * one already open. Entering Release tries this once on its own; this is the
 * retry once whatever stopped it has been put right.
 */
async function pr(args: string[]): Promise<void> {
  const { values, card } = await target('pr', args);
  // Only where a push can happen: the server refuses anything else before it tries.
  if (card.stage === 'release') note(`Pushing ${cardRef(card)}'s branch to origin…`);
  const opened = await api.openPr(card.id);
  if (values.json) return printJson(opened);
  note(opened.reused ? `Pushed to the open pull request #${opened.number}.` : `Opened pull request #${opened.number}.`);
  print(opened.url);
}

/**
 * Merges the base branch into a Release card's branch and pushes it. When the
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
 * Merges a Release card's pull request on GitHub, as the Merge button does, and
 * only when the board would offer that button: GitHub has said the pull
 * request merges cleanly. Asked for by a person or their script, like
 * `approve`; nothing here merges on its own.
 */
async function merge(args: string[]): Promise<void> {
  const { values, card } = await target('merge', args);
  if (card.prNumber !== null) note(`Merging pull request #${card.prNumber}…`);
  const result = await api.mergePr(card.id);
  if (values.json) return printJson(result);
  print(result.merged
    ? `Merged ${cardRef(card)}'s pull request.`
    : `GitHub merged ${cardRef(card)}'s pull request; the card is marked merged on the next sync.`);
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
 * or their script chose to, which is what keeps it a human action. VIBES MODE
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
  if (list.length === 0) {
    // Not a plan's question rows: a run parked on an ask, or a turn that
    // ended on something to reply to. Said here, so a script on exit 3
    // always has something to read.
    const ask = pendingAsk(await api.conversation(card.id));
    if (ask?.request.kind === 'permission') {
      const input = ask.request.input;
      const what = typeof input['command'] === 'string' ? input['command'] : JSON.stringify(input);
      print(`Claude asks to use ${ask.request.toolName}:`);
      print(`   ${what}`);
      return note(`answer with \`reeve card permit ${card.number} allow|deny [--reason …]\``);
    }
    if (ask?.request.kind === 'question') {
      ask.request.questions.forEach((q, i) => {
        if (i > 0) print();
        print(`${i + 1}. ${q.question}`);
        for (const [n, o] of q.options.entries()) print(`   ${n + 1}) ${o.label}${o.description ? ` — ${o.description}` : ''}`);
      });
      return note(`answer with \`reeve card reply ${card.number} <answer>\``);
    }
    if (card.waitingOn) {
      print(card.waitingOn);
      return note(`answer with \`reeve card reply ${card.number} <reply>\``);
    }
    return note(`${cardRef(card)} has no questions in ${stageLabel(card.stage)}`);
  }
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

/**
 * Say something to Claude about the card: interjected into the run if one is
 * going, answering what it is parked on if it is asking, or carrying the
 * stage's conversation on if it is waiting. Prints the run it went to, for
 * `reeve run follow`.
 */
async function reply(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({
      args,
      allowPositionals: true,
      options: { file: { type: 'string' }, follow: { type: 'boolean', short: 'f' }, json: { type: 'boolean' } },
    }),
  );
  const [ref, ...words] = positionals;
  if (!ref) throw usageError('reeve card reply takes a card and what to say');
  const text = (textOrFile(words.join(' ') || undefined, values.file, 'message') ?? '').trim();
  if (!text) throw usageError('a reply needs words, or --file');
  const card = await oneCardOnBoard(ref);
  const result = await api.reply(card.id, text);
  if (values.json && !values.follow) return printJson(result);
  const said = {
    answered: `answered what Claude asked on ${cardRef(card)}`,
    live: `sent to ${cardRef(card)}'s run; Claude reads it at its next step`,
    resumed: `${cardRef(card)}'s conversation carries on`,
    started: `started ${stageLabel(card.stage)} on ${cardRef(card)} with it`,
  }[result.delivered];
  await started(result.runId, said, !!values.follow, !!values.json);
}

/**
 * Allow or deny the call a live run is parked on: auto mode would not approve
 * it on its own, and the run is waiting for a person. Allow is for that one
 * call. `reeve card questions` shows what it is.
 */
async function permit(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' }, json: { type: 'boolean' } } }),
  );
  const [ref, decision] = positionals;
  if (!ref || (decision !== 'allow' && decision !== 'deny')) throw usageError('reeve card permit takes a card and allow or deny');
  const card = await oneCardOnBoard(ref);
  const ask = pendingAsk(await api.conversation(card.id));
  if (!ask || ask.request.kind !== 'permission' || !ask.askId) throw new CliError(`${cardRef(card)} is not waiting on a permission`);
  const result = await api.answerAsk(card.id, ask.askId, { decision, ...(values.reason ? { reason: values.reason } : {}) });
  if (values.json) return printJson(result);
  note(`${decision === 'allow' ? 'allowed' : 'denied'} ${ask.request.toolName} on ${cardRef(card)}`);
}

/** What a live run of the card is parked on, if anything. */
function pendingAsk(conversation: ApiConversation) {
  for (const stage of conversation.stages) {
    for (const run of stage.runs) {
      if (isTerminal(run.status)) continue;
      for (let i = run.items.length - 1; i >= 0; i--) {
        const item = run.items[i]!;
        if (item.kind === 'ask') return item.outcome === null ? item : null;
      }
    }
  }
  return null;
}

const OUTCOMES: Record<WaitExit, string> = {
  [EXIT.ok]: 'is waiting for review',
  [EXIT.needsInput]: 'is waiting on you',
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
 * to — reading it, driving the stage it is in, and writing it. Every verb
 * carries its own usage text, so `reeve card <verb> --help` prints that
 * rather than falling through to `parseArgs` and its bare "Unknown option".
 */
const SHOW_USAGE = `  reeve card show <card> [--json]
      A card in full: its facts, criteria, open questions, plan and runs.
      --json prints the detail endpoint's answer as it came.`;

const RUN_USAGE = `  reeve card run <card> [--follow | -f] [--json]
      Start the stage the card is in, and print the run's id.
      --follow streams its transcript instead of printing the id. Combined with --json, the output
      is \`run follow\`'s own JSON events, not this command's result.
      --json alone prints the started run as JSON.`;

const APPROVE_USAGE = `  reeve card approve <card> [--notes TEXT | --notes-file PATH|-] [--json]
      Pass the gate: the review is recorded, and the card moves to the stage after the one it's
      in, the same as a drag there would — starting a run there if that stage is Planning, In
      Progress or Testing, or, for Release, pushing the branch and opening a pull request, with no
      run until you start one or message the card. Approving a card already in Release leaves it
      there: there is nowhere further to go.
      --notes or --notes-file are kept with the review in the card's history; neither is required.
      --json prints the server's answer: the stage the card left and the one it landed in, if moved.`;

const REJECT_USAGE = `  reeve card reject <card> (--notes TEXT | --notes-file PATH|-) [--follow | -f] [--json]
      Send a card back for revision: the notes become the prompt for the run that revises it, so
      one of --notes or --notes-file is required.
      --follow streams that run's transcript instead of printing its id. Combined with --json, the
      output is \`run follow\`'s own JSON events, not this command's result.
      --json alone prints the started run as JSON.`;

const QUESTIONS_USAGE = `  reeve card questions <card> [--json]
      What Claude is waiting on you for: a plan's questions in the stage the card is in, answered
      or not, or else the permission, question or reply a run is parked on.
      --json prints the plan's questions as the server returned them.`;

const ANSWER_USAGE = `  reeve card answer <card> <question> (<answer…> | --suggestion N | -s N) [--json]
      Answer one question, named by its number (1 is the first) or its id. The answer is either
      the rest of the command line, or one of the question's own suggestions, picked by number.
      Once every open question on the card is answered, the run resumes and its id is printed.
      --json prints the server's answer.`;

const REPLY_USAGE = `  reeve card reply <card> (<text…> | --file PATH|-) [--follow | -f] [--json]
      Talk to Claude about the card. While a run works, the message is read at its next step; when
      Claude is asking something, it is the answer; otherwise the stage's conversation carries on,
      or starts, with it.
      --follow streams the run's transcript instead of printing its id. Combined with --json, the
      output is \`run follow\`'s own JSON events, not this command's result.
      --json alone prints the server's answer: how the message was delivered, and the run.`;

const PERMIT_USAGE = `  reeve card permit <card> allow|deny [--reason TEXT] [--json]
      Allow or deny, once, the call a live run is parked on: one auto mode would not approve on its
      own. --reason goes to Claude with a denial.
      --json prints the server's answer.`;

const WAIT_USAGE = `  reeve card wait <card> [--timeout SECONDS] [--json]
      Block until the card needs a person: a run finished, Claude is waiting on you, or nothing is
      running — a card that needs one already returns at once. --timeout gives up after that many
      seconds instead, exiting ${EXIT.timeout}.
      Exits ${EXIT.ok} waiting for review, ${EXIT.needsInput} Claude is waiting on you, ${EXIT.failed} the run failed,
      ${EXIT.idle} idle (nothing running, or a start was refused).
      --json prints the card as the server returned it, instead of the one line said on stderr.`;

const WORKTREE_USAGE = `  reeve card worktree [<card>] [--remove] [--json]
      Print the card's worktree path, making one first if it has none — starting the repo's setup
      command in the background, as entering Planning would. With no card, the one whose worktree
      the current directory is in.
      --remove stops the dev server, runs the repo's teardown command, and deletes the directory,
      uncommitted work included; the branch stays.
      --json prints the server's answer instead of the bare path.`;

const PR_USAGE = `  reeve card pr [<card>] [--json]
      Push a Release card's branch and open its pull request, or push to the one already open. With
      no card, the one whose worktree the current directory is in.
      --json prints the server's answer instead of the bare URL.`;

const RESOLVE_CONFLICTS_USAGE = `  reeve card resolve-conflicts [<card>] [--json]
      Merge the base branch into a Release card's branch and push it. A clean merge pushes before
      this returns; a conflicted one starts a run of Claude's own to resolve it, and the push
      waits for that. With no card, the one whose worktree the current directory is in.
      --json prints the server's answer.`;

const MERGE_USAGE = `  reeve card merge [<card>] [--json]
      Merge a Release card's pull request on GitHub, as the board's Merge button does, and only when
      GitHub says it merges cleanly. With no card, the one whose worktree the current directory is
      in.
      --json prints the server's answer.`;

const SERVER_USAGE = `  reeve card server [<card>] [--stop] [--json]
      Start the repo's dev server in the card's worktree and print its URL; one already running is
      not an error, and its URL is the answer either way. With no card, the one whose worktree the
      current directory is in.
      --stop stops it instead.
      --json prints the server's answer instead of the bare URL.`;

const DIFF_USAGE = `  reeve card diff [<card>] [--stat] [--json]
      What the card has changed against the commit its worktree started from, committed or not —
      or the commit it landed as, once merged. With no card, the one whose worktree the current
      directory is in.
      --stat prints a summary of files and line counts instead of the diff itself.
      Without --json this is rebuilt from the parsed diff and reads like git's but has no index
      lines, so it will not always \`git apply\`; for that, run git in the worktree.
      --json prints the parsed diff the Diff tab reads, instead of the rendered text.`;

const COMMITS_USAGE = `  reeve card commits [<card>] [--json]
      The card's commits, newest first, the same list as the rail. With no card, the one whose
      worktree the current directory is in.
      --json prints the list as the server returned it.`;

const VERBS: Record<string, Command> = {
  show: { usage: SHOW_USAGE, run: show },
  run: { usage: RUN_USAGE, run },
  approve: { usage: APPROVE_USAGE, run: approve },
  reject: { usage: REJECT_USAGE, run: reject },
  questions: { usage: QUESTIONS_USAGE, run: questions },
  answer: { usage: ANSWER_USAGE, run: answer },
  reply: { usage: REPLY_USAGE, run: reply },
  permit: { usage: PERMIT_USAGE, run: permit },
  wait: { usage: WAIT_USAGE, run: wait },
  add,
  edit,
  criteria,
  note: noteCard,
  move,
  archive,
  restore,
  accept,
  dismiss,
  worktree: { usage: WORKTREE_USAGE, run: worktree },
  pr: { usage: PR_USAGE, run: pr },
  'resolve-conflicts': { usage: RESOLVE_CONFLICTS_USAGE, run: resolveConflicts },
  merge: { usage: MERGE_USAGE, run: merge },
  server: { usage: SERVER_USAGE, run: server },
  diff: { usage: DIFF_USAGE, run: diff },
  commits: { usage: COMMITS_USAGE, run: commits },
};

/** Every verb carries its own usage text, so the page is just all of them in a row. */
const CARD_USAGE = [
  'reeve card <verb>. <card>, exit status and where Reeve is found: see reeve --help.',
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
