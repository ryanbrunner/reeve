import { resolve } from 'node:path';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
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
 * Deny by default. The one thing that is allowed is a rewrite, not a widening:
 * see `withoutGitC`.
 */
export function decideToolUse({ toolName, input, allowedTools, worktreePath }: ToolDecision): PermissionResult {
  if (toolName !== 'Bash') {
    return { behavior: 'deny', message: toolDenial(toolName, allowedTools) };
  }

  const command = typeof input['command'] === 'string' ? input['command'].trim() : '';
  const prefixes = bashPrefixes(allowedTools);
  const plain = withoutGitC(command, worktreePath);
  if (plain && !COMPOUND.test(plain) && prefixes.some((p) => isCommand(plain, p))) {
    return { behavior: 'allow', updatedInput: { ...input, command: plain } };
  }
  return { behavior: 'deny', message: bashDenial(command, prefixes, worktreePath) };
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
    'This is about the form of that one command and nothing else: every command on the list above still runs,',
    'and the rest of your tools are untouched. Rewrite it and carry on.',
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
