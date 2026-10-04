/**
 * Throwaway check on the fallback `fitToModel` now takes instead of refusing
 * a run outright: a pinned model that doesn't take auto mode should still
 * run, just without `permissionMode: 'auto'` asked for, and `canUseTool`
 * should still deny everything that reaches it exactly as it does in a
 * normal auto-mode run.
 *
 * Haiku is the model this matters for in practice, and it is the case a stub
 * cannot stand in for: the CLI lists it with no `supportsAutoMode` field at
 * all — not `false` — so the fix had to read "not reported" as "doesn't take
 * it" for this one field, the opposite of what every other capability does.
 * `fitToModel`'s own comment has the full story. This spike checks both ends
 * of it: the resolution against the CLI's real listing, and what a real
 * session started without `permissionMode` actually does. The second part
 * spends real API credit, the same as permission-check.ts.
 *
 *   REEVE_DB=/tmp/auto-mode-scratch.db npx tsx packages/server/src/spikes/auto-mode-fallback-check.ts
 */
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiModel } from '@reeve/shared';
import { jsonSchemaFor } from '@reeve/shared';
import { fitToModel } from '../runs/claude.js';
import { decideToolUse, denialRecorder } from '../runs/permissions.js';
import { STAGE_DEFINITIONS } from '../stages/index.js';

const note = (l: string, v: unknown) => console.log(`${l.padEnd(34)}: ${v}`);
let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log('--- fitToModel, a model the CLI explicitly says has no auto mode ---');
const noAuto: ApiModel = {
  value: 'stub-no-auto', resolvedModel: null, displayName: 'Stub', description: 'a model with no auto mode',
  supportsEffort: true, supportedEffortLevels: ['low', 'high'], supportsAdaptiveThinking: true, supportsAutoMode: false,
};
const fittedNoAuto = await fitToModel('stub-no-auto', 'high', async () => noAuto);
check('does not throw, and reports autoMode: false', fittedNoAuto.autoMode === false);
check('still trims effort normally', fittedNoAuto.effort === 'high');
note('fitted (explicit false)', JSON.stringify(fittedNoAuto));

console.log('\n--- fitToModel, a model that leaves supportsAutoMode unreported ---');
const unreported: ApiModel = { ...noAuto, value: 'stub-unreported', supportsAutoMode: undefined };
const fittedUnreported = await fitToModel('stub-unreported', 'high', async () => unreported);
// The one field read the other way around from the rest: Haiku's listing
// looks exactly like this, and a session asked to run it in auto mode comes
// back reporting 'default' — see the real check below.
check('unreported reads as not taking it, same as explicit false', fittedUnreported.autoMode === false);
note('fitted (unreported)', JSON.stringify(fittedUnreported));

console.log('\n--- fitToModel, a model that explicitly supports auto mode ---');
const withAuto: ApiModel = { ...noAuto, value: 'stub-auto', supportsAutoMode: true };
const fittedAuto = await fitToModel('stub-auto', 'high', async () => withAuto);
check('reports autoMode: true, unaffected', fittedAuto.autoMode === true);
note('fitted (auto mode)', JSON.stringify(fittedAuto));

console.log('\n--- fitToModel, an unlisted model ---');
const fittedUnlisted = await fitToModel('not-listed', 'high', async () => undefined);
check('an unlisted model is still sent as asked, autoMode true', fittedUnlisted.autoMode === true);

console.log('\n--- fitToModel, Haiku, against the CLI\'s real listing ---');
const fittedHaiku = await fitToModel('haiku', 'high');
check('the real CLI listing resolves Haiku to autoMode: false', fittedHaiku.autoMode === false, JSON.stringify(fittedHaiku));

/**
 * The part nothing above can stand in for: a real session, asked to run
 * Haiku in auto mode exactly as `startClaudeRun` used to ask unconditionally.
 * This is only a note, not a check — repeated runs show Haiku's own `init`
 * message flips between `auto` and `default` for the identical request, so
 * it is not a reliable signal to gate this change's correctness on. What it
 * does establish, and what motivated reading `supportsAutoMode` the way
 * `fitToModel` now does, is that the CLI's *listing* for Haiku is the one
 * thing that is stable — no `supportsAutoMode` field at all — so that is what
 * `fitToModel` decides from, once, before a session exists, rather than
 * something only knowable after a run has already started.
 */
console.log('\n--- Haiku, asked for auto mode anyway: what init reports (informational, not a check) ---');
{
  const ac = new AbortController();
  let haikuInitMode: string | undefined;
  for await (const m of query({
    prompt: (async function* () {
      yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: 'say hi' } } as SDKUserMessage;
    })(),
    options: { cwd: '/tmp', model: 'haiku', permissionMode: 'auto', abortController: ac },
  })) {
    if (m.type === 'system' && m.subtype === 'init') { haikuInitMode = m.permissionMode; ac.abort(); break; }
  }
  note('Haiku init permissionMode, auto asked for', haikuInitMode);
}

/**
 * The real point of the fallback: a session with `permissionMode` left out
 * entirely, exactly as `startClaudeRun` now sends it for Haiku, confirming
 * `canUseTool` still denies whatever reaches it the same way it denies auto
 * mode's own classifier escalations. `default` mode's own built-in heuristics
 * approve plainly safe calls (a read-only `ls`, an `echo`) without ever
 * reaching `canUseTool`, same as the commands `permission-check.ts` found
 * running unasked in auto mode — so the denial check only asserts on `Edit`,
 * which escalates reliably in both modes and is denied the same way either
 * way.
 */
console.log('\n--- Haiku, with no permissionMode sent, as startClaudeRun now sends it ---');
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
    model: 'haiku',
    // No permissionMode: exactly what startClaudeRun now sends once
    // fitToModel says Haiku doesn't take auto mode.
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

/**
 * The rest of what `startClaudeRun` actually sends alongside the dropped
 * `permissionMode`: `effort`, adaptive thinking, and the structured
 * `outputFormat` every stage asks for. `fitToModel` leaves all three of
 * those on for Haiku — only `supportsAutoMode` is read the stricter way —
 * so a Haiku-pinned run needs them to work too, not just start.
 */
console.log("\n--- Haiku, with the rest of a stage's real options, not just permissionMode ---");
{
  let subtype: string | undefined;
  for await (const m of query({
    prompt: (async function* () {
      yield {
        type: 'user', session_id: '', parent_tool_use_id: null,
        message: { role: 'user', content: 'Say hello and return minimal structured output satisfying the schema.' },
      } as SDKUserMessage;
    })(),
    options: {
      cwd: '/tmp',
      model: 'haiku',
      effort: 'high',
      thinking: { type: 'adaptive', display: 'summarized' },
      outputFormat: { type: 'json_schema', schema: jsonSchemaFor(STAGE_DEFINITIONS.planning!.schema) },
      maxTurns: 3,
    },
  })) {
    if (m.type === 'result') subtype = m.subtype;
  }
  note('result subtype', subtype);
  check("Haiku's own options — effort, adaptive thinking, structured output — all still work", subtype === 'success');
}

console.log(`\n--- ${failures === 0 ? 'all good' : `${failures} FAILED`} ---`);
process.exit(failures === 0 ? 0 : 1);
