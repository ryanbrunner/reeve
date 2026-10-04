/**
 * Checks that `POST /:id/assets` rejects a file whose bytes don't match the
 * type it declared, and that every response from the asset route — a served
 * image, a missing one — carries `X-Content-Type-Options: nosniff`.
 *
 *   REEVE_DB=/tmp/reeve-asset-content-type.db REEVE_ASSETS=/tmp/reeve-asset-content-type npx tsx packages/server/src/spikes/asset-content-type-check.ts
 *
 * With either unset it makes its own under /tmp rather than opening
 * data/reeve.db or writing into data/assets.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiCard } from '@reeve/shared';

const scratch = mkdtempSync(join(tmpdir(), 'reeve-asset-content-type-'));
// Before anything reads config, which fixes both paths at import.
process.env.REEVE_DB ??= join(scratch, 'app.db');
process.env.REEVE_ASSETS ??= join(scratch, 'assets');

const { createApp } = await import('../index.js');
const { assetsFor, createRepo } = await import('../db/queries.js');

const { app, db } = createApp();
const repo = createRepo(db, {
  name: `check-content-type-${Date.now()}`, repoPath: '/tmp/check-content-type', worktreeRoot: '/tmp/check-content-type-worktrees',
  defaultBranch: 'main', setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: '#6b7db3',
});

const create = await app.request('/api/cards', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Card', kind: 'task', repoId: repo.id }),
});
const cardId = ((await create.json()) as ApiCard).id;

const upload = (bytes: Buffer, type: string) => {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], 'upload', { type }));
  form.set('label', 'upload');
  return app.request(`/api/cards/${cardId}/assets`, { method: 'POST', body: form });
};

// A 1x1 PNG, byte for byte: real bytes for the case that should be accepted.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const html = Buffer.from('<html><body>not an image</body></html>', 'utf8');

// Labelled image/png, but it is HTML: CONTENT_TYPES would have waved this
// through before the fix, since it never looked past the declared type.
const rejected = await upload(html, 'image/png');
assert.equal(rejected.status, 415, 'bytes that are not a PNG are refused');
assert.equal(assetsFor(db, cardId).length, 0, 'no row for the refused upload');
const cardAssetDir = join(process.env.REEVE_ASSETS!, cardId);
assert.ok(!existsSync(cardAssetDir) || readdirSync(cardAssetDir).length === 0, 'nothing written to disk either');

const accepted = await upload(png, 'image/png');
assert.equal(accepted.status, 201, 'a real PNG labelled image/png still works');
const assetId = ((await accepted.json()) as { id: string }).id;

const served = await app.request(`/api/assets/${assetId}`);
assert.equal(served.status, 200);
assert.equal(served.headers.get('x-content-type-options'), 'nosniff', 'nosniff on a served asset');

const missing = await app.request('/api/assets/no-such-asset');
assert.equal(missing.status, 404);
assert.equal(missing.headers.get('x-content-type-options'), 'nosniff', 'nosniff on a 404 too');

rmSync(scratch, { recursive: true, force: true });
console.log('[reeve] asset content-type check passed');
