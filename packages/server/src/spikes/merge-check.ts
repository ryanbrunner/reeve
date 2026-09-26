import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { MergePullRequestResponse } from '@reeve/shared';
import { toBoardCard } from '../board.js';
import { openDatabase } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { cardEventsFor, createCard, createRepo, getCard } from '../db/queries.js';
import { card as cardTable } from '../db/schema.js';
import { forgetConflict, isMergingPr, landPullRequest, syncMergedPullRequests } from '../pullRequest.js';
import { actionRoutes } from '../routes/actions.js';
import type { EventWriter } from '../runs/events.js';

/**
 * Every path through the Merge button's route, against a throwaway repo whose
 * `gh` is a script answering from files: `pr view` from a file per URL, and
 * `pr merge` rewriting that file as merged, or failing as told. Nothing here
 * reaches GitHub. What is checked is when Merge is offered — only on GitHub's
 * MERGEABLE — and what a merge, a refusal and a race leave on the card.
 */

const note = (l: string, v: unknown) => console.log(`${l.padEnd(44)}: ${v}`);
const check = (l: string, ok: boolean) => {
  note(l, ok ? 'ok' : 'FAILED');
  if (!ok) process.exitCode = 1;
};

const root = mkdtempSync(join(tmpdir(), 'reeve-merge-'));
const repoPath = join(root, 'repo');
const origin = join(root, 'origin.git');
const bin = join(root, 'bin');
const ghState = join(root, 'gh-state');
for (const dir of [repoPath, bin, ghState]) mkdirSync(dir);

// A real origin, so the full sync a merge sets off can fetch the base quietly.
const g = (...a: string[]) => execFileSync('git', ['-C', repoPath, ...a], { encoding: 'utf8', stdio: 'pipe' });
g('init', '-q', '-b', 'main');
g('config', 'user.email', 't@t.t'); g('config', 'user.name', 'T');
writeFileSync(join(repoPath, 'README.md'), '# base\n');
g('add', '-A'); g('commit', '-qm', 'base');
execFileSync('git', ['init', '-q', '--bare', origin]);
g('remote', 'add', 'origin', origin);
g('push', '-q', 'origin', 'main');

