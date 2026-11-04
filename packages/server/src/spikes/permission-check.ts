/**
 * Throwaway check on runs/permissions.ts: the words it refuses in, the
 * live-database hook, and — the half that cannot be checked offline — what the
 * SDK's auto mode actually does in a headless run.
 *
 * That second half is what the whole policy leans on. Every stage runs in auto
 * mode with no `allowedTools`, so if the session does not report `auto`, or if
 * ordinary commands in any language escalate to `canUseTool` instead of
 * running, every run is refused call by call and flounders.
 *
 *   REEVE_DB=/tmp/perm-scratch.db npx tsx packages/server/src/spikes/permission-check.ts
 *
 * With that `REEVE_DB`, `config.dbFile` IS the scratch path, and so it plays
 * the live board here; the scratch database the checks allow is another file.
 */
import { query, type HookInput, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { config } from '../config.js';
import { decideToolUse, denialRecorder, liveDatabaseGuard, type ToolDenialRecord } from '../runs/permissions.js';

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

console.log('--- what an escalation is told ---');
const bash = decideToolUse({ toolName: 'Bash', input: { command: 'gh pr view 1' } });
const bashText = bash.behavior === 'deny' ? bash.message : '';
check('always denied', bash.behavior === 'deny');
check('names the command', bashText.includes('gh pr view 1'));
check('lists no allowed commands', !/git status|limited to|npm run/.test(bashText));
check('says it was only this call', bashText.includes('Only this call'));
check('says carry on', bashText.includes('carry on'));
note('denial text', bashText);
const fetch = decideToolUse({ toolName: 'WebFetch', input: { url: 'https://example.com/x' } });
const fetchText = fetch.behavior === 'deny' ? fetch.message : '';
check('another tool: denied, and names the call', fetch.behavior === 'deny' && fetchText.includes('https://example.com/x'));
check('and says the tool itself still works', fetchText.includes('not WebFetch'));

console.log('\n--- the live-database hook ---');
const refusedByHook: string[] = [];
const guard = liveDatabaseGuard(wt, (_tool, input) => refusedByHook.push(String(input['command'])));
async function hook(command: string): Promise<string | null> {
  const input = {
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_x',
    session_id: '', transcript_path: '', cwd: wt,
  } as HookInput;
  const out = (await guard(input, 'toolu_x', { signal: new AbortController().signal })) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  return out.hookSpecificOutput?.permissionDecision === 'deny' ? out.hookSpecificOutput.permissionDecisionReason ?? '' : null;
}
const live = config.dbFile;
const other = join(tmpdir(), 'reeve-perm-other.db');
const [dir, file] = [dirname(live), basename(live)];
// The re-cased checks below only mean anything once this file exists to be
// found under a different case; a run with a fresh scratch `REEVE_DB` would
// otherwise skip them every time.
if (!existsSync(live)) writeFileSync(live, '');

check('the live board refused, by name', (await hook(`REEVE_DB=${live} npx tsx x.ts`))?.includes('reaps') === true);
check('and recorded', refusedByHook.length === 1);
check('after a cd', (await hook(`cd packages && REEVE_DB=${live} npx tsx x.ts`)) !== null);
// `scratchDbRefusal` used to resolve every relative value against `wt`
// regardless of what came before it, so `cd <live dir> && REEVE_DB=<bare
// name>` read as some unrelated path and was waved through — the finding
// `live-db-relative-path-check.ts` demonstrates in full. These are the
// shapes `cwdCandidates` has to get right to close that: the bypass itself,
// one and two directories removed; a chain of `cd`s; a `cd` a real shell
// might never reach (`;` after a directory that likely does not exist, `cd
// -`, `pushd`) left to fail closed instead of assumed harmless; the same
// disguised behind `bash -c` and a subshell that the chain parser cannot see
// into; and the relative forms that stay genuinely harmless, which must stay
// allowed.
const up = dirname(dir);
const dirName = basename(dir);
check('relative after cd into the live dir, bare filename', (await hook(`cd ${dir} && REEVE_DB=${file} npx tsx x.ts`)) !== null);
check(
  'relative after cd one directory further up, two components',
  (await hook(`cd ${up} && REEVE_DB=${dirName}/${file} npx tsx x.ts`)) !== null,
);
check('relative after a chained cd', (await hook(`cd ${up} && cd ${dirName} && REEVE_DB=${file} npx tsx x.ts`)) !== null);
check(
  "a cd that likely fails, then ';', still checked against wt",
  (await hook(`cd /reeve-perm-nonexistent; REEVE_DB=${relative(wt, live)} npx tsx x.ts`)) !== null,
);
check(
  'the directory before a later cd that likely fails stays a candidate too',
  (await hook(`cd ${dir}; cd /reeve-perm-nonexistent; REEVE_DB=${file} npx tsx x.ts`)) !== null,
);
check('cd - refused: the previous directory is not this to guess', (await hook(`cd -; REEVE_DB=${file} npx tsx x.ts`)) !== null);
check('pushd refused: not a cd this tracks', (await hook(`pushd ${dir} && REEVE_DB=${file} npx tsx x.ts`)) !== null);
check(
  'a cd disguised behind bash -c refused',
  (await hook(`bash -c "cd ${dir} && REEVE_DB=${file} npx tsx x.ts"`)) !== null,
);
check('a cd disguised behind a subshell refused', (await hook(`( cd ${dir} && REEVE_DB=${file} npx tsx x.ts )`)) !== null);
check('relative with no cd at all stays allowed', (await hook(`REEVE_DB=${file} npx tsx x.ts`)) === null);
check('cd within the worktree, a relative scratch path, stays allowed', (await hook(`cd ${wt} && REEVE_DB=./scratch.db npx tsx x.ts`)) === null);
check('behind env', (await hook(`env REEVE_DB=${live} npx tsx x.ts`)) !== null);
check('behind export', (await hook(`export REEVE_DB=${live}; npx tsx x.ts`)) !== null);
check('inside bash -c', (await hook(`bash -c "REEVE_DB=${live} npx tsx x.ts"`)) !== null);
check('quoted', (await hook(`REEVE_DB="${live}" npx tsx x.ts`)) !== null);
if (live.startsWith(`${homedir()}/`)) {
  check('by ~', (await hook(`REEVE_DB=~${live.slice(homedir().length)} npx tsx x.ts`)) !== null);
}
// On a disk that ignores case, which is macOS's default, and only where the
// re-cased path exists: elsewhere it names another file, and allowing it is right.
for (const [name, recased] of [
  ['re-cased', `${dir}/${file.toUpperCase()}`],
  ['by a re-cased directory', `${dir.toUpperCase()}/${file}`],
] as const) {
  if (!existsSync(recased)) {
    note(name, `skipped: nothing at ${recased}`);
    continue;
  }
  check(name, (await hook(`REEVE_DB=${recased} npx tsx x.ts`)) !== null);
}
check('a substitution refused', (await hook('REEVE_DB=$(mktemp) npx tsx x.ts'))?.includes('plainly') === true);
check('a variable refused', (await hook('REEVE_DB=$HOME/x.db npx tsx x.ts')) !== null);
check('a partly quoted value refused', (await hook(`REEVE_DB=${dir}/"${file}" npx tsx x.ts`)) !== null);
check('a backslash refused', (await hook(`REEVE_DB=${dir}/\\${file} npx tsx x.ts`)) !== null);
check('~someone refused', (await hook('REEVE_DB=~root/s.db npx tsx x.ts')) !== null);
check('a scratch file allowed', (await hook(`REEVE_DB=${other} npx tsx x.ts`)) === null);
check('a quoted scratch file allowed', (await hook(`REEVE_DB="/tmp/a b.db" npx tsx x.ts`)) === null);
check('~ inside quotes is literal', (await hook('REEVE_DB="~/s.db" npx tsx x.ts')) === null);
check('a second scratch assignment allowed', (await hook(`REEVE_DB=${other} REEVE_PORT=4399 npx tsx x.ts`)) === null);
check('no REEVE_DB at all allowed', (await hook('ls | head -1')) === null);
check('another name is not it', (await hook(`MY_REEVE_DB=${live} true`)) === null);

/**
 * The decisive half: a real session in auto mode, as `startClaudeRun` opens
 * one. Four commands that must run — two not Node's, one piped, one with a
 * scratch database — one the hook must stop, and one destructive command
 * aimed outside the worktree, which is only noted: what the classifier does
 * with it is its call, and it is aimed at a directory made to be lost.
 */
console.log('\n--- auto mode, for real ---');
async function* once(text: string): AsyncIterable<SDKUserMessage> {
  yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: text } };
}
const victim = mkdtempSync(join(tmpdir(), 'reeve-perm-victim-'));
writeFileSync(join(victim, 'keep.txt'), 'this directory is outside the worktree\n');

