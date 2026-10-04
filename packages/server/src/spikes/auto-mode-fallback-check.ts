/**
 * Throwaway check on the fallback `fitToModel` now takes instead of refusing
 * a run outright: a pinned model the CLI says has `supportsAutoMode: false`
 * should still run, just without `permissionMode: 'auto'` asked for, and
 * `canUseTool` should still deny everything that reaches it exactly as it
 * does in a normal auto-mode run.
 *
 * No model the CLI lists today actually reports `supportsAutoMode: false`
 * (see `model-check.ts`), so the first half stubs `capabilitiesFor` through
 * `fitToModel`'s injectable lookup — see its comment in runs/claude.ts. The
 * second half is the one thing that lookup cannot stand in for: what the SDK
 * itself does once `permissionMode` is left out, which is the risk the card
 * flagged. That part spends real API credit, the same as permission-check.ts.
 *
 *   REEVE_DB=/tmp/auto-mode-scratch.db npx tsx packages/server/src/spikes/auto-mode-fallback-check.ts
 */
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiModel } from '@reeve/shared';
import { fitToModel } from '../runs/claude.js';
import { decideToolUse, denialRecorder } from '../runs/permissions.js';

const note = (l: string, v: unknown) => console.log(`${l.padEnd(34)}: ${v}`);
let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log('--- fitToModel, a model with no auto mode ---');
const noAuto: ApiModel = {
  value: 'stub-no-auto', resolvedModel: null, displayName: 'Stub', description: 'a model with no auto mode',
  supportsEffort: true, supportedEffortLevels: ['low', 'high'], supportsAdaptiveThinking: true, supportsAutoMode: false,
};
const fittedNoAuto = await fitToModel('stub-no-auto', 'high', async () => noAuto);
check('does not throw, and reports autoMode: false', fittedNoAuto.autoMode === false);
check('still trims effort normally', fittedNoAuto.effort === 'high');
note('fitted (no auto mode)', JSON.stringify(fittedNoAuto));

console.log('\n--- fitToModel, a model that does support auto mode ---');
const withAuto: ApiModel = { ...noAuto, value: 'stub-auto', supportsAutoMode: true };
const fittedAuto = await fitToModel('stub-auto', 'high', async () => withAuto);
check('reports autoMode: true, unaffected', fittedAuto.autoMode === true);
note('fitted (auto mode)', JSON.stringify(fittedAuto));

console.log('\n--- fitToModel, an unlisted model ---');
const fittedUnlisted = await fitToModel('not-listed', 'high', async () => undefined);
check('an unlisted model is still sent as asked, autoMode true', fittedUnlisted.autoMode === true);

/**
 * The part a stub cannot stand in for: a session actually started with
 * `permissionMode` left out, as `startClaudeRun` now does for a model like
 * the stub above. `canUseTool` must still deny whatever reaches it, the same
 * way it denies auto mode's own classifier escalations — the whole point of
 * never widening permissions for the fallback.
 *
 * `default` mode's own built-in heuristics approve plainly safe calls (a
 * read-only `ls`, an `echo`) without ever reaching `canUseTool`, same as
 * `gh pr view` and the other commands `permission-check.ts` found running
 * unasked in auto mode — so this only asserts on `Edit`, which escalates
 * reliably in both modes and is denied the same way either way.
 */
console.log('\n--- a session with no permissionMode sent, for real ---');
const wt = mkdtempSync(join(tmpdir(), 'reeve-automode-'));
const g = (...a: string[]) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8' });
g('init', '-q', '-b', 'main');
g('config', 'user.email', 't@t.t');
g('config', 'user.name', 'T');
writeFileSync(join(wt, 'README.md'), '# base\n');
g('add', '-A');
g('commit', '-qm', 'base');

async function* once(text: string): AsyncIterable<SDKUserMessage> {
  yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: text } };
}

const recorder = denialRecorder();
const asks: string[] = [];
let initMode: string | undefined;
let editDenied = false;

for await (const m of query({
  prompt: once('Run `echo hi` with Bash, then edit README.md to add a line, then say in one sentence what happened to each.'),
  options: {
    cwd: wt,
    model: 'claude-sonnet-5',
    // No permissionMode: exactly what startClaudeRun now sends for a pinned
    // model that reports supportsAutoMode: false.
    maxTurns: 8,
    canUseTool: (toolName, input, { toolUseID }) => {
      asks.push(toolName);
      const decision = decideToolUse({ toolName, input });
      recorder.refused(toolName, input, toolUseID);
      if (toolName === 'Edit' && decision.behavior === 'deny') editDenied = true;
      return Promise.resolve(decision);
    },
  },
})) {
  if (m.type === 'system' && m.subtype === 'init') initMode = m.permissionMode;
}

note('init permissionMode', initMode);
note('canUseTool was asked about', JSON.stringify(asks));
check('the session did not start in auto mode', initMode !== 'auto', `init said ${initMode}`);
check('Edit escalated to canUseTool and was denied, as in auto mode', asks.includes('Edit') && editDenied);

console.log(`\n--- ${failures === 0 ? 'all good' : `${failures} FAILED`} ---`);
process.exit(failures === 0 ? 0 : 1);
