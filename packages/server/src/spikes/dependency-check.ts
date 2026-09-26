/**
 * Checks card dependencies end to end without spending API credit: the
 * migration on a fresh database and on one that predates it, adding a link and
 * reading it back after the app is rebuilt, both directions on the detail and
 * the board, removing one, the refusals and that they save nothing, and a
 * deleted card's links going with it.
 *
 *   REEVE_DB=/tmp/reeve-deps.db npx tsx packages/server/src/spikes/dependency-check.ts
 *
 * With no REEVE_DB it makes its own under /tmp rather than opening
 * data/reeve.db. Nothing in the app removes a card's row — the card header's
 * Delete archives it, and archived cards keep their links on purpose — so the
 * delete here is SQL, on the app's own connection with its foreign keys on.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiCard, BoardResponse, CardDetail } from '@reeve/shared';

const scratch = mkdtempSync(join(tmpdir(), 'reeve-deps-'));
// Before anything reads config, which fixes the database path at import.
process.env.REEVE_DB ??= join(scratch, 'app.db');

const { config } = await import('../config.js');
const { openDatabase } = await import('../db/client.js');
const { runMigrations } = await import('../db/migrate.js');
const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');

type Journal = { entries: Array<{ tag: string; when: number }> };
const journal = JSON.parse(readFileSync(join(config.migrationsFolder, 'meta/_journal.json'), 'utf8')) as Journal;
// Found by tag rather than taken as the last entry: main's `0017_card_sicko`
// landed on top of this one. What matters either way is that every entry before
// it has a smaller `when`, since that is what decides whether drizzle runs it.
const at = journal.entries.findIndex((e) => e.tag === '0016_card_dependency');
assert.notEqual(at, -1, 'card_dependency is in the journal');
const mine = journal.entries[at]!;
assert.ok(journal.entries.slice(0, at).every((e) => e.when < mine.when), 'the entry would be skipped');

const hasTable = (db: ReturnType<typeof openDatabase>) =>
  Boolean(db.$client.prepare(`select 1 from sqlite_master where type = 'table' and name = 'card_dependency'`).get());
const applied = (db: ReturnType<typeof openDatabase>) =>
  (db.$client.prepare('select count(*) as n from __drizzle_migrations').get() as { n: number }).n;

// --- the migration, on a database that has never been opened ---------------
{
  const db = openDatabase(join(scratch, 'fresh.db'));
  runMigrations(db);
  assert.ok(hasTable(db), 'fresh: card_dependency exists');
  assert.equal(applied(db), journal.entries.length);
  db.$client.close();
}

// --- and on one migrated up to the migration before it, with a card in it ---
{
  const before = join(scratch, 'drizzle-before');
  cpSync(config.migrationsFolder, before, { recursive: true });
  // Cut at this card's own entry rather than at the end: migrations have landed
  // on top of it since, and dropping only the last would leave a database that
  // already has the table.
  writeFileSync(
    join(before, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, at) }),
  );
  const file = join(scratch, 'existing.db');
  let db = openDatabase(file);
  migrate(db, { migrationsFolder: before });
  assert.ok(!hasTable(db));
  db.$client
    .prepare(`insert into repo (id, name, repo_path, worktree_root) values ('r1', 'old', '/tmp/old', '/tmp/old-wt')`)
    .run();
  db.$client
    .prepare(`insert into card (id, repo_id, number, title, stage, position) values ('c1', 'r1', 1, 'Old card', 'backlog', 0)`)
    .run();
  const count = applied(db);
  db.$client.close();

  db = openDatabase(file);
  runMigrations(db);
  assert.ok(hasTable(db), 'existing: card_dependency exists');
  // This one and everything merged after it.
  assert.equal(applied(db), count + (journal.entries.length - at), 'existing: the pending migrations applied');
  assert.equal((db.$client.prepare(`select title from card where id = 'c1'`).get() as { title: string }).title, 'Old card');
  db.$client.close();
}
console.log('[reeve] migration applies on a fresh and an existing database');

// --- the API --------------------------------------------------------------
const { createApp } = await import('../index.js');
const { createRepo, listRepos } = await import('../db/queries.js');

let { app, db } = createApp();
const repo =
  listRepos(db).find((r) => r.name === 'deps-check') ??
  createRepo(db, {
    name: 'deps-check', repoPath: '/tmp/deps-check', worktreeRoot: '/tmp/deps-check-worktrees', defaultBranch: 'main',
    setupCommand: null, testCommand: null, serverCommand: null,
    teardownCommand: null, finishCommand: null, laneColor: '#6b7db3',
  });

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}
const make = async (title: string, extra: object = {}) =>
  (await call<ApiCard>('POST', '/api/cards', { title, repoId: repo.id, ...extra })).json;
const detail = async (id: string) => {
  const res = await call<CardDetail>('GET', `/api/cards/${id}/detail`);
  assert.equal(res.status, 200);
  return res.json;
};
const board = async () => (await call<BoardResponse>('GET', '/api/board')).json;
const rows = () => (db.$client.prepare('select count(*) as n from card_dependency').get() as { n: number }).n;
const link = (from: ApiCard, to: ApiCard) =>
  call<{ error?: string; detail?: string }>('POST', `/api/cards/${from.id}/dependencies`, { dependsOnId: to.id });

const a = await make('Card A');
const b = await make('Card B');
const c = await make('Card C');

// C1: added, and still there once the app is built again on the same file.
assert.equal((await link(a, b)).status, 201);
assert.equal((await link(a, b)).status, 201, 'linking twice is not an error');
assert.equal(rows(), 1);
db.$client.close();
({ app, db } = createApp());
let aDetail = await detail(a.id);
assert.deepEqual(
  aDetail.card.dependsOn.map((d) => d.id),
  [b.id],
);

// C2: both directions, with a number and title to show.
assert.deepEqual(
  aDetail.dependencies.dependsOn.map((x) => [x.number, x.title]),
  [[b.number, 'Card B']],
);
const bDetail = await detail(b.id);
assert.deepEqual(bDetail.card.dependents, [a.id]);
assert.deepEqual(
  bDetail.dependencies.dependents.map((x) => [x.number, x.title]),
  [[a.number, 'Card A']],
);
let onBoard = await board();
assert.deepEqual(
  onBoard.cards.find((x) => x.id === a.id)?.dependsOn.map((d) => d.id),
  [b.id],
);
assert.deepEqual(onBoard.cards.find((x) => x.id === b.id)?.dependents, [a.id]);

// C4: a card on itself, and closing a loop, are refused with why and save nothing.
const self = await link(a, a);
assert.equal(self.status, 400);
assert.equal(self.json.error, 'a card cannot depend on itself');
assert.equal((await link(b, c)).status, 201);
const before = rows();
const loop = await link(c, a);
assert.equal(loop.status, 400);
assert.equal(loop.json.error, 'that would make a cycle');
assert.equal(loop.json.detail, `#${a.number} already depends on #${c.number}, through #${b.number}`);
const direct = await link(b, a);
assert.equal(direct.status, 400);
assert.equal(direct.json.detail, `#${a.number} already depends on #${b.number}`);
assert.equal(rows(), before, 'a refused link writes no row');
assert.deepEqual((await detail(c.id)).card.dependsOn, []);
console.log(`[reeve] refusals: "${self.json.error}" / "${loop.json.error}: ${loop.json.detail}"`);

// A loop through an archived card is still one.
const x = await make('Card X');
assert.equal((await link(c, x)).status, 201);
assert.equal((await call('POST', `/api/cards/${x.id}/archive`)).status, 200);
const hidden = await link(x, a);
assert.equal(hidden.status, 400);
assert.equal(hidden.json.detail, `#${a.number} already depends on #${x.number}, through #${b.number} → #${c.number}`);
// ...and an archived dependency still has a number and title on the detail.
assert.deepEqual(
  (await detail(c.id)).dependencies.dependsOn.map((d) => [d.title, Boolean(d.archivedAt)]),
  [['Card X', true]],
);

// Projects take no part.
const project = await make('Project', { kind: 'project' });
assert.equal((await link(a, project)).status, 400);
assert.equal((await link(project, a)).status, 400);
assert.equal((await call('POST', `/api/cards/${a.id}/dependencies`, { dependsOnId: 'nope' })).status, 400);

// C3: removed, and gone from the detail, the board and the table.
assert.equal((await call('DELETE', `/api/cards/${b.id}/dependencies/${c.id}`)).status, 200);
assert.equal((await call('DELETE', `/api/cards/${b.id}/dependencies/${c.id}`)).status, 404);
assert.deepEqual((await detail(b.id)).card.dependsOn, []);
assert.deepEqual((await detail(c.id)).dependencies.dependents, []);
onBoard = await board();
assert.deepEqual(onBoard.cards.find((x) => x.id === b.id)?.dependsOn, []);
assert.equal(
  (db.$client.prepare('select count(*) as n from card_dependency where card_id = ? and depends_on_id = ?').get(b.id, c.id) as {
    n: number;
  }).n,
  0,
);
db.$client.close();
({ app, db } = createApp());
assert.deepEqual((await detail(b.id)).card.dependsOn, [], 'still gone after a rebuild');

// C5: deleting a card takes its links with it, and the cards either side still read.
const d = await make('Card D');
const e = await make('Card E');
assert.equal((await link(d, b)).status, 201);
assert.equal((await link(e, d)).status, 201);
db.$client.prepare('delete from card where id = ?').run(d.id);
assert.equal(
  (db.$client.prepare('select count(*) as n from card_dependency where card_id = ? or depends_on_id = ?').get(d.id, d.id) as {
    n: number;
  }).n,
  0,
);
assert.deepEqual((await detail(e.id)).card.dependsOn, []);
assert.deepEqual((await detail(b.id)).card.dependents, [a.id]);
onBoard = await board();
assert.ok(!onBoard.cards.some((x) => x.dependsOn.some((dep) => dep.id === d.id) || x.dependents.includes(d.id)));

db.$client.close();
rmSync(scratch, { recursive: true, force: true });
console.log('[reeve] dependency check passed');
