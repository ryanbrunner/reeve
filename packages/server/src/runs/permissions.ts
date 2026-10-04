import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { HookCallback, PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { realOrSelf } from '../git/worktree.js';

/**
 * Answering the permission prompts nobody is there to answer.
 *
 * Every run asks for auto mode, so the SDK's classifier is the policy: it
 * approves what Claude Code's auto mode would approve and refuses the rest, in
 * any language's toolchain. A pinned model that doesn't take auto mode (see
 * `fitToModel` in runs/claude.ts) runs in the SDK's own default mode instead,
 * where this callback is still wired the same way and still only ever
 * refuses — just asked about more, since default mode escalates every edit
 * rather than only what its own classifier cannot decide. Stages used to
 * carry their own lists instead, and the lists were Node's: a Rust repo could
 * not build, and `ls | head` was refused everywhere. What a stage should and
 * should not do is now said in its prompt.
 *
 * What reaches this callback is what the classifier escalated rather than
 * decided, and the answer is always no. Nobody is watching to say yes, and a
 * host that answered allow would be `bypassPermissions` by another name, in
 * runs VIBES MODE starts with nobody near the board.
 *
 * The refusal is still worth writing ourselves, and card #22 is why. The SDK's
 * own says anything else requiring approval will fail too, and a run that reads
 * it generalises: a Testing run had three probes denied, announced "Bash is
 * blocked, so I'll check the work with Read/Grep only", then made five edits,
 * committed none of them and ran no tests. So a denial here names the call,
 * says plainly that it was only that call, and tells the run to find another
 * way and carry on — the behaviour no prompt could buy, since the SDK's text
 * is not ours to edit.
 */
export interface ToolDecision {
  toolName: string;
  input: Record<string, unknown>;
}

/** Deny, in words that keep the run going. See the header for why never allow. */
export function decideToolUse({ toolName, input }: ToolDecision): PermissionResult {
  const command = typeof input['command'] === 'string' ? input['command'].trim() : '';
  return {
    behavior: 'deny',
    message: toolName === 'Bash' && command ? bashDenial(command) : toolDenial(toolName, input),
  };
}

/**
 * The one thing auto mode cannot know: which file is this server's database.
 *
 * AGENTS.md runs every spike as `REEVE_DB=<scratch> npx tsx …`, and the
 * classifier rightly sees nothing wrong with that. Pointed at the live board,
 * though, the spike opens the database a second time, and a second process
 * opening it reaps the runs in flight — the one asking included. So this
 * refuses any Bash command that sets `REEVE_DB` to the running server's own
 * file, before the classifier is asked.
 *
 * A hook rather than a case in `decideToolUse`, because a command the
 * classifier approves never reaches the callback at all. And it records its
 * own refusals through `onDenied`: the SDK says a hook's denial is never sent
 * as a `permission_denied` event, so nothing else would put it on the card.
 */
export function liveDatabaseGuard(
  worktreePath: string,
  onDenied: (toolName: string, input: Record<string, unknown>, toolUseId: string) => void,
): HookCallback {
  return (hook, toolUseId) => {
    if (hook.hook_event_name !== 'PreToolUse') return Promise.resolve({});
    const input = isRecord(hook.tool_input) ? hook.tool_input : {};
    const command = typeof input['command'] === 'string' ? input['command'].trim() : '';
    const reason = scratchDbRefusal(command, worktreePath);
    if (!reason) return Promise.resolve({});
    onDenied(hook.tool_name, input, hook.tool_use_id ?? toolUseId ?? '');
    return Promise.resolve({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    });
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every `REEVE_DB=` the command sets, wherever it sets it: first, after a
 * `cd … &&`, behind `env` or `export`, or inside a `bash -c "…"`. Only the
 * leading one used to matter, because anything compound was refused on its
 * form alone. Nothing refuses it now, so the guard has to look further in.
 */
const ASSIGNMENT = /(?:^|[\s;&|(`"'])REEVE_DB=/g;

/**
 * The value after one `REEVE_DB=`, when it can be read exactly: wholly quoted,
 * or bare with no quote, backslash or expansion in it, and a bare `~` or `~/…`
 * expanded as the shell expands it after `=`. The comparison below is only as
 * good as this, so `…/reeve".db"`, `$HOME/…` or `~someone/…` is not guessed at.
 * Nor is a bare value a quote runs straight on from, even the one closing a
 * `bash -c "…"`: telling that from `/tmp/"reeve.db"` is more shell than this
 * should parse.
 */
const VALUE = /^("[^"\\$`]*"|'[^']*'|(?!~[^/\s])[^\s"'\\$`;&|()<>]+)(?=$|[\s;&|()<>])/;

/** Why the command may not run, or null when it names no live database. */
function scratchDbRefusal(command: string, worktreePath: string): string | null {
  // One answer for the whole command, not one per `REEVE_DB=`: a `cd` after an
  // `export`ed assignment moves where that assignment is actually read from
  // just as much as one before it does, since the shell keeps the variable
  // past the statement that set it. Computed once because it does not depend
  // on which assignment is being checked.
  const candidates = cwdCandidates(command, worktreePath);
  for (const m of command.matchAll(ASSIGNMENT)) {
    const value = VALUE.exec(command.slice(m.index + m[0].length))?.[1];
    if (!value) return unreadableDbDenial(command);
    const db = /^["']/.test(value) ? value.slice(1, -1) : value.replace(/^~(?=\/|$)/, homedir());
    // An absolute value reads the same wherever the shell happens to be, so
    // worktreePath — where every Bash call in a run actually starts — is the
    // only cwd that matters, and a `cd` this cannot follow is no reason to
    // refuse it. A relative one is only as good as the cwd it is read
    // against, and that is what `candidates` is working out.
    if (isAbsolute(db)) {
      if (isLiveDatabase(db, worktreePath)) return liveDbDenial(command);
      continue;
    }
    if (candidates === null) return unreadableDbDenial(command);
    if (candidates.some((cwd) => isLiveDatabase(db, cwd))) return liveDbDenial(command);
  }
  return null;
}

/**
 * Every directory a relative `REEVE_DB` anywhere in the command could really
 * be read against: `worktreePath` itself, always — a leading `cd` can fail,
 * or sit behind a `||` that never runs it, and the command then runs exactly
 * where it started — plus wherever a plain `cd <dir>` chain off the front,
 * connected by `&&` or `;`, actually lands when it does run.
 *
 * Null when this cannot vouch for that being the whole story: a `cd` whose
 * own target cannot be read as plainly as `VALUE` requires, a `cd -` or
 * `-`-prefixed target (the previous directory, which this has no way to
 * know), or a `cd`/`pushd`/`popd` anywhere else in the command once the
 * leading chain is accounted for — before the assignment, as `env FOO=bar
 * cd x` would read oddly but shells allow, or after it, as `export
 * REEVE_DB=x; cd dir; …` actually runs. Any of those make the real cwd a
 * guess, and a guess is not grounds to allow what a known cwd would deny.
 */
function cwdCandidates(command: string, worktreePath: string): string[] | null {
  let cwd = worktreePath;
  let pos = 0;
  for (;;) {
    const cd = /^\s*cd\s+/.exec(command.slice(pos));
    if (!cd) break;
    const afterCd = pos + cd[0].length;
    const value = VALUE.exec(command.slice(afterCd))?.[1];
    if (!value || value.startsWith('-')) return null;
    const dir = /^["']/.test(value) ? value.slice(1, -1) : value.replace(/^~(?=\/|$)/, homedir());
    cwd = resolve(cwd, dir);
    const afterValue = afterCd + value.length;
    const chain = /^\s*(?:&&|;)\s*/.exec(command.slice(afterValue));
    if (!chain) {
      pos = afterValue;
      break;
    }
    pos = afterValue + chain[0].length;
  }
  // The chain above only ever walks forward from a plain `cd` at its own
  // start; anything cd-like left outside it, before or after, is exactly the
  // shape of thing it cannot follow — refuse rather than guess what it did.
  if (/(?:^|[\s;&|(`"'])(?:cd|pushd|popd)\b/.test(command.slice(pos))) return null;
  return [worktreePath, cwd];
}

/**
 * The board this server is running on. Unset `REEVE_DB` is no risk of this:
 * a spike resolves its default from the worktree, not the main checkout.
 */
function isLiveDatabase(db: string, cwd: string): boolean {
  return samePath(resolve(cwd, db), resolve(config.dbFile));
}

function samePath(a: string, b: string): boolean {
  return realOrSelf(a) === realOrSelf(b);
}

function bashDenial(command: string): string {
  return [
    `Denied: \`${short(command)}\`.`,
    'Auto mode would not approve this one command, and nobody is watching this run to approve it by hand.',
    'Only this call was refused. Every other command and every other tool still works:',
    "find another way to do what this one was for — a narrower command, one that stays inside the worktree, or a",
    'different tool — and carry on. Running the same command again will be refused again.',
  ].join(' ');
}

function toolDenial(toolName: string, input: Record<string, unknown>): string {
  const what = Object.values(identifying(input))[0];
  return [
    `Denied: this ${toolName} call${what ? ` (\`${short(what)}\`)` : ''}.`,
    'Auto mode would not approve it, and nobody is watching this run to approve it by hand.',
    `Only this call was refused, not ${toolName} and not your other tools: find another way to do what it was for`,
    'and carry on.',
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

function unreadableDbDenial(command: string): string {
  return [
    `Denied: \`${short(command)}\`.`,
    `Reeve refuses any \`REEVE_DB\` that names the database its server is using (${config.dbFile}),`,
    'and it can only tell when the path is written out plainly: no `$`, no backslash, no quote part-way through.',
    'Name a scratch file directly — `REEVE_DB=/tmp/scratch.db` — and run the command again.',
  ].join(' ');
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
 * in `decideToolUse` or `liveDatabaseGuard`; `observe` catches the ones decided
 * before anyone asked us — auto mode's classifier turning a call down itself,
 * which is most of them. They do not overlap in practice, and are deduplicated
 * by tool_use_id in case a release makes them.
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
