import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { DEFAULT_PORT } from '@reeve/shared';

const root = resolve(import.meta.dirname, '../../..');

/**
 * Where the board lives when neither `REEVE_DB` nor `REEVE_ASSETS` says.
 *
 * A checkout keeps it in its own gitignored `data/`, so development does not
 * change. Anything else is an installed copy, and gets `~/.reeve` on every
 * platform: a Homebrew install sits in the Cellar, which is no place to write,
 * and `brew upgrade` puts each version in a new directory, so a board kept
 * beside the code would be left behind by every upgrade.
 *
 * Pure, and given the answers rather than asking, so a spike can check the
 * installed case from inside a checkout.
 */
export function defaultDataDir({ checkout, root, home }: { checkout: boolean; root: string; home: string }): string {
  return checkout ? resolve(root, 'data') : resolve(home, '.reeve');
}

// "Is there a .git", rather than sniffing the path for a Cellar or
// node_modules, so it holds for any packaging. In a card's worktree `.git` is
// a file rather than a directory, and still counts: every worktree and every
// spike run in one keeps its `data/`.
const dataDir = defaultDataDir({ checkout: existsSync(resolve(root, '.git')), root, home: homedir() });

export const config = {
  root,
  /**
   * The default home of the database and assets. Only a default: the two env
   * vars are independent of it and of each other. Nothing creates it here,
   * since importing this module must not touch the disk; `openDatabase` does,
   * on first boot.
   */
  dataDir,
  dbFile: process.env.REEVE_DB ?? resolve(dataDir, 'reeve.db'),
  /** Mockups and screenshots, beside the database. Blobs do not belong in SQLite. */
  assetsDir: process.env.REEVE_ASSETS ?? resolve(dataDir, 'assets'),
  // Part of the install rather than the user's board, so these stay beside the
  // code wherever the board goes.
  migrationsFolder: resolve(root, 'packages/server/drizzle'),
  webDist: resolve(root, 'packages/web/dist'),
  port: Number(process.env.REEVE_PORT ?? DEFAULT_PORT),
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
   * How often VIBES MODE looks at the board. Each pass moves any given card at
   * most one step, so this is also the pace the board advances at.
   */
  vibesSweepMs: Number(process.env.REEVE_VIBES_SWEEP_MS ?? 2_000),
} as const;
