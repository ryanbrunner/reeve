import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { openDatabase } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { archiveCard, cardEventsFor, createCard, createRepo, getCard, restoreCard } from '../db/queries.js';
import { card as cardTable } from '../db/schema.js';
import { archiveMergedCards } from '../pullRequest.js';
import { runRegistry } from '../runs/registry.js';

/**
 * The sweep that archives merged cards, against a throwaway database. Every
 * sweep is given its `now`, so nothing here waits out the real delay.
 */

const note = (l: string, v: unknown) => console.log(`${l.padEnd(40)}: ${v}`);
const check = (l: string, ok: boolean) => {
  note(l, ok ? 'ok' : 'FAILED');
  if (!ok) process.exitCode = 1;
};

const root = mkdtempSync(join(tmpdir(), 'reeve-archive-'));
const db = openDatabase(join(root, 'reeve.db'));
runMigrations(db);
const repo = createRepo(db, {
  name: 'auto-archive-check', repoPath: join(root, 'repo'), worktreeRoot: join(root, 'worktrees'), defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null,
});

const now = new Date();
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
const delay = config.autoArchiveAfterMs;
note('archive after (ms)', delay);

/** A Done card, merged at `mergedAt` if given. */
function card(title: string, mergedAt?: Date) {
  const c = createCard(db, { title, repoId: repo.id, stage: 'done' });
  if (mergedAt) db.update(cardTable).set({ mergedAt }).where(eq(cardTable.id, c.id)).run();
  return c.id;
}
const isArchived = (id: string) => getCard(db, id)!.archivedAt !== null;
const autoArchives = (id: string) =>
  cardEventsFor(db, id).filter((e) => e.kind === 'archived' && e.meta?.['reason'] === 'merged');

const stale = card('Merged a while ago', new Date(now.getTime() - delay - 1_000));
const fresh = card('Just merged', new Date(now.getTime() - delay + 60_000));
const busy = card('Merged, still running', new Date(now.getTime() - delay - 1_000));
const open = card('Never merged');
// Archived by hand while its pull request was open, then back, then merged.
const handled = card('Archived by hand once');
archiveCard(db, handled);
restoreCard(db, handled);
db.update(cardTable).set({ mergedAt: minutesAgo(60) }).where(eq(cardTable.id, handled)).run();

runRegistry.register({ runId: 'fake-run', kind: 'server', cardId: busy, stop: async () => {} });
const swept = archiveMergedCards(db, now);
note('archived in the first sweep', swept.map((c) => c.title).join(', '));

check('merged past the cutoff is archived', isArchived(stale));
check('its archive is marked as automatic', autoArchives(stale).length === 1);
check('merged inside the window is kept', !isArchived(fresh));
check('card with a live run is skipped', !isArchived(busy));
check('card with no merge is untouched', !isArchived(open));
check('hand archive earlier does not block it', isArchived(handled) && autoArchives(handled).length === 1);

runRegistry.unregister('fake-run');
archiveMergedCards(db, now);
check('run gone, the card follows', isArchived(busy));

check('window card goes once it passes', archiveMergedCards(db, new Date(now.getTime() + 60_000)).some((c) => c.id === fresh));

restoreCard(db, stale);
const later = new Date(now.getTime() + 24 * 60 * 60_000);
archiveMergedCards(db, later);
check('restored after an auto archive stays', !isArchived(stale));
check('and is not archived a second time', autoArchives(stale).length === 1);
check('unmerged card still untouched a day on', !isArchived(open));

rmSync(root, { recursive: true, force: true });
console.log(process.exitCode ? '\nSOME AUTO-ARCHIVE BEHAVIOURS FAILED' : '\nall auto-archive behaviours verified');
