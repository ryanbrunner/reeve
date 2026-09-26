/**
 * Checks that saving a brief deletes the images pasted into it that nothing
 * links any more, row and file, and keeps every other picture: one the brief
 * still links, one a split task's brief still links after the project's has
 * dropped it, one pasted too recently to judge, a mockup, and another card's.
 * A save that leaves the body out prunes nothing.
 *
 * The pasted rows are inserted directly, backdated past the grace period,
 * since uploading one with `kind=pasted` is the brief editor's route.
 *
 *   REEVE_DB=/tmp/reeve-pasted.db npx tsx packages/server/src/spikes/pasted-prune-check.ts
 *
 * With no REEVE_DB it makes its own under /tmp rather than opening
 * data/reeve.db, and its images go beside it rather than into data/assets.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'reeve-pasted-'));
process.env.REEVE_DB ??= join(scratch, 'app.db');
process.env.REEVE_ASSETS ??= join(dirname(process.env.REEVE_DB), 'assets');

const { eq } = await import('drizzle-orm');
const { createApp } = await import('../index.js');
const { createCard, createRepo, getAsset, insertAsset } = await import('../db/queries.js');
const { asset } = await import('../db/schema.js');
const { absoluteAssetPath, relativeAssetPath, writeAsset } = await import('../assets/store.js');

const { app, db } = createApp();

const name = `check-pasted-${Date.now()}`;
const repo = createRepo(db, {
  name, repoPath: `/tmp/${name}`, worktreeRoot: `/tmp/${name}-worktrees`, defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: '#6b7db3',
});

async function patch(id: string, body: unknown) {
  const res = await app.request(`/api/cards/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
}

const DAY_AGO = new Date(Date.now() - 24 * 60 * 60 * 1000);

/** A picture with its file on disk, old enough to prune unless `fresh`. */
function picture(cardId: string, label: string, opts: { kind?: 'pasted' | 'mockup'; fresh?: boolean } = {}) {
  const row = insertAsset(db, {
    cardId, kind: opts.kind ?? 'pasted', label, path: 'pending', contentType: 'image/png',
  });
  const path = relativeAssetPath(cardId, row.id, 'image/png');
  writeAsset(path, Buffer.from('not really a png'));
  db.update(asset).set({ path, ...(opts.fresh ? {} : { createdAt: DAY_AGO }) }).where(eq(asset.id, row.id)).run();
  return { id: row.id, path, link: `![${label}](/api/assets/${row.id})` };
}

const kept = (p: { id: string; path: string }) => !!getAsset(db, p.id) && existsSync(absoluteAssetPath(p.path));
const gone = (p: { id: string; path: string }) => !getAsset(db, p.id) && !existsSync(absoluteAssetPath(p.path));

// Made with their bodies already written: a project's first brief saved over
// the API would start a split, which is a Claude run.
const project = createCard(db, { title: 'Project', kind: 'project', repoId: repo.id, body: 'pending' });
const other = createCard(db, { title: 'Other', repoId: repo.id, body: 'Nothing pasted here.' });

const removed = picture(project.id, 'removed');
const linked = picture(project.id, 'linked');
const inTask = picture(project.id, 'in a task');
const fresh = picture(project.id, 'fresh', { fresh: true });
const mockup = picture(project.id, 'mockup', { kind: 'mockup' });
const othersOrphan = picture(other.id, "another card's");

createCard(db, { title: 'Task', repoId: repo.id, projectId: project.id, body: `Copied from the project:\n\n${inTask.link}` });
await patch(project.id, { body: `Before.\n\n${removed.link}\n\n${linked.link}\n\n${inTask.link}` });
assert.ok([removed, linked, inTask, fresh, mockup, othersOrphan].every(kept), 'everything linked or exempt survives');

// Renamed, not rewritten: nothing it links has changed, so nothing is judged,
// not even an unlinked image old enough to go.
db.update(asset).set({ createdAt: DAY_AGO }).where(eq(asset.id, fresh.id)).run();
await patch(project.id, { title: 'Project, renamed' });
assert.ok(kept(fresh), 'a save without a body prunes nothing');
db.update(asset).set({ createdAt: new Date() }).where(eq(asset.id, fresh.id)).run();

await patch(project.id, { body: `After.\n\n${linked.link}` });
assert.ok(gone(removed), 'an image taken out of the brief goes, row and file');
assert.ok(kept(linked), 'one still in it stays');
assert.ok(kept(inTask), "one a task's brief still links stays");
assert.ok(kept(fresh), 'one inside the grace period stays');
assert.ok(kept(mockup), 'a mockup is never a pasted image');
assert.ok(kept(othersOrphan), "another card's images are its own save's business");

// The other card's orphan goes when that card's own brief is saved.
await patch(other.id, { body: 'Still nothing pasted here.' });
assert.ok(gone(othersOrphan), "and goes on that card's own save");

console.log('[reeve] pasted prune check passed');
