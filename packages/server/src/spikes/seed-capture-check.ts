/**
 * Checks that Testing seeds the board before it photographs it, without
 * spending API credit: that the seed runs after the card's server is stopped
 * and before the one that is photographed starts, that the picture shows what
 * the seed wrote, that a seed which fails is reported rather than thrown, and
 * that without a seed, or without anything to photograph, nothing changes.
 * Card b9d5ed0b's build captures were of an empty board for want of this.
 *
 * Builds a throwaway git repo in /tmp whose server lists the rows in a file,
 * read once as it starts, and whose seed writes that file. Drives
 * `testingStage.prepare` directly, and takes real screenshots, so it needs
 * Playwright's browser and a scratch database:
 *
 *   REEVE_DB=/tmp/reeve-seed-capture.db npx tsx packages/server/src/spikes/seed-capture-check.ts
 *
 * The screenshots go beside the database rather than into data/assets.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Repo } from '../db/schema.js';

if (!process.env.REEVE_DB) {
  console.error('Set REEVE_DB to a scratch database; this starts servers on whatever board it is given.');
  process.exit(2);
}
// Before anything reads `config`, which takes it once, on import.
process.env.REEVE_ASSETS ??= join(dirname(process.env.REEVE_DB), 'reeve-seed-capture-assets');

const { createApp } = await import('../index.js');
const { assetsFor, createCard, createRepo, getCard, getRun, insertAsset, insertRun, runsForCard } = await import('../db/queries.js');
const { ensureDevServer, waitForServer } = await import('../runs/devServer.js');
const { runRegistry } = await import('../runs/registry.js');
const { startShellRun } = await import('../runs/shell.js');
const { testingStage } = await import('../stages/testing.js');
const { ensureWorktree } = await import('../startStage.js');

const { db, writer } = createApp();

const checks: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = '') => checks.push([name, ok, detail]);

// --- A repo whose page is as tall as the rows its server read at start -------

const ROWS = 40;
const ROW_PX = 60;

const root = mkdtempSync(join(tmpdir(), 'reeve-seed-capture-'));
const repoPath = join(root, 'site');
mkdirSync(repoPath);
const g = (...a: string[]) => execFileSync('git', ['-C', repoPath, ...a], { encoding: 'utf8' });
g('init', '-q', '-b', 'main');
g('config', 'user.email', 't@t.t');
g('config', 'user.name', 'T');
// Read once, at start, as a server with a database open would: a server that
// started before the seed shows none of its rows however long it runs.
writeFileSync(
  join(repoPath, 'serve.mjs'),
  `import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
const rows = existsSync('rows.txt') ? readFileSync('rows.txt', 'utf8').split('\\n').filter(Boolean) : [];
const body = rows.length
  ? rows.map((r) => '<div style="height:${ROW_PX}px">' + r + '</div>').join('')
  : '<p>No rows</p>';
createServer((_q, r) => {
  r.writeHead(200, { 'content-type': 'text/html' });
  r.end('<!doctype html><html><body style="margin:0">' + body + '</body></html>');
}).listen(Number(process.argv[2]), '127.0.0.1');
`,
);
// Slow enough that a server started beside it, rather than after it, would
// read the file before it existed.
writeFileSync(
  join(repoPath, 'seed.mjs'),
  `import { writeFileSync } from 'node:fs';
await new Promise((r) => setTimeout(r, 500));
writeFileSync('rows.txt', Array.from({ length: ${ROWS} }, (_, i) => 'Seeded row ' + (i + 1)).join('\\n'));
`,
);
writeFileSync(join(repoPath, '.gitignore'), 'rows.txt\n');
g('add', '-A');
g('commit', '-qm', 'base');

const SEED = 'node seed.mjs';
const repo = createRepo(db, {
  name: `seed-capture-${Date.now()}`,
  repoPath,
  worktreeRoot: join(root, 'worktrees'),
  defaultBranch: 'main',
  setupCommand: null, testCommand: null, seedCommand: SEED,
  serverCommand: 'node serve.mjs {{port}}', serverUrl: null,
  teardownCommand: null, finishCommand: null, laneColor: null,
});

/** A card in Testing with a worktree, and a mockup of `/` unless it should have nothing to photograph. */
async function testingCard(title: string, opts: { mockup?: boolean } = {}) {
  const created = createCard(db, { title, repoId: repo.id, stage: 'testing' });
  await ensureWorktree(db, writer, created, repo);
  const card = getCard(db, created.id)!;
  if (opts.mockup !== false) {
    insertAsset(db, {
      cardId: card.id, kind: 'mockup', label: 'Board', url: '/', viewport: 1280,
      path: `${card.id}/mockup.png`, contentType: 'image/png',
    });
  }
  return card;
}

async function prepare(card: NonNullable<ReturnType<typeof getCard>>, withRepo: Repo) {
  // The run that would own the screenshots, as the runner makes it before `prepare`.
  const run = insertRun(db, {
    id: crypto.randomUUID(), cardId: card.id, kind: 'claude', stage: 'testing', status: 'running', cwd: card.worktreePath!,
  });
  const prepared = await testingStage.prepare!(
    db, writer, { card, repo: withRepo, worktreePath: card.worktreePath!, brief: '' }, run.id,
  );
  return prepared['screenshots'] ?? '';
}

