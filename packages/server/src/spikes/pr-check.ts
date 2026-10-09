import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { cardEventsFor, createCard, createRepo, getCard, moveCard } from '../db/queries.js';
import { card as cardTable } from '../db/schema.js';
import { createWorktree, listWorktrees } from '../git/worktree.js';
import { isOpeningPr, maybeOpenPullRequest, openPullRequest } from '../pullRequest.js';

/**
 * Every path through opening a pull request, against a throwaway repo whose
 * `origin` is a bare repo on disk and whose `gh` is a script that writes down
 * what it was asked. Nothing here reaches GitHub: how the real `gh` behaves
 * is only proven by trying a real repository.
 */

const note = (l: string, v: unknown) => console.log(`${l.padEnd(40)}: ${v}`);
const check = (l: string, ok: boolean) => {
  note(l, ok ? 'ok' : 'FAILED');
  if (!ok) process.exitCode = 1;
};

const root = mkdtempSync(join(tmpdir(), 'reeve-pr-'));
const repoPath = join(root, 'repo');
const origin = join(root, 'origin.git');
const worktreeRoot = join(root, 'worktrees');
const bin = join(root, 'bin');
const ghState = join(root, 'gh-state');
const ghLog = join(root, 'gh.log');
for (const dir of [repoPath, worktreeRoot, bin, ghState]) mkdirSync(dir);

const run = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
const g = (...a: string[]) => run(repoPath, ...a);
g('init', '-q', '-b', 'main');
g('config', 'user.email', 't@t.t'); g('config', 'user.name', 'T');
writeFileSync(join(repoPath, 'README.md'), '# base\n');
g('add', '-A'); g('commit', '-qm', 'base');
execFileSync('git', ['init', '-q', '--bare', origin]);
g('remote', 'add', 'origin', origin);
g('push', '-q', 'origin', 'main');

