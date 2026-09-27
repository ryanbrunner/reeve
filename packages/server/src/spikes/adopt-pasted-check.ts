/**
 * Checks the pass that gives tasks split before the split made copies their
 * own copies of the project's pasted images: each such task, archived ones
 * too, links a copy of its own, row and file, and survives the project being
 * deleted. The project's images, a card's own, a mockup and a link whose file
 * has gone are left as they are, `updatedAt` is not touched, and a second pass
 * does nothing.
 *
 * The old tasks are made directly with the project's links in their bodies,
 * as a split before the change left them, and the project is deleted by its
 * row, since no route hard-deletes a project with tasks under it.
 *
 *   REEVE_DB=/tmp/reeve-adopt.db REEVE_ASSETS=/tmp/reeve-adopt npx tsx packages/server/src/spikes/adopt-pasted-check.ts
 *
 * With either unset it makes its own under /tmp rather than opening
 * data/reeve.db or writing into data/assets.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'reeve-adopt-'));
// Before anything reads config, which fixes both paths at import.
process.env.REEVE_DB ??= join(scratch, 'app.db');
process.env.REEVE_ASSETS ??= join(scratch, 'assets');

const { eq } = await import('drizzle-orm');
const { createApp } = await import('../index.js');
const {
  archiveCard, assetsFor, cardsLinkingOthersPastedAssets, createCard, createRepo, getAsset, getCard, insertAsset,
} = await import('../db/queries.js');
const { asset, card } = await import('../db/schema.js');
const { absoluteAssetPath, deleteAsset, relativeAssetPath, writeAsset } = await import('../assets/store.js');
const { adoptPastedImages } = await import('../assets/pasted.js');
type AssetKind = import('../db/schema.js').AssetKind;

const { app, db } = createApp();
const name = `check-adopt-${Date.now()}`;
const repo = createRepo(db, {
  name, repoPath: `/tmp/${name}`, worktreeRoot: `/tmp/${name}-worktrees`, defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: '#6b7db3',
});

/** A picture with its file on disk, and the Markdown a brief links it by. */
function picture(cardId: string, label: string, kind: AssetKind = 'pasted') {
  const path = relativeAssetPath(cardId, crypto.randomUUID(), 'image/png');
  writeAsset(path, Buffer.from(`not really a png: ${label}`));
  const row = insertAsset(db, { cardId, kind, label, path, contentType: 'image/png', width: 1, height: 1 });
  return { id: row.id, path, link: `![${label}](/api/assets/${row.id})` };
}

const status = async (id: string) => (await app.request(`/api/assets/${id}`)).status;
const linked = (body: string) => [...body.matchAll(/\/api\/assets\/([\w-]+)/g)].map((m) => m[1]!);
const body = (id: string) => getCard(db, id)!.body;

// Made with their bodies already written: a project's first brief saved over
// the API would start a split, which is a Claude run.
const project = createCard(db, { title: 'Project', kind: 'project', repoId: repo.id, body: 'pending' });
const cart = picture(project.id, 'Cart');
const checkout = picture(project.id, 'Checkout');
const mockup = picture(project.id, 'Mockup', 'mockup');
const gone = picture(project.id, 'Gone');
deleteAsset(gone.path);
db.update(card).set({ body: `${cart.link}\n\n${checkout.link}` }).where(eq(card.id, project.id)).run();

const task = (title: string, text: string) =>
  createCard(db, { title, repoId: repo.id, projectId: project.id, body: text });
const both = task('Both', `The cart:\n\n${cart.link}\n\nAgain: ${cart.link}\n\nAnd ${checkout.link}`);
const archived = task('Archived', `Checkout: ${checkout.link}`);
archiveCard(db, archived.id);
const mixed = task('Mixed', `${mockup.link}\n\n${gone.link}`);
const own = createCard(db, { title: 'Own', repoId: repo.id, body: 'pending' });
const ownPicture = picture(own.id, 'Mine');
db.update(card).set({ body: `Mine: ${ownPicture.link}` }).where(eq(card.id, own.id)).run();

const updatedBefore = getCard(db, both.id)!.updatedAt.getTime();
const projectBody = body(project.id);
const mixedBody = body(mixed.id);
const ownBody = body(own.id);

// Found by the query alone, not by the copy passing a card's own images over:
// neither the project nor Own is a candidate.
const candidates = () => cardsLinkingOthersPastedAssets(db).map((c) => c.title).sort();
assert.deepEqual(candidates(), ['Archived', 'Both', 'Mixed']);

assert.equal(adoptPastedImages(db), 2, 'the two tasks linking pasted images are rewritten');
assert.deepEqual(candidates(), ['Mixed'], 'only the link to a missing file is left to find');

// Each task links a copy of its own, one per image however often it is linked.
const bothLinks = linked(body(both.id));
assert.equal(bothLinks.length, 3);
assert.equal(bothLinks[0], bothLinks[1], 'an image linked twice is copied once');
assert.ok(!bothLinks.includes(cart.id) && !bothLinks.includes(checkout.id), 'no link to the project is left');
assert.ok(body(both.id).startsWith('The cart:\n\n![Cart]('), 'the rest of the body is untouched');
assert.deepEqual(assetsFor(db, both.id).map((a) => a.label).sort(), ['Cart', 'Checkout']);
for (const a of assetsFor(db, both.id)) {
  assert.equal(a.kind, 'pasted');
  assert.ok(a.path.startsWith(both.id), 'filed under the task');
  assert.ok(existsSync(absoluteAssetPath(a.path)), 'with its file');
}
const [archivedLink] = linked(body(archived.id));
assert.ok(archivedLink && archivedLink !== checkout.id, 'an archived task gets a copy too');
assert.equal(getAsset(db, archivedLink)?.cardId, archived.id);
assert.equal(getCard(db, both.id)!.updatedAt.getTime(), updatedBefore, 'updatedAt is left alone');

// Everything else is as it was.
assert.equal(body(project.id), projectBody, "the project's brief is untouched");
assert.ok(existsSync(absoluteAssetPath(cart.path)) && getAsset(db, cart.id), "the project's image stays");
assert.equal(body(mixed.id), mixedBody, 'a mockup and a missing file are left as written');
assert.equal(assetsFor(db, mixed.id).length, 0);
assert.equal(body(own.id), ownBody, "a card's own image is not copied");
assert.equal(assetsFor(db, own.id).length, 1);

// Again, as the next boot would: nothing left to copy.
const rows = db.select().from(asset).all().length;
assert.equal(adoptPastedImages(db), 0, 'a second pass rewrites nothing');
assert.equal(db.select().from(asset).all().length, rows, 'and adds no rows');

// Delete the project: its own images go, and the tasks' copies still serve.
db.delete(card).where(eq(card.id, project.id)).run();
assert.equal(await status(cart.id), 404);
for (const id of [...bothLinks, archivedLink]) assert.equal(await status(id), 200, `copy ${id} still serves`);

rmSync(scratch, { recursive: true, force: true });
console.log('[reeve] adopt pasted check passed');
