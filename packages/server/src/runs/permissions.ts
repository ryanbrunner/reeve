import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { realOrSelf } from '../git/worktree.js';

/**
 * Answering the permission prompts nobody is there to answer.
 *
 * A stage's `allowedTools` is the policy, and the SDK applies it without help.
 * This is what happens to everything else — and it exists because of what the
 * SDK does instead. `permissionPrompts: 'none'` denies an unmatched call with a
 * message that says anything else requiring approval will fail too. That is
 * true of the session and false of the stage, and a run that reads it
 * generalises: on card #22 a Testing run had three probes denied — one subshell
 * and two `git -C <its own worktree>` forms — announced "Bash is blocked, so
 * I'll check the work with Read/Grep only", then made five edits, committed
 * none of them and ran no tests. `git commit` was on its list the whole time.
 *
 * So a denial here names the command, names the list, and says plainly that the
 * rest of the toolbox still works. The run rewrites it and carries on, which is
 * the behaviour we want and the one no prompt could buy: the SDK's own refusal
 * text is not ours to edit, and this is the only way to replace it.
 *
 * This is consulted second, never first. A bare `allowedTools` name auto-approves
 * the whole tool before the callback is reached — Read and Grep never arrive
 * here — and so does a prefix pattern the command matches outright. What is left
 * is the interesting part: the forms that slipped past the patterns. Verified by
 * spikes/permission-check.ts.
 */
export interface ToolDecision {
  toolName: string;
  input: Record<string, unknown>;
  /** The stage's list, exactly as the SDK was given it. */
  allowedTools: string[];
  worktreePath: string;
}

/**
 * Deny by default. Two things get through, and neither is a widening: the
 * `git -C` rewrite (see `withoutGitC`) and a scratch database for Reeve's own
 * spikes (see `withScratchDb`). Whatever is left after either still has to
 * match the stage's list.
 */
export function decideToolUse({ toolName, input, allowedTools, worktreePath }: ToolDecision): PermissionResult {
  if (toolName !== 'Bash') {
    return { behavior: 'deny', message: toolDenial(toolName, allowedTools) };
  }

  const command = typeof input['command'] === 'string' ? input['command'].trim() : '';
  const prefixes = bashPrefixes(allowedTools);
  const scratch = withScratchDb(command);
  if (scratch.db && isLiveDatabase(scratch.db, worktreePath)) {
    return { behavior: 'deny', message: liveDbDenial(command) };
  }
  const plain = withoutGitC(scratch.rest, worktreePath);
  // The assignment goes back on — unlike `-C`, it is the point of the command —
  // and is checked with the rest, so `REEVE_DB=$(…)` is refused like anything else.
  const run = scratch.assignment + (plain ?? '');
  if (plain && !COMPOUND.test(run) && prefixes.some((p) => isCommand(plain, p))) {
    return { behavior: 'allow', updatedInput: { ...input, command: run } };
  }
  return { behavior: 'deny', message: bashDenial(command, prefixes, worktreePath) };
}

/**
 * `REEVE_DB=/tmp/scratch.db npx tsx …` -> the assignment, and `npx tsx …` to
 * match against the list.
 *
 * AGENTS.md runs every spike this way, and several refuse to start without it,
 * because they move real cards on whatever board they are given. The CLI's
 * matcher knows nothing of `REEVE_DB`, so the form lands here — and on card
 * b419aadc a run had to set the variable inside a `node -e` and start `npx`
 * from there, which the list allowed all along and is far harder to read.
 *
 * Exactly one assignment, and only this name. It changes which file Reeve's own
 * code opens and nothing about what the command after it may do. `GIT_DIR`,
 * `NODE_OPTIONS` or `PATH` would each let an allowed prefix mean something the
 * list never said, which is why this is a name and not a pattern. A second
 * assignment is left in `rest`, where it matches no prefix and is denied.
 *
 * `db` has to be the path the shell will open, or the live-board check below is
 * comparing against something else. So only the forms whose value can be read
 * exactly are taken: wholly quoted, or bare with no quote or backslash in it,
 * and a bare `~` or `~/…` expanded as the shell expands it after `=`.
 * `REEVE_DB=…/reeve".db"` or `~someone/…` is left in `rest` and denied with
 * the rest of what this does not reason about.
 */
