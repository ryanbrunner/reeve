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
  /** Simultaneous Claude runs. Approving four cards shouldn't launch four sessions. */
  maxConcurrentRuns: Number(process.env.REEVE_MAX_CONCURRENT ?? 3),
} as const;
