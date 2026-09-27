/**
 * Checks that a split's tasks keep the images pasted into the project's brief
 * once the project is deleted, without spending API credit: the split is fed
 * canned output rather than run, and the project is deleted by its row, since
 * no route hard-deletes a project with tasks under it.
 *
 *   REEVE_DB=/tmp/reeve-split-images.db REEVE_ASSETS=/tmp/reeve-split-images npx tsx packages/server/src/spikes/split-images-check.ts
 *
 * With either unset it makes its own under /tmp rather than opening
 * data/reeve.db or writing into data/assets.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { ApiCard } from '@reeve/shared';

const scratch = mkdtempSync(join(tmpdir(), 'reeve-split-images-'));
// Before anything reads config, which fixes both paths at import.
process.env.REEVE_DB ??= join(scratch, 'app.db');
process.env.REEVE_ASSETS ??= join(scratch, 'assets');

const { createApp } = await import('../index.js');
const { assetsFor, createRepo, getCard, insertAsset, tasksInProject } = await import('../db/queries.js');
const { relativeAssetPath, writeAsset } = await import('../assets/store.js');
const { card } = await import('../db/schema.js');
const { splitProjectTask } = await import('../stages/split_project.js');
type AssetKind = import('../db/schema.js').AssetKind;
type StageContext = import('../stages/types.js').StageContext;

const { app, db } = createApp();
const repo = createRepo(db, {
  name: `check-images-${Date.now()}`, repoPath: '/tmp/check-images', worktreeRoot: '/tmp/check-images-worktrees',
  defaultBranch: 'main', setupCommand: null, testCommand: null, serverCommand: null,
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

/**
 * A 1×1 PNG stored as the upload route stores one: file first, then its row.
 * Written directly rather than posted, so the check does not depend on which
 * kinds the route accepts.
 */
function store(cardId: string, kind: AssetKind, label: string): string {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const rel = relativeAssetPath(cardId, crypto.randomUUID(), 'image/png');
  writeAsset(rel, png);
  return insertAsset(db, { cardId, kind, label, path: rel, contentType: 'image/png', width: 1, height: 1 }).id;
}

const status = async (id: string) => (await app.request(`/api/assets/${id}`)).status;
const linked = (body: string) => [...body.matchAll(/\/api\/assets\/([\w-]+)/g)].map((m) => m[1]!);

const project = (await call<ApiCard>('POST', '/api/cards', { title: 'Project', kind: 'project', repoId: repo.id })).json;
const cart = store(project.id, 'pasted', 'Cart');
const checkout = store(project.id, 'pasted', 'Checkout');
const mockup = store(project.id, 'mockup', 'Mockup');

const ctx = { card: getCard(db, project.id)!, repo, worktreePath: repo.repoPath } as StageContext;
splitProjectTask.onPersist!(db, ctx, {
  tasks: [
    {
      title: 'Cart',
      body: `The cart:\n\n![Cart](/api/assets/${cart})\n\nAgain: ![Cart](/api/assets/${cart})`,
      repo: null, criteria: [], dependsOn: [],
    },
    {
      title: 'Both',
      body: `![Cart](/api/assets/${cart}) and ![Checkout](/api/assets/${checkout})`,
      repo: null, criteria: [], dependsOn: [],
    },
    { title: 'Mockup', body: `![Mockup](/api/assets/${mockup})`, repo: null, criteria: [], dependsOn: [] },
    { title: 'Nowhere', body: '![Gone](/api/assets/no-such-asset)', repo: null, criteria: [], dependsOn: [] },
    { title: 'Plain', body: 'No pictures.', repo: null, criteria: [], dependsOn: [] },
  ],
}, 'run');

const tasks = new Map(tasksInProject(db, project.id).map((t) => [t.title, t]));
const cartTask = tasks.get('Cart')!;
const bothTask = tasks.get('Both')!;

// Each task has a copy of its own, linked everywhere the original was, and
// one copy however many times it is linked.
const [firstLink, secondLink] = linked(cartTask.body);
assert.ok(firstLink && firstLink !== cart, 'the cart task links a copy');
assert.equal(secondLink, firstLink, 'an image linked twice is copied once');
assert.deepEqual(assetsFor(db, cartTask.id).map((a) => [a.id, a.kind, a.label]), [[firstLink, 'pasted', 'Cart']]);
assert.ok(cartTask.body.startsWith('The cart:\n\n![Cart]('), 'the rest of the body is untouched');

const bothLinks = linked(bothTask.body);
assert.equal(bothLinks.length, 2);
assert.ok(!bothLinks.includes(cart) && !bothLinks.includes(checkout));
assert.notEqual(bothLinks[0], firstLink, 'two tasks get two copies');
assert.equal(assetsFor(db, bothTask.id).length, 2);
for (const a of assetsFor(db, bothTask.id)) assert.ok(a.path.startsWith(bothTask.id), 'filed under the task');

// A mockup's link and a link to nothing are left as Claude wrote them.
assert.equal(tasks.get('Mockup')!.body, `![Mockup](/api/assets/${mockup})`);
assert.equal(assetsFor(db, tasks.get('Mockup')!.id).length, 0);
assert.equal(tasks.get('Nowhere')!.body, '![Gone](/api/assets/no-such-asset)');
assert.equal(tasks.get('Plain')!.body, 'No pictures.');

// Delete the project: its own images go, and the tasks' copies still serve.
db.delete(card).where(eq(card.id, project.id)).run();
assert.equal(getCard(db, project.id), undefined);
assert.equal(await status(cart), 404);
for (const id of [firstLink, ...bothLinks]) assert.equal(await status(id!), 200, `copy ${id} still serves`);
assert.equal(getCard(db, cartTask.id)?.projectId, null, 'the task outlives its project');

rmSync(scratch, { recursive: true, force: true });
console.log('[reeve] split images check passed');