async function runningServer(card: NonNullable<ReturnType<typeof getCard>>) {
  const server = await ensureDevServer(db, writer, card, repo);
  if (server.state !== 'running') throw new Error(`no server: ${JSON.stringify(server)}`);
  await waitForServer(db, server.runId, 10_000);
  return server.runId;
}

const shotHeight = (cardId: string) => assetsFor(db, cardId).find((a) => a.kind === 'screenshot')?.height ?? 0;
const shells = (cardId: string) => runsForCard(db, cardId).filter((r) => r.kind === 'shell');
const servers = (cardId: string) => runsForCard(db, cardId).filter((r) => r.kind === 'server');
const at = (d: Date | null | undefined) => d?.getTime() ?? NaN;

// --- Seeded, with no server running -------------------------------------------

{
  const card = await testingCard('seeded from cold');
  const text = await prepare(card, repo);
  const [seed] = shells(card.id);
  const [server] = servers(card.id);
  check('cold: the seed ran and succeeded', seed?.command === SEED && seed.status === 'succeeded', `${seed?.command} ${seed?.status}`);
  check(
    'cold: the seed finished before the server started',
    at(seed?.finishedAt) <= at(server?.startedAt),
    `seed done ${at(seed?.finishedAt)}, server up ${at(server?.startedAt)}`,
  );
  check('cold: the capture shows the seeded rows', shotHeight(card.id) >= ROWS * ROW_PX, `${shotHeight(card.id)}px tall`);
  check('cold: the prompt says the board was seeded', text.includes(`seeding the board with \`${SEED}\``), text.split('\n')[0] ?? '');
}

// --- Seeded, with the card's server already up --------------------------------

{
  const card = await testingCard('seeded while serving');
  const before = await runningServer(card);
  await prepare(card, repo);
  const old = getRun(db, before);
  const [seed] = shells(card.id);
  const fresh = servers(card.id).find((r) => r.id !== before);
  check('running: the old server was stopped', old?.status === 'cancelled', String(old?.status));
  check('running: ...before the seed started', at(old?.finishedAt) <= at(seed?.startedAt), `${at(old?.finishedAt)} vs ${at(seed?.startedAt)}`);
  check('running: a new server started after the seed', !!fresh && at(seed?.finishedAt) <= at(fresh.startedAt), String(fresh?.id));
  check('running: the capture shows the seeded rows', shotHeight(card.id) >= ROWS * ROW_PX, `${shotHeight(card.id)}px tall`);
}

// --- A seed that fails ----------------------------------------------------------

{
  const card = await testingCard('seed fails');
  const failing = 'node -e "process.exit(3)"';
  let text = '';
  let threw: unknown = null;
  try {
    text = await prepare(card, { ...repo, seedCommand: failing });
  } catch (err) {
    threw = err;
  }
  check('failing: prepare did not throw', threw === null, String(threw));
  check('failing: the prompt names the failure', text.includes(`\`${failing}\` failed (exit code 3)`), text.split('\n')[0] ?? '');
  check('failing: the capture was still taken', shotHeight(card.id) > 0, `${shotHeight(card.id)}px tall`);
}

// --- No seed command: a running server is left alone ------------------------------

{
  const card = await testingCard('no seed');
  const before = await runningServer(card);
  const text = await prepare(card, { ...repo, seedCommand: null });
  check('no seed: nothing ran but the server', shells(card.id).length === 0, String(shells(card.id).length));
  check('no seed: the running server was kept', servers(card.id).length === 1 && runRegistry.get(before) !== undefined, String(servers(card.id).length));
  check('no seed: the capture is of the unseeded page', shotHeight(card.id) > 0 && shotHeight(card.id) < ROWS * ROW_PX, `${shotHeight(card.id)}px tall`);
  // Not merely "seed", which this spike's own paths are full of.
  check('no seed: the prompt says nothing of seeding', !/seeding|seed command/.test(text), text.split('\n')[0] ?? '');
}

// --- Nothing to photograph: the seed is not run -------------------------------------

{
  const card = await testingCard('no captures', { mockup: false });
  const before = await runningServer(card);
  const text = await prepare(card, repo);
  check('no captures: nothing was requested', text === 'No screenshots were requested for this card.', text);
  check('no captures: the seed did not run', shells(card.id).length === 0, String(shells(card.id).length));
  check('no captures: the running server was kept', runRegistry.get(before) !== undefined, before);
}

// --- The host's board is not a repo command's -------------------------------------

{
  const card = await testingCard('environment', { mockup: false });
  const seen: string[] = [];
  const handle = startShellRun({
    db, writer, cardId: card.id, stage: 'testing', cwd: card.worktreePath!,
    command: `node -e "console.log(JSON.stringify([process.env.REEVE_DB ?? null, process.env.REEVE_ASSETS ?? null]))"`,
    onLine: (kind, line) => kind === 'stdout' && seen.push(line),
  });
  await handle.done;
  check('env: a repo command sees neither REEVE_DB nor REEVE_ASSETS', seen[0] === '[null,null]', seen[0] ?? 'nothing printed');
}

for (const run of runRegistry.all()) await run.stop('cancelled_by_user');
rmSync(root, { recursive: true, force: true });

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}
console.log(failed === 0 ? '\nthe board was seeded before every picture that wanted it' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
