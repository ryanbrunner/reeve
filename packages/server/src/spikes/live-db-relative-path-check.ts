/**
 * Throwaway check for the disguises `permission-check.ts` does not try: a
 * relative `REEVE_DB` whose real cwd is not `worktreePath`.
 *
 * `scratchDbRefusal` used to resolve every `REEVE_DB` value against the
 * stage's `worktreePath`, full stop, no matter what came before it in the
 * command. `cd <live-db-dir> && REEVE_DB=<basename> npx tsx …` is read by the
 * real shell, after the `cd`, relative to that other directory — landing
 * exactly on the live database — but the guard was resolving `<basename>`
 * against `worktreePath` instead, computing an unrelated path and letting it
 * through. Before the fix to `cwdCandidates` in runs/permissions.ts, every
 * "denied" case below but the absolute one was ALLOWED, and the unparseable
 * `cd` in the "allowed" case was denied even though its value is absolute and
 * so does not depend on it.
 *
 *   REEVE_DB=/tmp/live-db-relative-check.db npx tsx packages/server/src/spikes/live-db-relative-path-check.ts
 *
 * With that `REEVE_DB`, `config.dbFile` IS the scratch path, so it plays the
 * live board here; the paths derived from it below are what a command would
 * have to write to land on it for real.
 */
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
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

console.log('\n--- disguises that move or hide the cwd without naming the live db in plain cd ---');

check(
  'a cd not leading the command — behind an unrelated command first — still counts',
  await denied(`true && cd ${dir} && REEVE_DB=${file} npx tsx x.ts`),
);
check('a cd inside a subshell still counts', await denied(`(cd ${dir} && REEVE_DB=${file} npx tsx x.ts)`));
check('pushd moves the cwd the same way cd does', await denied(`pushd ${dir} && REEVE_DB=${file} npx tsx x.ts`));
check(
  "a flag on cd's target (`cd -P dir`) is a target this cannot read, not the previous directory",
  await denied(`cd -P ${dir} && REEVE_DB=${file} npx tsx x.ts`),
);
check(
  'REEVE_DB set before a cd that moves where it is actually read from still counts',
  await denied(`export REEVE_DB=${file}; cd ${dir}; npx tsx x.ts`),
);

console.log('\n--- shell behaviour the cd parser cannot model, refused rather than guessed ---');

check(
  'a glob in the cd target is denied rather than resolved literally',
  await denied(`cd ${dir.slice(0, -1)}* && REEVE_DB=${file} npx tsx x.ts`),
);
check(
  "trailing text after a cd target, the shape zsh's \`cd old new\` substitution leaves, is denied",
  await denied(`cd ${dir} extra && REEVE_DB=${file} npx tsx x.ts`),
);

console.log('\n--- a symlinked cwd ---');

const link = join(tmpdir(), `reeve-live-db-link-${process.pid}`);
symlinkSync(dir, link);
try {
  check(
    'cd through a symlink to the live db directory still lands on it',
    await denied(`cd ${link} && REEVE_DB=${file} npx tsx x.ts`),
  );
} finally {
  rmSync(link);
}

console.log('\n--- what a leading cd must not cost ---');

check(
  "an absolute value doesn't depend on cwd, so a cd whose own target can't be read plainly doesn't deny it",
  !(await denied(`cd "$(pwd)" && REEVE_DB=/tmp/live-db-relative-scratch.db npx tsx x.ts`)),
);
check(
  'a relative REEVE_DB after cd somewhere unrelated to the live db is allowed',
  !(await denied(`cd packages && REEVE_DB=scratch.db npx tsx x.ts`)),
);

console.log(`\n--- ${failures === 0 ? 'all good' : `${failures} FAILED`} ---`);
process.exitCode = failures === 0 ? 0 : 1;
