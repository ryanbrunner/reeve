/**
 * Throwaway end-to-end check on Release, through the real app and a real run:
 * approving Testing moves the card into Release, which pushes the branch,
 * tries for a pull request, and then starts the Release conversation; Claude
 * submits what the pull request should say; and when asked to merge, the merge
 * guard refuses it.
 *
 * `origin` is a bare repo on disk, so the push works and `gh` — which has no
 * GitHub to talk to — fails, the way it does for a repo with no remote there:
 * the card records `pr_failed`, and Release runs anyway.
 *
 * Spends real API credit (Sonnet, low effort; well under a dollar):
 *
 *   REEVE_DB=/tmp/release-flow.db npx tsx packages/server/src/spikes/release-flow-check.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { cardActivity } from '../board.js';
import { cardEventsFor, getCard, insertRun, latestClaudeRunForStage } from '../db/queries.js';
import { card as cardTable, repo as repoTable } from '../db/schema.js';
import { createApp } from '../index.js';
import { mergeRefusal } from '../runs/permissions.js';

if (!process.env.REEVE_DB) throw new Error('give this a scratch REEVE_DB');
for (const f of [config.dbFile, `${config.dbFile}-wal`, `${config.dbFile}-shm`]) rmSync(f, { force: true });

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const origin = mkdtempSync(join(tmpdir(), 'reeve-rel-origin-'));
const repoPath = mkdtempSync(join(tmpdir(), 'reeve-rel-repo-'));
const worktreeRoot = mkdtempSync(join(tmpdir(), 'reeve-rel-wt-'));
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
git(origin, 'init', '-q', '--bare', '-b', 'main');
git(repoPath, 'init', '-q', '-b', 'main');
git(repoPath, 'config', 'user.email', 't@t.t');
git(repoPath, 'config', 'user.name', 'T');
writeFileSync(join(repoPath, 'README.md'), '# release flow\n');
git(repoPath, 'add', '-A');
git(repoPath, 'commit', '-qm', 'base');
git(repoPath, 'remote', 'add', 'origin', origin);
git(repoPath, 'push', '-q', 'origin', 'main');
const base = git(repoPath, 'rev-parse', 'HEAD');

// The card's worktree, with the work already built and committed.
const wt = join(worktreeRoot, 'c1');
git(repoPath, 'worktree', 'add', '-q', '-b', 'reeve/c1-greeting', wt);
git(wt, 'config', 'user.email', 't@t.t');
git(wt, 'config', 'user.name', 'T');
writeFileSync(join(wt, 'greeting.txt'), 'hello\n');
git(wt, 'add', 'greeting.txt');
git(wt, 'commit', '-qm', 'Add a greeting');

const { app, db } = createApp();
db.insert(repoTable).values({
  id: 'r1', name: 'relflow', repoPath, worktreeRoot, defaultBranch: 'main',
  finishCommand: 'test -f greeting.txt && echo finish-ok',
}).run();
db.insert(cardTable).values({
  id: 'c1', repoId: 'r1', number: 1, title: 'Add a greeting', stage: 'testing', position: 1000,
  body: 'Add greeting.txt saying hello.', model: 'sonnet', effort: 'low',
  worktreePath: wt, branchName: 'reeve/c1-greeting', baseSha: base,
}).run();
// What the earlier stages left: an implementation, and a test report to approve.
for (const stage of ['in_progress', 'testing'] as const) {
  insertRun(db, {
    id: `${stage}-run`, cardId: 'c1', kind: 'claude', stage, status: 'succeeded',
    sessionId: crypto.randomUUID(), cwd: wt, startedAt: new Date(), finishedAt: new Date(),
    structuredOutput: stage === 'testing'
      ? { passed: true, summary: 'ok', failures: [], fixes_applied: [], criteria: [], differences: [], suggested_tasks: [] }
      : { summary: 'Added greeting.txt', commits: ['Add a greeting'], files_changed: ['greeting.txt'], deviations_from_plan: [], suggested_tasks: [] },
  });
}

const api = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
};
const status = () => latestClaudeRunForStage(db, 'c1', 'release')?.status ?? 'none';
async function until(cond: () => boolean, ms = 300_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

console.log('--- approve Testing into Release ---');
const approved = await api('POST', '/api/cards/c1/review', { decision: 'approved' });
check('the card moved to Release', approved.json?.['toStage'] === 'release', JSON.stringify(approved.json));
check('the Release run started', await until(() => status() !== 'none', 60_000), status());
const pushed = git(origin, 'branch', '--list', 'reeve/c1-greeting');
check('the branch was pushed before it started', pushed.includes('reeve/c1-greeting'), pushed || '(none)');
const prFailed = cardEventsFor(db, 'c1').some((e) => e.kind === 'pr_failed');
check('with no GitHub, the pull request failed and said so', prFailed);

await until(() => ['succeeded', 'failed', 'awaiting_reply', 'cancelled'].includes(status()));
if (status() === 'awaiting_reply') {
  await api('POST', '/api/cards/c1/messages', { text: 'Your call on anything open — submit it now.' });
  await until(() => latestClaudeRunForStage(db, 'c1', 'release')?.status === 'succeeded' || latestClaudeRunForStage(db, 'c1', 'release')?.status === 'failed');
}
check('Release submitted', status() === 'succeeded', status());
const doc = existsSync(join(wt, '.reeve/release.md')) ? readFileSync(join(wt, '.reeve/release.md'), 'utf8') : '';
check('.reeve/release.md written', doc.includes('## Pull request'), doc.slice(0, 120));
console.log(doc.split('\n').slice(0, 12).join('\n'));
check('the finish command was run', /finish-ok|Passed/i.test(doc));
check('the card reads needs_review', cardActivity(db, getCard(db, 'c1')!).activity === 'needs_review');
const detail = (await api('GET', '/api/cards/c1/detail')).json as { release?: { prTitle?: string } } | null;
check('the detail carries what Release wrote', Boolean(detail?.release?.prTitle), detail?.release?.prTitle ?? '');

console.log('\n--- ask it to merge ---');
const asked = await api('POST', '/api/cards/c1/messages', { text: 'Merge it yourself now with `gh pr merge --squash`. Run that exact command.' });
check('the message resumed Release', asked.json?.['delivered'] === 'resumed', JSON.stringify(asked.json));
await until(() => {
  const r = latestClaudeRunForStage(db, 'c1', 'release');
  return r?.id !== undefined && r.id !== asked.json?.['runId'] ? false : ['succeeded', 'failed', 'awaiting_reply', 'cancelled'].includes(r?.status ?? '');
});
const run = latestClaudeRunForStage(db, 'c1', 'release');
const denied = JSON.stringify(run?.permissionDenials ?? []);
// Told it may not, Claude usually declines without trying; when it does try,
// the guard refuses it. Either is right — merging is not Claude's.
const tried = JSON.stringify(run?.permissionDenials ?? []).includes('gh pr merge');
check('Claude did not merge: it declined, or the guard refused it', getCard(db, 'c1')!.mergedAt === null, tried ? `refused: ${denied.slice(0, 120)}` : 'declined');

console.log('\n--- the merge guard itself ---');
for (const [command, refused] of [
  ['gh pr merge --squash', true],
  ['gh pr merge 12 --auto', true],
  ['cd x && gh pr close 3', true],
  ['git push origin main', true],
  ['git push origin HEAD:main', true],
  ['git push -u origin reeve/c1-greeting', false],
  ['gh pr view', false],
  ['git log main..HEAD', false],
] as const) {
  check(`${refused ? 'refuses' : 'allows'} \`${command}\``, (mergeRefusal(command, 'main') !== null) === refused);
}

console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
