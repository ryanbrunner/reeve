/**
 * Checks that a server command made of two cooperating processes — one
 * backgrounded with `&`, one left running in the shell's own foreground,
 * the shape `npm run dev` used before #104 switched Reeve's own seed to a
 * single process — can't strand either half on Reeve without anyone
 * noticing. See `startShellRun`'s `exit` handler in `runs/shell.ts`.
 *
 * Builds a throwaway git repo in /tmp and starts a real two-process server
 * on loopback. Needs a scratch database:
 *
 *   REEVE_DB=/tmp/reeve-two-process.db npx tsx packages/server/src/spikes/two-process-server-check.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiCard, ApiRepo } from '@reeve/shared';
import { createApp } from '../index.js';
import { eventsSince, getCard, getRun, listRepos } from '../db/queries.js';
import { ensureWorktree } from '../startStage.js';

if (!process.env['REEVE_DB']) {
  console.error('Set REEVE_DB to a scratch database; this starts servers on whatever board it is given.');
  process.exit(2);
}

const { app, db, writer } = createApp();

const checks: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = '') => checks.push([name, ok, detail]);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}

const until = async <T>(read: () => T | null | undefined, ms: number): Promise<T | null> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = read();
    if (v != null) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
};

const root = mkdtempSync(join(tmpdir(), 'reeve-two-process-'));
const repoPath = join(root, 'site');
mkdirSync(repoPath);
const g = (...a: string[]) => execFileSync('git', ['-C', repoPath, ...a], { encoding: 'utf8' });
g('init', '-q', '-b', 'main');
g('config', 'user.email', 't@t.t');
g('config', 'user.name', 'T');
writeFileSync(join(repoPath, 'README.md'), 'two-process server check\n');
g('add', '-A');
g('commit', '-qm', 'base');

const created = await call<ApiRepo>('POST', '/api/repos', {
  name: `two-process-${Date.now()}`,
  repoPath,
  // The background half writes its own pid where the check can read it, then
  // sleeps; the foreground half writes its pid and exits with a distinct
  // code on its own, standing in for a crash rather than a stop.
  serverCommand:
    `node -e "require('fs').writeFileSync('bg.pid', String(process.pid)); setInterval(() => {}, 1000)" & ` +
    `node -e "require('fs').writeFileSync('fg.pid', String(process.pid)); setTimeout(() => process.exit(3), 1000)"`,
});
if (created.status !== 201) throw new Error(`could not create the repo: ${JSON.stringify(created.json)}`);
const repoId = created.json.id;

const card = (await call<ApiCard>('POST', '/api/cards', { title: 'two-process server', repoId })).json;
await ensureWorktree(db, writer, getCard(db, card.id)!, listRepos(db).find((r) => r.id === repoId)!);
const tree = getCard(db, card.id)!;

const started = await call<{ runId: string }>('POST', `/api/cards/${card.id}/server`);
if (started.status !== 201) throw new Error(`server did not start: ${JSON.stringify(started.json)}`);
const { runId } = started.json;

// The foreground half's own pid file, written once the process is up.
const fgPidFile = join(tree.worktreePath!, 'fg.pid');
const bgPidFile = join(tree.worktreePath!, 'bg.pid');
await until(() => existsFile(fgPidFile), 5_000);
await until(() => existsFile(bgPidFile), 5_000);
const bgPid = Number(readFileSync(bgPidFile, 'utf8'));
check('background half is running once both halves have started', alive(bgPid), String(bgPid));

// The foreground half exits after ~1s; `close` used to wait on the
// backgrounded half's stdio, which it never gives up on its own.
const row = await until(() => (getRun(db, runId)?.status === 'running' ? null : getRun(db, runId)), 5_000);
check('the run reaches a final status once the foreground half exits', row != null && row.status !== 'running', JSON.stringify(row));
check('the run is failed, with the foreground half\'s own exit code', row?.status === 'failed' && row?.exitCode === 3, JSON.stringify(row));

// Give the SIGTERM sweep a moment, well under its SIGKILL grace.
await until(() => (alive(bgPid) ? null : true), 3_000);
check('the backgrounded half is swept with it, not left running', !alive(bgPid), String(bgPid));

const events = eventsSince(db, runId, 0);
const left = events.find((e) => e.kind === 'error' && String(e.payload).includes('left'));
check('the half-failure is named in the run\'s own events, not silent', left != null, JSON.stringify(left));

// An ordinary single-process server still stops cleanly through the same path.
await call('PATCH', `/api/repos/${repoId}`, { serverCommand: 'node -e "setInterval(() => {}, 1000)"' });
const card2 = (await call<ApiCard>('POST', '/api/cards', { title: 'single-process server', repoId })).json;
await ensureWorktree(db, writer, getCard(db, card2.id)!, listRepos(db).find((r) => r.id === repoId)!);
const started2 = await call<{ runId: string }>('POST', `/api/cards/${card2.id}/server`);
const row2 = await until(() => getRun(db, started2.json.runId), 2_000);
check('an ordinary single-process server still starts', row2?.status === 'running', JSON.stringify(row2));
const stopped = await call('DELETE', `/api/cards/${card2.id}/server`);
check('...and stops cleanly through DELETE', stopped.status === 204 || stopped.status === 200, String(stopped.status));

rmSync(root, { recursive: true, force: true });

function existsFile(path: string): true | null {
  try {
    readFileSync(path);
    return true;
  } catch {
    return null;
  }
}

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}
console.log(failed === 0 ? '\nneither half of a two-process server command is left stranded' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