writeFileSync(join(bin, 'gh'), `#!/bin/sh
key=$(printf '%s' "$3" | tr '/:' '__')
if [ "$1 $2" = "pr view" ]; then
  if [ -f "$FAKE_GH_STATE/$key" ]; then cat "$FAKE_GH_STATE/$key"; exit 0; fi
  echo "no pull requests found" >&2; exit 1
fi
if [ "$1 $2" = "pr merge" ]; then
  echo "$3 $4" >> "$FAKE_GH_STATE/merges.log"
  sleep 0.2
  if [ -n "$FAKE_GH_MERGE_FAIL" ]; then echo "$FAKE_GH_MERGE_FAIL" >&2; exit 1; fi
  printf '{"state":"MERGED","mergedAt":"2026-09-26T12:00:00Z","mergeCommit":{"oid":"abc1234def5678"},"baseRefName":"main","mergeable":"UNKNOWN"}' > "$FAKE_GH_STATE/$key"
  exit 0
fi
echo "fake gh: unexpected $*" >&2; exit 2
`);
chmodSync(join(bin, 'gh'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.FAKE_GH_STATE = ghState;

const github = (url: string, mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN') =>
  writeFileSync(
    join(ghState, url.replace(/[/:]/g, '_')),
    JSON.stringify({ state: 'OPEN', mergedAt: null, mergeCommit: null, baseRefName: 'main', mergeable }),
  );
const events = (cardId: string, kind: string) => cardEventsFor(db, cardId).filter((e) => e.kind === kind);

const db = openDatabase(join(root, 'reeve.db'));
runMigrations(db);
const repo = createRepo(db, {
  name: 'merge-check', repoPath, worktreeRoot: join(root, 'worktrees'), defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null,
});
const writer = { append: () => {}, finish: () => {} } as unknown as EventWriter;
const routes = actionRoutes(db, writer);
const merge = async (id: string) => {
  const res = await routes.request(`/${id}/merge`, { method: 'POST' });
  return { status: res.status, body: (await res.json()) as MergePullRequestResponse & { error?: string; detail?: string } };
};

let prs = 0;
/** A Done card with an open pull request, and what GitHub says of it. */
function done(title: string, verdict: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN') {
  const c = createCard(db, { title, repoId: repo.id, stage: 'done' });
  const url = `https://github.com/acme/widgets/pull/${++prs}`;
  db.update(cardTable)
    .set({ branchName: `reeve/${prs}`, prUrl: url, prNumber: prs, prOpenedAt: new Date() })
    .where(eq(cardTable.id, c.id))
    .run();
  github(url, verdict);
  return { id: c.id, url };
}
const board = (id: string) => toBoardCard(db, getCard(db, id)!, null, null);

// --- when Merge is offered --------------------------------------------------------
{
  const clean = done('Clean', 'MERGEABLE');
  check('not offered before a sync', !board(clean.id).prMergeable);
  const early = await merge(clean.id);
  check('route refuses before a sync', early.status === 409 && (early.body.detail ?? '').includes('not yet said'));
  await syncMergedPullRequests(db);
  check('MERGEABLE offers it', board(clean.id).prMergeable);
  check('and does not call it conflicting', !board(clean.id).prConflicting);

  github(clean.url, 'UNKNOWN');
  await syncMergedPullRequests(db);
  check('UNKNOWN takes it away', !board(clean.id).prMergeable);

  github(clean.url, 'CONFLICTING');
  await syncMergedPullRequests(db);
  check('CONFLICTING takes it away', !board(clean.id).prMergeable);
  const conflicted = await merge(clean.id);
  check('route refuses a conflict, saying so', conflicted.status === 409 && (conflicted.body.detail ?? '').includes('conflicts'));

  github(clean.url, 'MERGEABLE');
  await syncMergedPullRequests(db);
  check('MERGEABLE again offers it', board(clean.id).prMergeable && !board(clean.id).prConflicting);
  forgetConflict(clean.id);
  check('a push forgets it', !board(clean.id).prMergeable);

  await syncMergedPullRequests(db);
  db.update(cardTable).set({ stage: 'testing' }).where(eq(cardTable.id, clean.id)).run();
  check('not offered outside Done', !board(clean.id).prMergeable);
  const outside = await merge(clean.id);
  check('route refuses outside Done', outside.status === 409);
  db.update(cardTable).set({ stage: 'done', prUrl: 'https://github.com/acme/widgets/pull/999' }).where(eq(cardTable.id, clean.id)).run();
  github('https://github.com/acme/widgets/pull/999', 'UNKNOWN');
  check('not inherited by a newer pull request', !board(clean.id).prMergeable);
}

// --- a merge that goes through ----------------------------------------------------
{
  const wt = done('Lands', 'MERGEABLE');
  await syncMergedPullRequests(db);
  const pending = merge(wt.id);
  await new Promise((r) => setTimeout(r, 50));
  check('card says it is merging', board(wt.id).mergingPr && isMergingPr(wt.id));
  const second = await merge(wt.id);
  check('a second press is refused while it runs', second.status === 409 && second.body.error === 'already merging');
  const res = await pending;
  note('merge', `${res.status} ${JSON.stringify(res.body)}`);
  check('merge answers 200, merged', res.status === 200 && res.body.merged === true);
  const card = getCard(db, wt.id)!;
  check('card marked merged', card.mergedAt !== null);
  const merged = events(wt.id, 'merged');
  check('one merged event, with the sha', merged.length === 1 && merged[0]?.meta?.['sha'] === 'abc1234def5678');
  check('no longer offered, nor merging', !board(wt.id).prMergeable && !board(wt.id).mergingPr);
  const again = await merge(wt.id);
  check('merging it again is refused', again.status === 409 && again.body.error === 'already merged');
  // The fire-and-forget full sync the merge set off must not mark it twice.
  await new Promise((r) => setTimeout(r, 500));
  await syncMergedPullRequests(db);
  check('still one merged event after a sync', events(wt.id, 'merged').length === 1);
}

// --- a merge gh refuses -----------------------------------------------------------
{
  const wt = done('Protected', 'MERGEABLE');
  await syncMergedPullRequests(db);
  process.env.FAKE_GH_MERGE_FAIL = 'GraphQL: At least 1 approving review is required by reviewers with write access.';
  const res = await merge(wt.id);
  delete process.env.FAKE_GH_MERGE_FAIL;
  note('refused', `${res.status} ${res.body.error}: ${res.body.detail}`);
  check('refusal answers 502 with gh’s words', res.status === 502 && (res.body.detail ?? '').includes('approving review'));
  const failed = events(wt.id, 'merge_failed');
  check('written as merge_failed, by a human', failed.length === 1 && failed[0]?.actor === 'human');
  check('and not as pr_failed', events(wt.id, 'pr_failed').length === 0);
  check('card not merged', getCard(db, wt.id)!.mergedAt === null);
  check('still offered, still mergeable', board(wt.id).prMergeable && !board(wt.id).mergingPr);

  // VIBE MODE's path, which checks no verdict and records itself as Claude.
  process.env.FAKE_GH_MERGE_FAIL = 'still no review';
  const vibe = await landPullRequest(db, getCard(db, wt.id)!, repo, 'claude');
  delete process.env.FAKE_GH_MERGE_FAIL;
  check('VIBE’s refusal is Claude’s merge_failed', !vibe.ok && events(wt.id, 'merge_failed')[0]?.actor === 'claude');
}

// --- VIBE MODE lands one GitHub has not ruled on ----------------------------------
{
  const wt = done('Vibe', 'UNKNOWN');
  const res = await landPullRequest(db, getCard(db, wt.id)!, repo, 'claude');
  check('landPullRequest itself needs no verdict', res.ok && res.merged && getCard(db, wt.id)!.mergedAt !== null);
}

// The full sync each merge sets off is not awaited; let the last one finish
// before its repo and its `gh` are deleted from under it.
await new Promise((r) => setTimeout(r, 1_000));
rmSync(root, { recursive: true, force: true });