function withScratchDb(command: string): { assignment: string; db: string | null; rest: string } {
  const m = /^REEVE_DB=("[^"\\]*"|'[^']*'|(?!~[^/\s])[^\s"'\\]+)\s+(.+)$/s.exec(command);
  if (!m) return { assignment: '', db: null, rest: command };
  const value = m[1]!;
  const db = /^["']/.test(value) ? value.slice(1, -1) : value.replace(/^~(?=\/|$)/, homedir());
  return { assignment: `REEVE_DB=${value} `, db, rest: m[2]! };
}

/**
 * The board this server is running on. A spike pointed at it would open the
 * database a second time, and a second process opening it reaps the runs in
 * flight — the one asking included. Unset `REEVE_DB` is no risk of this: the
 * spike resolves its default from the worktree, not the main checkout.
 */
function isLiveDatabase(db: string, worktreePath: string): boolean {
  return samePath(resolve(worktreePath, db), resolve(config.dbFile));
}

/**
 * `git -C <the worktree> log …` -> `git log …`.
 *
 * Runs reach for this form constantly, and Claude Code's own guidance is what
 * teaches it: prefer an absolute path to a `cd`. In a stage run it is pure
 * noise — the run's cwd already IS the worktree — so the rewrite allows exactly
 * the command the stage allowed, in the spelling it allowed, and nothing new
 * becomes possible. Returns the command unchanged when there is no `-C`.
 *
 * Only the worktree root itself, never a directory inside it: `git status` run
 * one level down means something else as soon as a relative pathspec is
 * involved, and silently moving it would be worse than a denial.
 */
function withoutGitC(command: string, worktreePath: string): string | null {
  const m = /^git\s+-C\s+("[^"]*"|'[^']*'|\S+)\s+(.+)$/s.exec(command);
  if (!m) return command;
  const at = m[1]!.replace(/^["']|["']$/g, '');
  return samePath(resolve(worktreePath, at), worktreePath) ? `git ${m[2]!}` : null;
}

function samePath(a: string, b: string): boolean {
  return realOrSelf(a) === realOrSelf(b);
}

/**
 * Shell we will not reason about, so that matching a prefix can never mean less
 * than it says: `git log --oneline $(curl …)` starts with `git log` and is not a
 * `git log`. A command carrying any of this is denied rather than rewritten —
 * the CLI's own matcher has already had its turn at the compound forms it does
 * understand, and second-guessing it here would be the one mistake that matters.
 */
const COMPOUND = /[$`;&|<>()\n]/;

/** The command prefixes in a stage's list: `Bash(git log *)` -> `git log`. */
function bashPrefixes(allowedTools: string[]): string[] {
  return allowedTools.flatMap((t) => {
    const m = /^Bash\(([^)]*)\)$/.exec(t);
    return m ? [m[1]!.replace(/\*$/, '').trim()] : [];
  });
}

/** Word-boundary prefix match, so `git logs-everything` is not `git log`. */
function isCommand(command: string, prefix: string): boolean {
  return command === prefix || command.startsWith(`${prefix} `);
}

function bashDenial(command: string, prefixes: string[], worktreePath: string): string {
  return [
    `Denied: \`${short(command)}\`.`,
    prefixes.length
      ? `This stage's shell is limited to these commands: ${prefixes.join(', ')}.`
      : 'This stage has no shell at all.',
    `Run one of them as a single plain command — you are already in ${worktreePath}, so no \`cd\` and no \`git -C\`,`,
    'and nothing wrapped in a loop, a subshell or a command substitution.',
    'The one variable it may start with is `REEVE_DB=<scratch path>`, for Reeve\'s own spikes.',
    'This is about the form of that one command and nothing else: every command on the list above still runs,',
    'and the rest of your tools are untouched. Rewrite it and carry on.',
  ].join(' ');
}

function liveDbDenial(command: string): string {
  return [
    `Denied: \`${short(command)}\`.`,
    `\`REEVE_DB\` there is the database the Reeve server running this stage is using (${config.dbFile}),`,
    'and opening it from a second process reaps the runs in flight, this one included.',
    'Point it at a scratch file instead — a fresh path under /tmp — and run the same command again.',
  ].join(' ');
}

function toolDenial(toolName: string, allowedTools: string[]): string {
  const named = allowedTools.filter((t) => !t.startsWith('Bash('));
  return (
    `Denied: this stage has no ${toolName}. What it has: ${named.length ? named.join(', ') : 'no tools but Bash'}` +
    `${bashPrefixes(allowedTools).length ? ', plus a scoped shell' : ''}. Those all work — use them and carry on.`
  );
}

/** Enough of the command to recognise it, on one line. Commit messages are long. */
function short(command: string): string {
  const oneLine = command.replace(/\s+/g, ' ').trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine;
}

// ---------------------------------------------------------------------------
// Keeping the record
// ---------------------------------------------------------------------------

/**
 * One refused call, in the shape `result.permission_denials` uses.
 *
 * Kept deliberately compatible: a row's denials come from the result message
 * where there is one and from here where there is not, and nothing downstream
 * should be able to tell which.
 */
export interface ToolDenialRecord {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, string>;
}

/**
 * The denials a run accumulates as it goes.
 *
 * `result.permission_denials` is the authoritative record and the one to prefer
 * — but it arrives with the result message, and a run that is interrupted or
 * aborted never gets one. Those are precisely the runs worth asking what was
 * refused.
 *
 * Two ways in, because there are two kinds of refusal. `refused` is ours, made
 * in `decideToolUse`; `observe` catches the ones decided before anyone asked us
 * — a permission mode that forbids tools outright, which is how Planning works.
 * They do not overlap in practice, and are deduplicated by tool_use_id in case
 * a release makes them.
 */
export interface DenialRecorder {
  /** A denial this host just made. Returns the list when it grew, else null. */
  refused(toolName: string, input: Record<string, unknown>, toolUseId: string): ToolDenialRecord[] | null;
  /** A denial the CLI made without asking. Same return. */
  observe(message: SDKMessage): ToolDenialRecord[] | null;
}

export function denialRecorder(): DenialRecorder {
  // Only the latest turn's calls, for `observe`: the denial event names the tool
  // and the id but carries no input, and it lands while the message that asked
  // is still executing, so it is always this map the id is in. Holding every
  // call of a 200-turn run to caption a denial that may never come is not a
  // trade worth making.
  let asked = new Map<string, ToolDenialRecord>();
  const denied: ToolDenialRecord[] = [];
  const seen = new Set<string>();

  const add = (record: ToolDenialRecord): ToolDenialRecord[] | null => {
    if (record.tool_use_id && seen.has(record.tool_use_id)) return null;
    if (record.tool_use_id) seen.add(record.tool_use_id);
    denied.push(record);
    return [...denied];
  };

  return {
    refused(toolName, input, toolUseId) {
      return add({ tool_name: toolName, tool_use_id: toolUseId, tool_input: identifying(input) });
    },
    observe(message) {
      if (message.type === 'assistant') {
        asked = asksIn(message);
        return null;
      }
      const m = message as { type?: string; subtype?: string; tool_name?: string; tool_use_id?: string };
      if (m.type !== 'system' || m.subtype !== 'permission_denied') return null;
      const id = m.tool_use_id ?? '';
      return add(asked.get(id) ?? { tool_name: m.tool_name ?? 'a tool', tool_use_id: id, tool_input: {} });
    },
  };
}

/** The tool calls in one assistant message, by id. */
function asksIn(message: SDKMessage): Map<string, ToolDenialRecord> {
  const asked = new Map<string, ToolDenialRecord>();
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return asked;
  for (const block of content as Array<{ type?: string; id?: string; name?: string; input?: Record<string, unknown> }>) {
    if (block.type !== 'tool_use' || !block.id || !block.name) continue;
    asked.set(block.id, { tool_name: block.name, tool_use_id: block.id, tool_input: identifying(block.input ?? {}) });
  }
  return asked;
}

/**
 * Which call it was, and nothing more. Only the fields that identify one, and
 * only the head of them: a `Write` input is a whole file, and this is stored on
 * the run row and sent to the browser.
 */
function identifying(input: Record<string, unknown>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) kept[key] = value.slice(0, 200);
  }
  return kept;
}
