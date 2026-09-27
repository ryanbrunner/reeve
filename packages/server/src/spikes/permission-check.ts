/**
 * Throwaway check on runs/permissions.ts: the decisions it makes, and — the
 * half that cannot be unit-tested — whether the SDK consults it at all now that
 * `permissionPrompts: 'none'` is gone.
 *
 * The second half is the one that matters. If `canUseTool` is never called, an
 * unmatched tool call parks the run forever instead of being denied, and every
 * stage hangs on its first stray command.
 */
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { config } from '../config.js';
import { decideToolUse, denialRecorder, type ToolDenialRecord } from '../runs/permissions.js';
import { GIT_READ, NODE_TOOLING } from '../stages/tools.js';

const note = (l: string, v: unknown) => console.log(`${l.padEnd(34)}: ${v}`);
let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const wt = mkdtempSync(join(tmpdir(), 'reeve-perm-'));
const g = (...a: string[]) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8' });
g('init', '-q', '-b', 'main');
g('config', 'user.email', 't@t.t'); g('config', 'user.name', 'T');
writeFileSync(join(wt, 'README.md'), '# base\n');
g('add', '-A'); g('commit', '-qm', 'base');
writeFileSync(join(wt, 'dirty.txt'), 'uncommitted\n');

const allowedTools = ['Read', 'Glob', 'Grep', ...GIT_READ];
const decide = (command: string) => decideToolUse({ toolName: 'Bash', input: { command }, allowedTools, worktreePath: wt });

console.log('--- the policy ---');
const rewritten = decide(`git -C ${wt} status --short`);
check(
  'git -C <worktree> allowed, rewritten',
  rewritten.behavior === 'allow' && rewritten.updatedInput?.['command'] === 'git status --short',
  JSON.stringify(rewritten.behavior === 'allow' ? rewritten.updatedInput?.['command'] : rewritten.message?.slice(0, 40)),
);
check('git -C . allowed too', decide('git -C . log --oneline').behavior === 'allow');
// The same directory on a disk that ignores case, so the same rewrite.
if (existsSync(wt.toUpperCase())) {
  const recased = decide(`git -C ${wt.toUpperCase()} status`);
  check(
    'git -C <worktree, re-cased> rewritten',
    recased.behavior === 'allow' && recased.updatedInput?.['command'] === 'git status',
  );
}
check('a subdirectory is refused', decide(`git -C ${join(wt, 'packages')} log`).behavior === 'deny');
check('somewhere else is refused', decide('git -C /etc log').behavior === 'deny');
check('plain allowed command allowed', decide('git log --oneline -5').behavior === 'allow');
check('command substitution refused', decide('git log --oneline $(whoami)').behavior === 'deny');
check('a second command refused', decide('git log --oneline && rm -rf /').behavior === 'deny');
check('git push refused', decide('git push origin main').behavior === 'deny');
check('gh refused', decide('gh pr view 1').behavior === 'deny');
check(
  'not a prefix by accident',
  decide('git logs-everything --now').behavior === 'deny',
  'git log is a command, not a string',
);

const denial = decide('gh pr view 1');
const message = denial.behavior === 'deny' ? denial.message : '';
check('denial names the command', message.includes('gh pr view 1'));
check('denial names the list', message.includes('git status') && message.includes('git rev-parse'));
check('denial says the rest still works', message.includes('still runs'));
check('denial says where the run already is', message.includes(wt));
note('denial text', message);

console.log('\n--- a scratch database ---');
// In Progress's shell, which is where spikes are run from.
const withNode = [...allowedTools, ...NODE_TOOLING];
const decideNode = (command: string) =>
  decideToolUse({ toolName: 'Bash', input: { command }, allowedTools: withNode, worktreePath: wt });
const spike = 'REEVE_DB=/tmp/scratch.db npx tsx packages/server/src/spikes/vibes-check.ts';
const scratch = decideNode(spike);
check(
  'REEVE_DB=… npx allowed, assignment kept',
  scratch.behavior === 'allow' && scratch.updatedInput?.['command'] === spike,
  JSON.stringify(scratch.behavior === 'allow' ? scratch.updatedInput?.['command'] : scratch.message?.slice(0, 60)),
);
check('quoted value allowed', decideNode(`REEVE_DB="/tmp/a b.db" npx tsx x.ts`).behavior === 'allow');
const scratchC = decideNode(`REEVE_DB=/tmp/s.db git -C ${wt} status`);
check(
  'combines with the -C rewrite',
  scratchC.behavior === 'allow' && scratchC.updatedInput?.['command'] === 'REEVE_DB=/tmp/s.db git status',
);
check('a stage without npx still refuses it', decide(spike).behavior === 'deny');
check('another variable refused', decideNode('NODE_OPTIONS=--require=/tmp/x.js npx tsx x.ts').behavior === 'deny');
check('GIT_DIR refused', decideNode('GIT_DIR=/elsewhere/.git git status').behavior === 'deny');
check('a second assignment refused', decideNode('REEVE_DB=/tmp/s.db REEVE_PORT=4399 npx tsx x.ts').behavior === 'deny');
check('substitution in the value refused', decideNode('REEVE_DB=$(mktemp) npx tsx x.ts').behavior === 'deny');
check('an assignment and no command refused', decideNode('REEVE_DB=/tmp/s.db').behavior === 'deny');
check('still has to match the list', decideNode('REEVE_DB=/tmp/s.db gh pr view 1').behavior === 'deny');
const live = decideNode(`REEVE_DB=${config.dbFile} npx tsx x.ts`);
check(
  'the live board refused, by name',
  live.behavior === 'deny' && live.message.includes('reaps'),
  live.behavior === 'deny' ? live.message.slice(0, 80) : 'allowed',
);
// The shell expands these into the live board too, so the check has to see through them.
if (config.dbFile.startsWith(`${homedir()}/`)) {
  const tilde = decideNode(`REEVE_DB=~${config.dbFile.slice(homedir().length)} npx tsx x.ts`);
  check('the live board by ~ refused', tilde.behavior === 'deny' && tilde.message.includes('reaps'));
}
const [dir, file] = [dirname(config.dbFile), basename(config.dbFile)];
// So do these, on a disk that ignores case, which is macOS's default. Only
// where the re-cased path exists: on a case-sensitive disk, or with no database
// at REEVE_DB yet, it names another file, and allowing it is right.
for (const [name, recased] of [
  ['the live board re-cased refused', `${dir}/${file.toUpperCase()}`],
  ['the live board by a re-cased directory refused', `${dir.toUpperCase()}/${file}`],
] as const) {
  if (!existsSync(recased)) {
    note(name, `skipped: nothing at ${recased}`);
    continue;
  }
  const decision = decideNode(`REEVE_DB=${recased} npx tsx x.ts`);
  check(name, decision.behavior === 'deny' && decision.message.includes('reaps'), decision.behavior);
}
check('~ inside quotes is literal', decideNode(`REEVE_DB="~/s.db" npx tsx x.ts`).behavior === 'allow');
check('a partly quoted value refused', decideNode(`REEVE_DB=${dir}/"${file}" npx tsx x.ts`).behavior === 'deny');
check('a backslash in the value refused', decideNode(`REEVE_DB=${dir}/\\${file} npx tsx x.ts`).behavior === 'deny');
check('~someone refused', decideNode('REEVE_DB=~root/s.db npx tsx x.ts').behavior === 'deny');

