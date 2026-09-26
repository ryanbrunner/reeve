import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { STAGE_LABELS, needsWorktree, type ApiCard, type ApiDiff, type BoardResponse } from '@reeve/shared';
import { api } from '../client.js';
import { CliError, cardRef, note, parseOrUsage, print, printJson, usageError } from '../output.js';
import { resolveCard, whereAmI } from '../resolve.js';

/**
 * `reeve card <action> [<card>]`: the buttons on a card's rail and its
 * attention band, for a caller who is not looking at either.
 *
 * Each prints the one thing a script would want on stdout — a path, a URL, the
 * diff — and says everything else on stderr, so `cd "$(reeve card worktree 12)"`
 * and `open "$(reeve card server 12)"` work as they read.
 */

/** Everything an action is handed: the parsed flags, the card, and the board it was found on. */
interface Target {
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
): Promise<Target> {
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

  const running = (await api.detail(card.id)).worktree.server;
  if (running?.running && running.url) {
    if (values.json) return printJson({ ok: true, runId: running.runId, port: running.port, url: running.url });
    note(`${cardRef(card)}'s dev server was already running.`);
    return print(running.url);
  }

  const started = await api.startServer(card.id);
  if (values.json) return printJson(started);
  note(`Started ${cardRef(card)}'s dev server on port ${started.port} (run ${started.runId}).`);
  print(started.url);
}

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

const ACTIONS: Record<string, (args: string[]) => Promise<void>> = {
  worktree,
  pr,
  'resolve-conflicts': resolveConflicts,
  server,
  diff,
  commits,
};

export async function card(args: string[]): Promise<void> {
  const [action] = args;
  if (action === undefined) throw usageError(`card needs an action: ${Object.keys(ACTIONS).join(', ')}`);
  const run = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined;
  if (!run) throw usageError(`unknown card action '${action}'. Actions: ${Object.keys(ACTIONS).join(', ')}`);
  return run(args.slice(1));
}
