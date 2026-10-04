/**
 * A gap in `liveDatabaseGuard` (runs/permissions.ts) that `permission-check.ts`
 * does not try: every bypass it tests gives the guard the live path written
 * out in full, absolute, the way the rest of this file's bypasses attack the
 * *parsing* of the value. This attacks what the value is resolved *against*
 * instead.
 *
 * `isLiveDatabase` compares `resolve(worktreePath, db)` to `config.dbFile` —
 * always relative to the worktree the stage started in, never to wherever the
 * command the guard is reading actually leaves the shell's cwd. A command
 * that `cd`s elsewhere first and then sets `REEVE_DB` to a bare filename is
 * resolved by the real shell relative to that *other* directory, but by this
 * guard relative to the worktree regardless — so `cd`ing into the live
 * database's own directory and writing just its filename opens the live
 * board and is waved through, because resolved against the worktree it reads
 * as some unrelated path that merely happens to share a basename.
 *
 * Nothing here needs the running server's own database: `config.dbFile` is
 * read like any other setting, so a scratch `REEVE_DB` plays the live board's
 * part the same way `permission-check.ts` does, and the checks never touch
 * it.
 *
 *   REEVE_DB=/tmp/relpath-scratch.db npx tsx packages/server/src/spikes/live-db-relative-path-check.ts
 */
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { config } from '../config.js';
import { liveDatabaseGuard } from '../runs/permissions.js';

const note = (l: string, v: unknown) => console.log(`${l.padEnd(46)}: ${v}`);
let failures = 0;
function check(name: string, ok: boolean) {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
}

const wt = mkdtempSync(join(tmpdir(), 'reeve-relpath-'));
const guard = liveDatabaseGuard(wt, () => {});
async function hook(command: string): Promise<'denied' | 'allowed'> {
  const input = {
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_x',
    session_id: '', transcript_path: '', cwd: wt,
  } as HookInput;
  const out = (await guard(input, 'toolu_x', { signal: new AbortController().signal })) as {
    hookSpecificOutput?: { permissionDecision?: string };
  };
  return out.hookSpecificOutput?.permissionDecision === 'deny' ? 'denied' : 'allowed';
}

const live = config.dbFile; // a scratch path here, standing in for the live board — see the header.
const liveDir = dirname(live);
const liveFile = basename(live);

note('the live path the guard protects', live);

check(
  'the absolute live path, from the worktree, is denied',
  (await hook(`REEVE_DB=${live} npx tsx x.ts`)) === 'denied',
);

// The actual bypass: `cd` into the live database's directory, then name it
// bare. A real shell started with `cwd: worktreePath` (as every Bash call in
// a run is) ends up, after the `cd`, sitting in `liveDir` — so `REEVE_DB`
// resolves there to `live`, byte for byte. The guard still resolves it
// against `worktreePath`, sees an unrelated path, and says nothing.
const bypass = `cd ${liveDir} && REEVE_DB=${liveFile} npx tsx x.ts`;
const result = await hook(bypass);
note('after `cd` into the live db\'s own dir, a bare filename', result);
// "ok" here means the vulnerability was NOT found: a passing run should
// print FAIL for this one, and does, until the guard learns to read `cd`.
check(
  'FINDING: a `cd` into the live db\'s own dir should still be caught',
  result === 'denied',
);

// The same shape, one level up: `cd` into the live directory's *parent*,
// then a relative path of `basename(liveDir)/liveFile` — the guard is no
// more able to follow a `cd` two components removed than one.
const parent = dirname(liveDir);
const twoUp = `cd ${parent} && REEVE_DB=${basename(liveDir)}/${liveFile} npx tsx x.ts`;
check('the same bypass, one directory further out, should also be caught', (await hook(twoUp)) === 'denied');

// Contrast: the same relative value, with no `cd`, is read against the
// worktree as intended and (almost certainly) names nothing special there.
check(
  'without the `cd`, the bare filename alone reads as an unrelated path',
  (await hook(`REEVE_DB=${liveFile} npx tsx x.ts`)) === 'allowed',
);

console.log(`\n--- ${failures === 0 ? 'all good' : `${failures} FAILED`} ---`);
process.exitCode = failures === 0 ? 0 : 1;