// Arguments are written unit- and record-separated, so a title or body with
// spaces or newlines in it reads back exactly as it was passed.
writeFileSync(join(bin, 'gh'), `#!/bin/sh
printf '%s\\037' "$@" >> "$FAKE_GH_LOG"; printf '\\036' >> "$FAKE_GH_LOG"
if [ "$1 $2" = "pr view" ]; then
  key=$(printf '%s' "$3" | tr '/' '_')
  if [ -f "$FAKE_GH_STATE/$key" ]; then cat "$FAKE_GH_STATE/$key"; exit 0; fi
  echo "no pull requests found for branch \\"$3\\"" >&2; exit 1
fi
if [ "$1 $2" = "pr create" ]; then
  if [ -n "$FAKE_GH_FAIL" ]; then echo "$FAKE_GH_FAIL" >&2; exit 4; fi
  head=""
  while [ $# -gt 0 ]; do
    case "$1" in --head) head="$2"; shift 2;; *) shift;; esac
  done
  n=$(( $(ls "$FAKE_GH_STATE" | wc -l) + 1 ))
  url="https://github.com/acme/widgets/pull/$n"
  key=$(printf '%s' "$head" | tr '/' '_')
  printf '{"url":"%s","number":%d,"state":"OPEN"}' "$url" "$n" > "$FAKE_GH_STATE/$key"
  echo "$url"; exit 0
fi
echo "fake gh: unexpected $*" >&2; exit 2
`);
chmodSync(join(bin, 'gh'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.FAKE_GH_LOG = ghLog;
process.env.FAKE_GH_STATE = ghState;

const ghCalls = () =>
  existsSync(ghLog)
    ? readFileSync(ghLog, 'utf8').split('\x1e').filter(Boolean).map((r) => r.split('\x1f').filter((_, i, a) => i < a.length - 1))
    : [];
const creates = () => ghCalls().filter((a) => a[0] === 'pr' && a[1] === 'create');
const remoteSha = (branch: string) => {
  try {
    return execFileSync('git', ['--git-dir', origin, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return null;
  }
};
const events = (cardId: string, kind: string) => cardEventsFor(db, cardId).filter((e) => e.kind === kind);

const db = openDatabase(join(root, 'reeve.db'));
runMigrations(db);
const repo = createRepo(db, {
  name: 'pr-check', repoPath, worktreeRoot, defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null,
});

/** A card with a worktree and, unless told otherwise, one commit — as In Progress would leave it. */
async function card(title: string, files: Record<string, string> = {}) {
  const c = createCard(db, { title, repoId: repo.id, stage: 'testing' });
  const wt = await createWorktree({ repoPath, worktreeRoot, cardId: c.id, title, base: 'main' });
  db.update(cardTable)
    .set({ worktreePath: wt.path, branchName: wt.branch, baseSha: wt.baseSha })
    .where(eq(cardTable.id, c.id))
    .run();
  for (const [name, body] of Object.entries(files)) writeFileSync(join(wt.path, name), body);
  if (Object.keys(files).length) {
    run(wt.path, 'add', '-A');
    run(wt.path, 'commit', '-qm', `work on ${title}`);
  }
  // What every stage leaves behind, untracked: must not count as unsaved work.
  mkdirSync(join(wt.path, '.reeve'));
  writeFileSync(join(wt.path, '.reeve', 'plan.md'), '# plan\n');
  return { id: c.id, ...wt };
}

const intoDone = (id: string) => moveCard(db, id, 'release', 0)!;

/** The automatic path, as the move route takes it: not awaited, so wait here. */
async function settle(id: string) {
  for (let i = 0; i < 500 && isOpeningPr(id); i++) await new Promise((r) => setTimeout(r, 20));
}

// --- entering Release opens a pull request -------------------------------------
{
  const wt = await card('Add a greeting', { 'greeting.txt': 'hello\n' });
  maybeOpenPullRequest(db, intoDone(wt.id), repo);
  check('attempt visible as soon as it starts', isOpeningPr(wt.id));
  await settle(wt.id);
  check('attempt finished', !isOpeningPr(wt.id));

  const head = run(wt.path, 'rev-parse', 'HEAD').trim();
  check('branch landed in origin', remoteSha(wt.branch) === head);
  const after = getCard(db, wt.id)!;
  note('pull request', after.prUrl);
  check('pull request stored on the card', after.prUrl === 'https://github.com/acme/widgets/pull/1' && after.prNumber === 1);
  check('pr_opened written', events(wt.id, 'pr_opened').length === 1);

  const [create] = creates();
  const arg = (flag: string) => (create ? create[create.indexOf(flag) + 1] : undefined);
  check('one gh pr create', creates().length === 1);
  check('opened against the default branch', arg('--base') === 'main' && arg('--head') === wt.branch);
  check('titled with the card', arg('--title') === 'Add a greeting');
  check('body names the card', arg('--body')?.includes('Reeve #') ?? false);
  check('ready for review, not a draft', !create?.includes('--draft'));

  // Out of Release and back in, with a new commit: pushes, but no second PR.
  moveCard(db, wt.id, 'testing', 0);
  writeFileSync(join(wt.path, 'greeting.txt'), 'hello again\n');
  run(wt.path, 'commit', '-qam', 'review feedback');
  maybeOpenPullRequest(db, intoDone(wt.id), repo);
  await settle(wt.id);
  check('still exactly one gh pr create', creates().length === 1);
  check('new commit pushed to the same branch', remoteSha(wt.branch) === run(wt.path, 'rev-parse', 'HEAD').trim());
  check('re-entry recorded as a push to the PR', events(wt.id, 'pr_opened')[0]?.meta?.['reused'] === true);
  check('same pull request on the card', getCard(db, wt.id)!.prNumber === 1);

  // A drag and a retry at once: only one of them gets to talk to GitHub.
  const both = await Promise.all([openPullRequest(db, getCard(db, wt.id)!, repo), openPullRequest(db, getCard(db, wt.id)!, repo)]);
  check('concurrent second attempt refused', both[0].ok && !both[1].ok && both[1].status === 409);

  check('worktree still on disk', existsSync(wt.path));
  check('worktree still listed', (await listWorktrees(repoPath)).some((r) => r.branch === wt.branch));
  check('branch still exists', g('branch', '--list', wt.branch).trim() !== '');
}

// --- refusals ------------------------------------------------------------------
{
  const wt = await card('Dirty card', { 'dirty.txt': 'a\n' });
  writeFileSync(join(wt.path, 'dirty.txt'), 'edited, never committed\n');
  const before = creates().length;
  const result = await openPullRequest(db, intoDone(wt.id), repo);
  note('dirty refusal', result.ok ? 'opened' : `${result.error}: ${result.detail}`);
  check('dirty tree refused', !result.ok && result.error === 'the card has uncommitted changes');
  check('dirty tree not pushed', remoteSha(wt.branch) === null && creates().length === before);
  check('dirty refusal written as pr_failed', events(wt.id, 'pr_failed')[0]?.body?.includes('uncommitted') ?? false);
  check('dirty card has no PR', getCard(db, wt.id)!.prUrl === null);
}
{
  const wt = await card('Nothing committed');
  const result = await openPullRequest(db, intoDone(wt.id), repo);
  note('empty refusal', result.ok ? 'opened' : `${result.error}: ${result.detail}`);
  check('branch with no commits refused', !result.ok && result.detail === 'the card has no commits on its branch');
  check('empty refusal written as pr_failed', events(wt.id, 'pr_failed').length === 1);
}
{
  const c = createCard(db, { title: 'Just an idea', repoId: repo.id, stage: 'backlog' });
  maybeOpenPullRequest(db, intoDone(c.id), repo);
  check('card without a worktree passed over', !isOpeningPr(c.id) && cardEventsFor(db, c.id).every((e) => !e.kind.startsWith('pr_')));
}

// --- failures, then a retry that works -------------------------------------------
{
  const wt = await card('Needs a login', { 'login.txt': 'x\n' });
  process.env.FAKE_GH_FAIL = 'To get started with GitHub CLI, please run:  gh auth login';
  const failed = await openPullRequest(db, intoDone(wt.id), repo);
  note('gh failure', failed.ok ? 'opened' : `${failed.error}: ${failed.detail}`);
  check('gh failure reported', !failed.ok && failed.detail.includes('gh auth login'));
  check('gh failure written as pr_failed', events(wt.id, 'pr_failed')[0]?.body?.includes('gh auth login') ?? false);
  check('gh failure leaves prUrl null', getCard(db, wt.id)!.prUrl === null);

  delete process.env.FAKE_GH_FAIL;
  const retried = await openPullRequest(db, getCard(db, wt.id)!, repo);
  check('retry opens the pull request', retried.ok && getCard(db, wt.id)!.prUrl === retried.url);
}
{
  const wt = await card('No remote', { 'remote.txt': 'x\n' });
  g('remote', 'rename', 'origin', 'elsewhere');
  const failed = await openPullRequest(db, intoDone(wt.id), repo);
  note('push failure', failed.ok ? 'opened' : `${failed.error}: ${failed.detail}`);
  check('missing origin reported', !failed.ok && failed.error === 'push to origin failed');
  check('push failure written as pr_failed', events(wt.id, 'pr_failed').length === 1);
  g('remote', 'rename', 'elsewhere', 'origin');

  const retried = await openPullRequest(db, getCard(db, wt.id)!, repo);
  check('retry after adding origin works', retried.ok && remoteSha(wt.branch) !== null);
}

rmSync(root, { recursive: true, force: true });
console.log(process.exitCode ? '\nSOME PULL REQUEST BEHAVIOURS FAILED' : '\nall pull request behaviours verified');
