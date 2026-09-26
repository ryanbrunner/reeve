import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { createCard, createRepo, getCard, updateRepo } from '../db/queries.js';
import { card as cardTable } from '../db/schema.js';
import { syncMergedPullRequests } from '../pullRequest.js';

/**
 * A repo's "keep the default branch up to date", against a throwaway repo
 * whose `origin` is a bare repo on disk and whose `gh` is a script that says
 * every pull request asked about has merged. Proves that with the switch off
 * the local `main` never moves; that with it on, a merge the sync notices
 * fast-forwards `main` in the checkout that has it, or moves the ref alone
 * when the checkout is on another branch; and that a `main` with commits of
 * its own, or a pull request merged into another branch, is left alone.
 *
 *   npx tsx packages/server/src/spikes/sync-branch-check.ts
 *
 * It needs no REEVE_DB: its database is in the scratch directory.
 */

const note = (l: string, v: unknown) => console.log(`${l.padEnd(52)}: ${v}`);
const check = (l: string, ok: boolean) => {
  note(l, ok ? 'ok' : 'FAILED');
  if (!ok) process.exitCode = 1;
};

const root = mkdtempSync(join(tmpdir(), 'reeve-sync-branch-'));
const repoPath = join(root, 'repo');
const other = join(root, 'other');
const origin = join(root, 'origin.git');
const bin = join(root, 'bin');
const ghState = join(root, 'gh-state');
for (const dir of [repoPath, bin, ghState]) mkdirSync(dir);

const run = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: 'pipe' }).trim();
const g = (...a: string[]) => run(repoPath, ...a);
const commit = (cwd: string, file: string, msg: string) => {
  writeFileSync(join(cwd, file), `${msg}\n`);
  run(cwd, 'add', '-A'); run(cwd, 'commit', '-qm', msg);
  return run(cwd, 'rev-parse', 'HEAD');
};

g('init', '-q', '-b', 'main');
g('config', 'user.email', 't@t.t'); g('config', 'user.name', 'T');
commit(repoPath, 'README.md', 'base');
execFileSync('git', ['init', '-q', '--bare', origin]);
g('remote', 'add', 'origin', origin);
g('push', '-q', 'origin', 'main');
g('fetch', '-q', 'origin');

execFileSync('git', ['clone', '-q', origin, other]);
run(other, 'config', 'user.email', 'o@o.o'); run(other, 'config', 'user.name', 'O');

// Only `pr view <url>` is asked for here, answered from a file named for the URL.
writeFileSync(join(bin, 'gh'), `#!/bin/sh
if [ "$1 $2" = "pr view" ]; then
  key=$(printf '%s' "$3" | tr '/:' '__')
  if [ -f "$FAKE_GH_STATE/$key" ]; then cat "$FAKE_GH_STATE/$key"; exit 0; fi
  echo "no pull requests found" >&2; exit 1
fi
echo "fake gh: unexpected $*" >&2; exit 2
`);
chmodSync(join(bin, 'gh'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.FAKE_GH_STATE = ghState;

const db = openDatabase(join(root, 'reeve.db'));
runMigrations(db);
const repo = createRepo(db, {
  name: 'sync-branch-check', repoPath, worktreeRoot: join(root, 'worktrees'), defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null,
});
check('the switch is off by default', repo.syncDefaultBranch === false);

let prs = 0;
/**
 * A pull request landing on GitHub, for a Done card that opened it: `origin`
 * moves, `gh` says merged, and the local checkout has heard of neither until
 * the next sync.
 */
function merge(title: string, base = 'main') {
  const sha = commit(other, `${title.replace(/\W+/g, '-')}.txt`, title);
  run(other, 'push', '-q', 'origin', 'main');
  const url = `https://github.com/acme/widgets/pull/${++prs}`;
  writeFileSync(
    join(ghState, url.replace(/[/:]/g, '_')),
    JSON.stringify({ state: 'MERGED', mergedAt: new Date().toISOString(), mergeCommit: { oid: sha }, baseRefName: base, mergeable: 'UNKNOWN' }),
  );
  const c = createCard(db, { title, repoId: repo.id, stage: 'done' });
  db.update(cardTable).set({ prUrl: url, prNumber: prs, prOpenedAt: new Date() }).where(eq(cardTable.id, c.id)).run();
  return { card: c, sha };
}

// --- 1. Off: the sync notices the merge and leaves main alone ---------------
const before1 = g('rev-parse', 'main');
const one = merge('first, with the switch off');
await syncMergedPullRequests(db);
check('off: the card is marked merged', getCard(db, one.card.id)?.mergedAt != null);
check('off: local main unchanged', g('rev-parse', 'main') === before1);
check('off: origin/main fetched all the same', g('rev-parse', 'origin/main') === one.sha);

// --- 2. On, main checked out and clean: fast-forwarded in place --------------
updateRepo(db, repo.id, { syncDefaultBranch: true });
const two = merge('second, with the switch on');
await syncMergedPullRequests(db);
check('on: local main is what origin has', g('rev-parse', 'main') === two.sha);
check('on: the checkout has the merged file', existsSync(join(repoPath, 'second-with-the-switch-on.txt')));
check('on: the earlier merge came along too', existsSync(join(repoPath, 'first-with-the-switch-off.txt')));
check('on: the working tree is clean', g('status', '--porcelain') === '');

// --- 3. On, the checkout on another branch: the ref moves, the tree does not -
g('checkout', '-q', '-b', 'feature');
const feature = commit(repoPath, 'feature.txt', 'work in progress');
const three = merge('third, while on a feature branch');
await syncMergedPullRequests(db);
check('elsewhere: local main is what origin has', g('rev-parse', 'main') === three.sha);
check('elsewhere: HEAD is still the feature branch', g('rev-parse', '--abbrev-ref', 'HEAD') === 'feature' && g('rev-parse', 'HEAD') === feature);
check('elsewhere: the tree lacks the merged file', !existsSync(join(repoPath, 'third-while-on-a-feature-branch.txt')));
g('checkout', '-q', 'main');

// --- 4. A pull request merged into another branch leaves main alone ---------
const before4 = g('rev-parse', 'main');
const four = merge('fourth, into develop', 'develop');
await syncMergedPullRequests(db);
check('other base: the card is marked merged', getCard(db, four.card.id)?.mergedAt != null);
check('other base: local main unchanged', g('rev-parse', 'main') === before4);

// --- 5. A main with commits of its own is the person's to reconcile ---------
const unpushed = commit(repoPath, 'local-only.txt', 'unpushed, on local main only');
merge('fifth, while main has diverged');
await syncMergedPullRequests(db);
check('diverged: local main unchanged', g('rev-parse', 'main') === unpushed);

note('scratch', root);
