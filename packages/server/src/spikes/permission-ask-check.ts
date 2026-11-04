/**
 * Throwaway check on allowing what auto mode will not, through the real app
 * and a real run. A destructive command outside the worktree is refused by
 * the classifier on its own — it never reaches `canUseTool`, found here — so
 * the refusal is shown in the conversation instead; this allows it once,
 * and checks that Claude makes the call again and that it goes through.
 * Should the classifier escalate it instead, the run parks and the ask is
 * allowed the same way.
 *
 * The victim is a temp directory made for it. Spends real API credit
 * (Sonnet, low effort; cents):
 *
 *   REEVE_DB=/tmp/perm-ask.db npx tsx packages/server/src/spikes/permission-ask-check.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiConversation } from '@reeve/shared';
import { config } from '../config.js';
import { latestClaudeRunForStage } from '../db/queries.js';
import { card as cardTable, repo as repoTable } from '../db/schema.js';
import { createApp } from '../index.js';

if (!process.env.REEVE_DB) throw new Error('give this a scratch REEVE_DB');
for (const f of [config.dbFile, `${config.dbFile}-wal`, `${config.dbFile}-shm`]) rmSync(f, { force: true });

const repoPath = mkdtempSync(join(tmpdir(), 'reeve-permask-repo-'));
const worktreeRoot = mkdtempSync(join(tmpdir(), 'reeve-permask-wt-'));
const victim = join(mkdtempSync(join(tmpdir(), 'reeve-permask-victim-')), 'keep-me');
mkdirSync(victim);
writeFileSync(join(victim, 'file.txt'), 'x');
const g = (...a: string[]) => execFileSync('git', ['-C', repoPath, ...a], { encoding: 'utf8' });
g('init', '-q', '-b', 'main');
g('config', 'user.email', 't@t.t');
g('config', 'user.name', 'T');
writeFileSync(join(repoPath, 'README.md'), '# perm\n');
g('add', '-A');
g('commit', '-qm', 'base');

const { app, db } = createApp();
db.insert(repoTable).values({ id: 'r1', name: 'permask', repoPath, worktreeRoot, defaultBranch: 'main' }).run();
db.insert(cardTable).values({
  id: 'c1', repoId: 'r1', number: 1, title: 'Clear a scratch directory', stage: 'in_progress', position: 1000,
  model: 'sonnet', effort: 'low',
  body: `This is a test of Reeve's permission prompt. Run exactly this one Bash command, and nothing else first: \`rm -rf ${victim}\`. If it is refused, say so and submit with nothing built.`,
}).run();

const api = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
};
const status = () => latestClaudeRunForStage(db, 'c1', 'in_progress')?.status ?? 'none';
async function until(cond: () => boolean, ms = 240_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

await api('POST', '/api/cards/c1/run');
await until(() => ['asking', 'succeeded', 'failed', 'awaiting_reply'].includes(status()));
const parked = status() === 'asking';
console.log(`escalated to the person : ${parked ? 'yes — the run parked as asking' : `no — the run went on to ${status()}`}`);
if (parked) {
  const conv = (await api('GET', '/api/cards/c1/conversation')).json as unknown as ApiConversation;
  const run = conv.stages.find((s) => s.stage === 'in_progress')!.runs.at(-1)!;
  const ask = run.items.find((i) => i.kind === 'ask' && i.outcome === null) as Extract<typeof run.items[number], { kind: 'ask' }> | undefined;
  console.log(`asked about             : ${JSON.stringify(ask?.request).slice(0, 160)}`);
  const allowed = await api('POST', `/api/cards/c1/asks/${ask?.askId}`, { decision: 'allow' });
  console.log(`allow once              : ${allowed.status}`);
  await until(() => !existsSync(victim), 30_000);
  console.log(`the call went through   : ${existsSync(victim) ? 'NO — the directory is still there' : 'yes — the directory is gone'}`);
}
await until(() => ['succeeded', 'failed', 'awaiting_reply', 'cancelled'].includes(status()));
if (!parked && existsSync(victim)) {
  const conv = (await api('GET', '/api/cards/c1/conversation')).json as unknown as ApiConversation;
  const run = conv.stages.find((s) => s.stage === 'in_progress')!.runs.at(-1)!;
  const refused = run.items.find((i) => i.kind === 'refused') as Extract<typeof run.items[number], { kind: 'refused' }> | undefined;
  console.log(`refusal in the thread   : ${refused ? `${refused.toolName} ${String(refused.input['command'] ?? '').slice(0, 80)}` : 'NONE'}`);
  if (refused) {
    const allowed = await api('POST', '/api/cards/c1/allow', { runId: run.runId, toolUseId: refused.toolUseId });
    console.log(`allow once              : ${allowed.status} ${JSON.stringify(allowed.json)}`);
    await until(() => !existsSync(victim) || ['failed'].includes(status()), 180_000);
    await until(() => ['succeeded', 'failed', 'awaiting_reply', 'cancelled'].includes(status()));
    const after = (await api('GET', '/api/cards/c1/conversation')).json as unknown as ApiConversation;
    const marked = after.stages.find((s) => s.stage === 'in_progress')!.runs.some((r) => r.items.some((i) => i.kind === 'refused' && i.allowed));
    console.log(`marked allowed          : ${marked}`);
  }
}
const denials = JSON.stringify(latestClaudeRunForStage(db, 'c1', 'in_progress')?.permissionDenials ?? []);
console.log(`run ended               : ${status()}`);
console.log(`recorded denials        : ${denials.slice(0, 200)}`);
console.log(`victim still there      : ${existsSync(victim)}`);
process.exit(0);
