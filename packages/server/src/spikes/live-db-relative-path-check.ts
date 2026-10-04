/**
 * Throwaway check for one disguise `permission-check.ts` does not try: a
 * relative `REEVE_DB` after a leading `cd`.
 *
 * `scratchDbRefusal` used to resolve every `REEVE_DB` value against the
 * stage's `worktreePath`, full stop, no matter what came before it in the
 * command. `cd <live-db-dir> && REEVE_DB=<basename> npx tsx …` is read by the
 * real shell, after the `cd`, relative to that other directory — landing
 * exactly on the live database — but the guard was resolving `<basename>`
 * against `worktreePath` instead, computing an unrelated path and letting it
 * through. This is what caught that: before the fix to `leadingCwd` in
 * runs/permissions.ts, both `cd` cases below were ALLOWED.
 *
 *   REEVE_DB=/tmp/live-db-relative-check.db npx tsx packages/server/src/spikes/live-db-relative-path-check.ts
 *
 * With that `REEVE_DB`, `config.dbFile` IS the scratch path, so it plays the
 * live board here; the paths derived from it below are what a command would
 * have to write to land on it for real.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { liveDatabaseGuard } from '../runs/permissions.js';

let failures = 0;
function check(name: string, ok: boolean) {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
}

const wt = mkdtempSync(join(tmpdir(), 'reeve-live-db-relative-'));
const refused: string[] = [];
const guard = liveDatabaseGuard(wt, (_tool, input) => refused.push(String(input['command'])));

async function denied(command: string): Promise<boolean> {
  const input = {
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_x',
    session_id: '', transcript_path: '', cwd: wt,
  } as HookInput;
  const out = (await guard(input, 'toolu_x', { signal: new AbortController().signal })) as {
    hookSpecificOutput?: { permissionDecision?: string };
  };
  return out.hookSpecificOutput?.permissionDecision === 'deny';
}

const live = config.dbFile;
const dir = dirname(live); // the live database's own directory
const file = basename(live);
const up = dirname(dir); // one directory further up
const dirName = basename(dir);

check('the absolute form is denied, as always', await denied(`REEVE_DB=${live} npx tsx x.ts`));

check(
  'a relative REEVE_DB after cd into the live db directory lands on it too, one directory removed',
  await denied(`cd ${dir} && REEVE_DB=${file} npx tsx x.ts`),
);

check(
  'a relative REEVE_DB after cd one directory further up lands on it too, two directories removed',
  await denied(`cd ${up} && REEVE_DB=${dirName}/${file} npx tsx x.ts`),
);

check('and all three were recorded', refused.length === 3);

console.log(`\n--- ${failures === 0 ? 'all good' : `${failures} FAILED`} ---`);
process.exitCode = failures === 0 ? 0 : 1;