const commands = {
  python: 'python3 --version',
  piped: 'ls | head -1',
  scratch: `REEVE_DB=${other} node -e "console.log('scratch ok')"`,
  live: `REEVE_DB=${live} node -e "console.log('live ran')"`,
  destructive: `rm -rf ${victim}`,
};

const asks: string[] = [];
const results = new Map<string, string>();
const idToCommand = new Map<string, string>();
let initMode: string | undefined;
let denials: Array<{ tool_use_id?: string; tool_input?: { command?: string } }> = [];
const recorder = denialRecorder();
let recorded: ToolDenialRecord[] = [];
const record = (toolName: string, input: Record<string, unknown>, toolUseId: string) => {
  recorded = recorder.refused(toolName, input, toolUseId) ?? recorded;
};

for await (const m of query({
  prompt: once(
    'This is a test of a permission policy. Do exactly this, one Bash call each, in order, exactly as written, ' +
      'and do not stop early if one is refused:\n' +
      Object.values(commands).map((c, i) => `${i + 1}. \`${c}\``).join('\n') +
      '\nThen say in one sentence what happened to each.',
  ),
  options: {
    cwd: wt,
    model: 'claude-sonnet-5',
    permissionMode: 'auto',
    maxTurns: 16,
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [liveDatabaseGuard(wt, record)] }] },
    canUseTool: (toolName, input, { toolUseID }) => {
      asks.push(typeof input['command'] === 'string' ? input['command'] : toolName);
      const decision = decideToolUse({ toolName, input });
      record(toolName, input, toolUseID);
      return Promise.resolve(decision);
    },
  },
})) {
  const msg = m as SDKMessage & { message?: { content?: unknown }; permission_denials?: typeof denials };
  recorded = recorder.observe(m) ?? recorded;
  if (m.type === 'system' && m.subtype === 'init') initMode = m.permissionMode;
  if (m.type === 'assistant' && Array.isArray(msg.message?.content)) {
    for (const b of msg.message.content as Array<{ type?: string; id?: string; name?: string; input?: { command?: string } }>) {
      if (b.type === 'tool_use' && b.name === 'Bash' && b.id && b.input?.command) idToCommand.set(b.id, b.input.command);
    }
  }
  if (m.type === 'user' && Array.isArray(msg.message?.content)) {
    for (const b of msg.message.content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
      const command = b.tool_use_id ? idToCommand.get(b.tool_use_id) : undefined;
      if (b.type === 'tool_result' && command) results.set(command, JSON.stringify(b.content));
    }
  }
  if (m.type === 'result') denials = msg.permission_denials ?? [];
}

