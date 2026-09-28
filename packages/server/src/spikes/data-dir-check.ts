/**
 * Checks where the board lives when nothing says otherwise: `data/` under the
 * package root in a checkout, `~/.reeve` in an installed copy on any platform,
 * whatever `XDG_DATA_HOME` says. And that the migrations and the built web
 * app stay beside the code either way.
 *
 * The installed case goes through `defaultDataDir`, since faking a Homebrew
 * layout from inside a checkout would test the fake. The checkout case goes
 * through `config` itself, imported with both env vars cleared. Opens no
 * database and creates no directory.
 *
 *   REEVE_DB=/tmp/reeve-datadir.db npx tsx packages/server/src/spikes/data-dir-check.ts
 *
 * The REEVE_DB is only the rule every spike follows: this one deletes it
 * before importing config, which reads the environment once, as it loads.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

delete process.env.REEVE_DB;
delete process.env.REEVE_ASSETS;
process.env.XDG_DATA_HOME = '/tmp/xdg-should-be-ignored';

const { config, defaultDataDir } = await import('../config.js');

const check = (label: string, actual: string, expected: string) => {
  console.log(`${actual === expected ? 'ok  ' : 'FAIL'} ${label}: ${actual}`);
  assert.equal(actual, expected, label);
};

check('checkout', defaultDataDir({ checkout: true, root: '/r', home: '/h' }), '/r/data');
check('install', defaultDataDir({ checkout: false, root: '/r', home: '/h' }), '/h/.reeve');
check('install, real home', defaultDataDir({ checkout: false, root: '/r', home: homedir() }), join(homedir(), '.reeve'));

// This spike runs from a checkout or a card's worktree, so config must have
// taken it for one.
assert.ok(existsSync(join(config.root, '.git')), `${config.root} has no .git; run this from a checkout`);
check('dataDir', config.dataDir, join(config.root, 'data'));
check('dbFile', config.dbFile, join(config.root, 'data', 'reeve.db'));
check('assetsDir', config.assetsDir, join(config.root, 'data', 'assets'));
check('migrationsFolder', config.migrationsFolder, join(config.root, 'packages', 'server', 'drizzle'));
check('webDist', config.webDist, join(config.root, 'packages', 'web', 'dist'));

// A second, fresh copy of the module (the query string defeats the module
// cache) with both env vars set, which is also all `reeve serve --db/--assets`
// does. Held in a variable so tsc does not try to resolve the query string.
process.env.REEVE_DB = '/tmp/elsewhere/board.db';
process.env.REEVE_ASSETS = '/tmp/elsewhere/pictures';
const fresh = '../config.js?overridden';
const overridden = ((await import(fresh)) as typeof import('../config.js')).config;
check('dbFile, REEVE_DB set', overridden.dbFile, '/tmp/elsewhere/board.db');
check('assetsDir, REEVE_ASSETS set', overridden.assetsDir, '/tmp/elsewhere/pictures');

console.log('\ndata-dir-check: all good');