const notBash = decideToolUse({ toolName: 'WebFetch', input: { url: 'https://example.com' }, allowedTools, worktreePath: wt });
check('a tool it has no business with', notBash.behavior === 'deny' && notBash.message.includes('Read, Glob, Grep'));

/**
 * The decisive half. Three commands: one the policy rewrites into an allow, one
 * it refuses, and one — a pipe — that must never reach the policy at all.
 *
 * That third one is the regression to watch. A piped read-only command is
 * approved by the CLI's own subcommand matching, and runs lean on the form
 * constantly. If installing a callback started routing pipes here instead, the
 * policy would refuse every one of them, which would be a worse break than the
 * one it was written to fix.
 */
console.log('\n--- does the SDK ask us? ---');
async function* once(text: string): AsyncIterable<SDKUserMessage> {
  yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: text } };
}

const asks: string[] = [];
const commands: string[] = [];
const results: string[] = [];
let denials: unknown[] = [];
// What an interrupted run would have on its row: the result message never
// arrives for one, so the record has to be built as the denials happen.
const recorder = denialRecorder();
let recorded: ToolDenialRecord[] = [];
for await (const m of query({
  prompt: once(
    `Do exactly this, one Bash call each, in order, and do not stop early:\n` +
    `1. \`git -C ${wt} status --short\`\n2. \`gh pr view 1\`\n3. \`git log --oneline | head -3\`\n` +
    `Then say in one sentence what happened to each.`,
  ),
  options: {
    cwd: wt,
    model: 'claude-sonnet-5',
    permissionMode: 'acceptEdits',
    allowedTools,
    maxTurns: 12,
    canUseTool: (toolName, input, { toolUseID }) => {
      asks.push(typeof input['command'] === 'string' ? input['command'] : toolName);
      const decision = decideToolUse({ toolName, input, allowedTools, worktreePath: wt });
      if (decision.behavior === 'deny') recorded = recorder.refused(toolName, input, toolUseID) ?? recorded;
      return Promise.resolve(decision);
    },
  },
})) {
  const msg = m as SDKMessage & { message?: { content?: unknown }; permission_denials?: unknown[] };
  recorded = recorder.observe(m) ?? recorded;
  if (m.type === 'assistant' && Array.isArray(msg.message?.content)) {
    for (const b of msg.message.content as Array<{ type?: string; name?: string; input?: { command?: string } }>) {
      if (b.type === 'tool_use' && b.name === 'Bash' && b.input?.command) commands.push(b.input.command);
    }
  }
  if (m.type === 'user' && Array.isArray(msg.message?.content)) {
    for (const b of msg.message.content as Array<{ type?: string; content?: unknown }>) {
      if (b.type === 'tool_result') results.push(JSON.stringify(b.content).slice(0, 160));
    }
  }
  if (m.type === 'result') denials = msg.permission_denials ?? [];
}

note('canUseTool was asked about', JSON.stringify(asks));
note('commands attempted', JSON.stringify(commands));
for (const r of results) note('tool result', r);
note('permission_denials', JSON.stringify(denials).slice(0, 300));

check('canUseTool was consulted', asks.length > 0, 'if this fails, runs park instead of being denied');
check(
  'a pipe never reaches the policy',
  !asks.some((c) => c.includes('|')),
  'the CLI approves piped read-only commands itself, and must go on doing so',
);
check('the piped command ran', results.some((r) => r.includes('base')));
check(
  'the -C form reached the policy',
  asks.some((c) => c.startsWith('git -C ')),
  'if the CLI allowed it outright, the rewrite is not what made it run',
);
check('and ran, rewritten', results.some((r) => r.includes('dirty.txt')));
check('the refused one was refused', results.some((r) => r.includes('Denied')));
check('denials are on the result', denials.length > 0, 'this is what the Activity tab counts');
check(
  'and on the row without one, in the same shape',
  recorded.length === denials.length && recorded[0]?.tool_input['command'] === 'gh pr view 1',
  JSON.stringify(recorded),
);

console.log(`\n--- ${failures === 0 ? 'all good' : `${failures} FAILED`} ---`);
