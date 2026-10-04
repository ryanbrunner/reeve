/**
 * Checks that `POST /cards/:id/test` validates the card's worktree with
 * `checkWorktree`, the same as the stage-start paths, rather than trusting
 * any non-null `worktreePath` it finds stored. csrf-check.ts showed a forged
 * `/test` running a planted command against a path that was never a
 * worktree; this is the check that closes that half of it.
 *
 *   REEVE_DB=/tmp/reeve-test-worktree.db npx tsx packages/server/src/spikes/test-worktree-check.ts
 *
 * With no REEVE_DB it makes its own under /tmp rather than opening
 * data/reeve.db.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const scratch = mkdtempSync(join(tmpdir(), 'reeve-test-worktree-'));
// Before anything reads config, which fixes the database path at import.
process.env.REEVE_DB ??= join(scratch, 'app.db');
process.env.REEVE_ASSETS ??= join(scratch, 'assets');

const { createApp } = await import('../index.js');
const { createCard, createRepo } = await import('../db/queries.js');
const { card } = await import('../db/schema.js');

const { app, db } = createApp();

const repoRow = createRepo(db, {
  name: `test-worktree-check-${Date.now()}`, repoPath: join(scratch, 'repo'), worktreeRoot: join(scratch, 'worktrees'),
  defaultBranch: 'main', setupCommand: null, testCommand: 'echo test', serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: '#6b7db3',
});
const cardRow = createCard(db, { title: 'Test card', kind: 'task', repoId: repoRow.id });
// A path nothing created: the same state as a worktree removed by hand, or
// one whose directory never existed, without going through a real worktree.
db.update(card).set({ worktreePath: join(scratch, 'nonexistent-worktree') }).where(eq(card.id, cardRow.id)).run();

const testRun = await app.request(`/api/cards/${cardRow.id}/test`, { method: 'POST' });
assert.equal(testRun.status, 409, 'a stored worktreePath git no longer tracks is refused, not run against');

console.log('[reeve] test worktree check passed');
