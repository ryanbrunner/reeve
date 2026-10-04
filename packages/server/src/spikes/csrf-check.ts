/**
 * Checks the `/api/*` Host/Origin guard, the JSON routes' content-type
 * check, and that `POST /cards/:id/test` validates the worktree rather than
 * trusting a stored path.
 *
 *   REEVE_DB=/tmp/reeve-csrf.db npx tsx packages/server/src/spikes/csrf-check.ts
 *
 * With no REEVE_DB it makes its own under /tmp rather than opening
 * data/reeve.db.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const scratch = mkdtempSync(join(tmpdir(), 'reeve-csrf-'));
// Before anything reads config, which fixes the database path at import.
process.env.REEVE_DB ??= join(scratch, 'app.db');

const { createApp } = await import('../index.js');
const { createCard, createRepo } = await import('../db/queries.js');
const { card } = await import('../db/schema.js');

const { app, db } = createApp();

// `/settings` is PATCHed because every field it takes is optional: nothing
// about the body itself can fail, so a 200 here means only the guard let the
// request through, and a non-200 means the guard, not the business logic
// behind it, is what refused it.
const patchSettings = (headers: Record<string, string>, body: string) =>
  app.request('/api/settings', { method: 'PATCH', headers, body });

const JSON_HEADERS = { 'content-type': 'application/json' };

// --- Host ---------------------------------------------------------------

const forgedHost = await patchSettings({ ...JSON_HEADERS, host: 'evil.com' }, '{}');
assert.equal(forgedHost.status, 403, 'a Host that is not loopback is refused');

const vitePort = await patchSettings({ ...JSON_HEADERS, host: '127.0.0.1:5173' }, '{}');
assert.equal(vitePort.status, 200, "loopback on any port — Vite's dev port included — is let through");

const ipv6 = await patchSettings({ ...JSON_HEADERS, host: '[::1]:4317' }, '{}');
assert.equal(ipv6.status, 200, 'a bracketed IPv6 loopback literal is accepted too');

// --- Origin ---------------------------------------------------------------

const forgedOrigin = await patchSettings({ ...JSON_HEADERS, origin: 'http://evil.com' }, '{}');
assert.equal(forgedOrigin.status, 403, 'an Origin that is not loopback is refused even with a good Host');

const nullOrigin = await patchSettings({ ...JSON_HEADERS, origin: 'null' }, '{}');
assert.equal(nullOrigin.status, 403, 'the literal Origin: null a sandboxed iframe sends is refused too');

const noOrigin = await patchSettings(JSON_HEADERS, '{}');
assert.equal(noOrigin.status, 200, "no Origin at all — what the CLI's and the stage runs' own fetch send — passes");

// --- content-type -----------------------------------------------------------

const plainText = await patchSettings({ origin: 'http://127.0.0.1:5173', 'content-type': 'text/plain' }, '{}');
assert.equal(plainText.status, 415, 'a body not declared application/json is refused before it is parsed');

const charset = await patchSettings(
  { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json; charset=utf-8' },
  '{}',
);
assert.equal(charset.status, 200, 'a charset parameter on application/json still passes');

// --- /cards/:id/test checks the worktree, not just that a path is stored ---

const repoRow = createRepo(db, {
  name: `csrf-check-${Date.now()}`, repoPath: '/tmp/csrf-check-repo', worktreeRoot: '/tmp/csrf-check-worktrees',
  defaultBranch: 'main', setupCommand: null, testCommand: 'echo test', serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: '#6b7db3',
});
const cardRow = createCard(db, { title: 'Test card', kind: 'task', repoId: repoRow.id });
// A path nothing created: the same state as a worktree removed by hand, or
// one whose directory never existed, without going through a real worktree.
db.update(card).set({ worktreePath: '/tmp/csrf-check-nonexistent-worktree' }).where(eq(card.id, cardRow.id)).run();

const testRun = await app.request(`/api/cards/${cardRow.id}/test`, { method: 'POST' });
assert.equal(testRun.status, 409, 'a stored worktreePath git no longer tracks is refused, not run against');

console.log('[reeve] csrf check passed');
