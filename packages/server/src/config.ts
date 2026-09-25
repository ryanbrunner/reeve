import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');

export const config = {
  root,
  dbFile: process.env.REEVE_DB ?? resolve(root, 'data/reeve.db'),
  /** Mockups and screenshots, beside the database. Blobs do not belong in SQLite. */
  assetsDir: process.env.REEVE_ASSETS ?? resolve(root, 'data/assets'),
  migrationsFolder: resolve(root, 'packages/server/drizzle'),
  webDist: resolve(root, 'packages/web/dist'),
  port: Number(process.env.REEVE_PORT ?? 4317),
  /** Loopback only: there is no auth and this runs arbitrary code in your repos. */
  hostname: '127.0.0.1',
  /**
   * Simultaneous Claude runs. Approving four cards shouldn't launch four sessions.
   * Only the default: the Settings screen stores its own, which wins.
   */
  maxConcurrentRuns: Number(process.env.REEVE_MAX_CONCURRENT ?? 3),
  /** How often GitHub is asked whether a card's open pull request has merged. */
  mergeSyncMs: Number(process.env.REEVE_MERGE_SYNC_MS ?? 60_000),
  /** How long a merged card stays on the board before it is archived. Checked on the merge-sync tick. */
  autoArchiveAfterMs: Number(process.env.REEVE_AUTO_ARCHIVE_MS ?? 600_000),
  /**
   * How often SICKO MODE looks at the board. Each pass moves any given card at
   * most one step, so this is also the pace the board advances at.
   */
  sickoSweepMs: Number(process.env.REEVE_SICKO_SWEEP_MS ?? 2_000),
} as const;