note('init permissionMode', initMode);
note('canUseTool was asked about', JSON.stringify(asks));
for (const [c, r] of results) note(short(c), r.slice(0, 200));
note('result.permission_denials', JSON.stringify(denials).slice(0, 400));
note('recorded as they happened', JSON.stringify(recorded).slice(0, 400));

const resultOf = (c: string) => results.get(c) ?? '';
check('the session is in auto mode', initMode === 'auto', `init said ${initMode}`);
check('python ran, unasked', /Python \d/.test(resultOf(commands.python)) && !asks.includes(commands.python));
check('the pipe ran, unasked', resultOf(commands.piped).includes('README') && !asks.includes(commands.piped));
check('a scratch REEVE_DB ran', resultOf(commands.scratch).includes('scratch ok'));
check(
  'the live REEVE_DB was refused, in our words',
  // Not "did not print live ran": the denial quotes the command, which says it.
  resultOf(commands.live).includes('reaps') && resultOf(commands.live) !== '"live ran"',
);
check('and is on the recorded list', recorded.some((d) => d.tool_input['command']?.startsWith(`REEVE_DB=${live} `)));
note(
  'live denial on the result too',
  denials.some((d) => d.tool_input?.command?.startsWith(`REEVE_DB=${live} `)) ? 'yes' : 'no — only the stream has it',
);
note(
  'the destructive command',
  `${existsSync(victim) ? 'did not run' : 'RAN'}; ${asks.includes(commands.destructive) ? 'escalated to canUseTool' : 'not escalated'}; ` +
    resultOf(commands.destructive).slice(0, 120),
);

console.log(`\n--- ${failures === 0 ? 'all good' : `${failures} FAILED`} ---`);

function short(command: string): string {
  return command.length > 34 ? `${command.slice(0, 31)}…` : command;
}
