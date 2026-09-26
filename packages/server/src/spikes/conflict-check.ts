import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { ConflictResolutionOutput } from '@reeve/shared';
import { toBoardCard } from '../board.js';
import { openDatabase } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import {
  cardEventsFor,
  createCard,
  createRepo,
  getCard,
  insertRun,
  liveTaskRun,
  setRunStatus,
  updateSettings,
} from '../db/queries.js';
import { card as cardTable } from '../db/schema.js';
import { createWorktree, mergeInProgress } from '../git/worktree.js';
import { isResolvingConflicts, openPullRequest, syncMergedPullRequests } from '../pullRequest.js';
import { resolveConflicts } from '../resolveConflicts.js';
import { stageContextFor, type ClaudeRunHandle, type ClaudeRunParams } from '../runs/claude.js';
import type { EventWriter } from '../runs/events.js';
import { runRegistry } from '../runs/registry.js';

/**
 * Every path through resolving a Done card's conflicts, against a throwaway
 * repo whose `origin` is a bare repo on disk and whose `gh` is a script that
 * answers from files. Claude is never called: a stand-in run edits and
 * commits the files itself, or fails, or is stopped, and the server's git
 * choreography around it is what is checked. Whether Claude resolves well is
 * only proven by using the feature.
 */

const note = (l: string, v: unknown) => console.log(`${l.padEnd(44)}: ${v}`);
const check = (l: string, ok: boolean) => {
  note(l, ok ? 'ok' : 'FAILED');
  if (!ok) process.exitCode = 1;
};

const root = mkdtempSync(join(tmpdir(), 'reeve-conflict-'));
const repoPath = join(root, 'repo');
const origin = join(root, 'origin.git');
const worktreeRoot = join(root, 'worktrees');
const bin = join(root, 'bin');
const ghState = join(root, 'gh-state');
for (const dir of [repoPath, worktreeRoot, bin, ghState]) mkdirSync(dir);

const run = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: 'pipe' });
const g = (...a: string[]) => run(repoPath, ...a);
g('init', '-q', '-b', 'main');
g('config', 'user.email', 't@t.t'); g('config', 'user.name', 'T');
writeFileSync(join(repoPath, 'README.md'), '# base\n');
g('add', '-A'); g('commit', '-qm', 'base');
execFileSync('git', ['init', '-q', '--bare', origin]);
g('remote', 'add', 'origin', origin);
g('push', '-q', 'origin', 'main');

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

const github = (url: string, mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN') =>
  writeFileSync(
    join(ghState, url.replace(/[/:]/g, '_')),
    JSON.stringify({ state: 'OPEN', mergedAt: null, mergeCommit: null, baseRefName: 'main', mergeable }),
  );
const remoteSha = (branch: string) => {
  try {
    return execFileSync('git', ['--git-dir', origin, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return null;
  }
};
const head = (path: string) => run(path, 'rev-parse', 'HEAD').trim();
const parents = (path: string) => run(path, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').slice(1);
const events = (cardId: string, kind: string) => cardEventsFor(db, cardId).filter((e) => e.kind === kind);
const wait = async (until: () => boolean) => {
  for (let i = 0; i < 500 && !until(); i++) await new Promise((r) => setTimeout(r, 20));
};

const db = openDatabase(join(root, 'reeve.db'));
runMigrations(db);
const repo = createRepo(db, {
  name: 'conflict-check', repoPath, worktreeRoot, defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null, maxBudgetUsd: null,
});
const writer = { append: () => {}, finish: () => {} } as unknown as EventWriter;

/** Commit to `main` and push it, as another pull request landing would. */
function land(file: string, body: string) {
  writeFileSync(join(repoPath, file), body);
  g('add', '-A'); g('commit', '-qm', `land ${file}`);
  g('push', '-q', 'origin', 'main');
}

let prs = 0;
/**
 * A Done card with an open pull request whose branch changed `file`, and a
 * `main` that has since changed it too — or, with `clash` false, changed
 * something else, so GitHub's verdict is stale and the merge is clean.
 */
async function conflicted(title: string, clash = true) {
  const file = `${title.toLowerCase().replace(/\W+/g, '-')}.txt`;
  land(file, 'base\n');
  const c = createCard(db, { title, repoId: repo.id, stage: 'done' });
  const wt = await createWorktree({ repoPath, worktreeRoot, cardId: c.id, title, base: 'main' });
  writeFileSync(join(wt.path, file), 'from the card\n');
  run(wt.path, 'add', '-A'); run(wt.path, 'commit', '-qm', `work on ${title}`);
  run(wt.path, 'push', '-q', '-u', 'origin', wt.branch);
  const url = `https://github.com/acme/widgets/pull/${++prs}`;
  db.update(cardTable)
    .set({ worktreePath: wt.path, branchName: wt.branch, baseSha: wt.baseSha, prUrl: url, prNumber: prs, prOpenedAt: new Date() })
    .where(eq(cardTable.id, c.id))
    .run();
  // What every stage leaves behind, untracked: must not count as unsaved work.
  mkdirSync(join(wt.path, '.reeve'));
  writeFileSync(join(wt.path, '.reeve', 'plan.md'), '# plan\n');
  if (clash) land(file, 'from main\n');
  else land(`${file}.elsewhere`, 'unrelated\n');
  github(url, clash ? 'CONFLICTING' : 'MERGEABLE');
  return { id: c.id, url, file, ...wt, before: head(wt.path) };
}

type Behaviour = 'resolve' | 'markers' | 'fail' | 'stop';

/**
 * Stands in for `startClaudeRun`: writes a real run row, so `liveTaskRun` and
 * the cap see it, then does what the behaviour says once `gate` opens.
 */
function standIn(behaviour: Behaviour, gate: Promise<void> = Promise.resolve()) {
  const seen: { prompt?: string; task?: string; runStage?: string } = {};
  const start = (params: ClaudeRunParams): ClaudeRunHandle => {
    const { card, worktreePath: cwd } = params;
    seen.task = params.stage.id;
    seen.runStage = params.runStage;
    seen.prompt = params.stage.buildPrompt(stageContextFor(db, { card, repo: params.repo, worktreePath: cwd }));
    const row = insertRun(db, {
      id: crypto.randomUUID(), cardId: card.id, kind: 'claude', stage: params.runStage ?? 'done',
      status: 'running', task: params.stage.id, cwd, startedAt: new Date(),
    });
    let stopped = false;
    runRegistry.register({ runId: row.id, cardId: card.id, kind: 'claude', outOfBand: true, stop: async () => { stopped = true; } });
    const done = (async () => {
      await gate;
      runRegistry.unregister(row.id);
      const conflicted = run(cwd, 'diff', '--name-only', '--diff-filter=U').trim().split('\n').filter(Boolean);
      if (behaviour === 'fail') {
        setRunStatus(db, row.id, { status: 'failed', stopReason: 'budget_exhausted', errorMessage: 'run ended: error_max_budget_usd', finishedAt: new Date() });
        return;
      }
      if (behaviour === 'stop' || stopped) {
        // Half a resolution, as a run stopped partway leaves it.
        writeFileSync(join(cwd, conflicted[0]!), 'half done\n');
        setRunStatus(db, row.id, { status: 'cancelled', stopReason: 'cancelled_by_user', finishedAt: new Date() });
        return;
      }
      for (const f of conflicted) {
        if (behaviour === 'resolve') writeFileSync(join(cwd, f), 'from the card\nfrom main\n');
        run(cwd, 'add', f);
      }
      run(cwd, 'commit', '-q', '--no-edit');
      const output: ConflictResolutionOutput = {
        summary: 'Kept both lines.',
        files: conflicted.map((path) => ({ path, resolution: 'Both sides added a line; kept both.' })),
        tests_passed: false,
        concerns: [],
      };
      setRunStatus(db, row.id, { status: 'succeeded', stopReason: 'completed', structuredOutput: output, totalCostUsd: 0.12, finishedAt: new Date() });
    })();
    return { runId: row.id, sessionId: 'stand-in', done };
  };
  return { start, seen };
}

// --- the sync records GitHub's verdict ------------------------------------------
{
  const wt = await conflicted('Sync verdict');
  const flag = () => toBoardCard(db, getCard(db, wt.id)!, null, null).prConflicting;
  check('nothing known before a sync', !flag());
  await syncMergedPullRequests(db);
  check('CONFLICTING sets the flag', flag());
  github(wt.url, 'UNKNOWN');
  await syncMergedPullRequests(db);
  check('UNKNOWN keeps a conflict on record', flag());
  github(wt.url, 'MERGEABLE');
  await syncMergedPullRequests(db);
  check('MERGEABLE clears it', !flag());

  const fresh = await conflicted('Unknown from the start');
  github(fresh.url, 'UNKNOWN');
  await syncMergedPullRequests(db);
  check('UNKNOWN alone never sets it', !toBoardCard(db, getCard(db, fresh.id)!, null, null).prConflicting);

  github(wt.url, 'CONFLICTING');
  await syncMergedPullRequests(db);
  db.update(cardTable).set({ stage: 'testing' }).where(eq(cardTable.id, wt.id)).run();
  check('not offered outside Done', !toBoardCard(db, getCard(db, wt.id)!, null, null).prConflicting);
  db.update(cardTable).set({ stage: 'done', prUrl: 'https://github.com/acme/widgets/pull/999' }).where(eq(cardTable.id, wt.id)).run();
  github('https://github.com/acme/widgets/pull/999', 'UNKNOWN');
  check('not inherited by a newer pull request', !toBoardCard(db, getCard(db, wt.id)!, null, null).prConflicting);
}

// --- refusals -------------------------------------------------------------------
{
  const wt = await conflicted('Dirty tree');
  writeFileSync(join(wt.path, wt.file), 'edited, never committed\n');
  const stand = standIn('resolve');
  const result = await resolveConflicts(db, writer, getCard(db, wt.id)!, repo, stand.start);
  note('dirty refusal', result.ok ? 'started' : `${result.error}: ${result.detail}`);
  check('dirty tree refused', !result.ok && result.status === 409 && result.error.includes('uncommitted'));
  check('dirty tree not merged', head(wt.path) === wt.before && !(await mergeInProgress(wt.path)));
  check('dirty refusal starts no run', stand.seen.task === undefined);
  check('dirty refusal releases the lock', !isResolvingConflicts(wt.id));

  const backlog = createCard(db, { title: 'Not done', repoId: repo.id, stage: 'testing' });
  const notDone = await resolveConflicts(db, writer, backlog, repo, stand.start);
  check('card outside Done refused', !notDone.ok && notDone.status === 400);

  const noPr = createCard(db, { title: 'No pull request', repoId: repo.id, stage: 'done' });
  const refused = await resolveConflicts(db, writer, noPr, repo, stand.start);
  check('card without a pull request refused', !refused.ok && refused.status === 400);
}

// --- a base that now merges cleanly is pushed with no run ---------------------
{
  const wt = await conflicted('Stale verdict', false);
  await syncMergedPullRequests(db);
  const stand = standIn('resolve');
  const result = await resolveConflicts(db, writer, getCard(db, wt.id)!, repo, stand.start);
  note('clean merge', result.ok ? `runId=${result.runId} pushed=${result.pushed}` : `${result.error}: ${result.detail}`);
  check('clean merge needs no run', result.ok && result.runId === null && result.pushed && stand.seen.task === undefined);
  check('clean merge pushed', remoteSha(wt.branch) === head(wt.path));
  check('clean merge is a merge of main', parents(wt.path).includes(wt.before) && parents(wt.path).includes(g('rev-parse', 'main').trim()));
  check('clean merge written as resolved', events(wt.id, 'conflicts_resolved')[0]?.meta?.['clean'] === true);
}

// --- Claude resolves, the server checks and pushes -----------------------------
{
  const wt = await conflicted('Resolved');
  await syncMergedPullRequests(db);
  let open: () => void = () => {};
  const stand = standIn('resolve', new Promise((r) => (open = r)));
  const remoteBefore = remoteSha(wt.branch);
  const result = await resolveConflicts(db, writer, getCard(db, wt.id)!, repo, stand.start);
  const runId = result.ok ? result.runId : null;
  // Taken now: the card over the cap below lands more on main.
  const mainHead = g('rev-parse', 'main').trim();
  note('resolve', result.ok ? `runId=${result.runId}` : `${result.error}: ${result.detail}`);
  check('run started for the conflicts', result.ok && result.runId !== null);
  check('run is the resolve_conflicts task, in Done', stand.seen.task === 'resolve_conflicts' && stand.seen.runStage === 'done');
  check('prompt names the conflicted file', stand.seen.prompt?.includes(`\`${wt.file}\``) ?? false);
  check('merge in progress while the run works', await mergeInProgress(wt.path));
  check('lock held while the run works', isResolvingConflicts(wt.id));
  check('card says it is resolving', toBoardCard(db, getCard(db, wt.id)!, null, null).resolvingConflicts);
  check('run live on its row', liveTaskRun(db, wt.id, 'resolve_conflicts') !== undefined);
  // The run is out of band: while it works the card keeps its colour and has no current run.
  check('card stays idle while the run works', toBoardCard(db, getCard(db, wt.id)!, null, null).activity === 'idle');
  check('card has no current run while it works', toBoardCard(db, getCard(db, wt.id)!, null, null).latestRun === null);

  const pr = await openPullRequest(db, getCard(db, wt.id)!, repo);
  check('opening the PR refused mid-merge', !pr.ok && pr.status === 409);
  check('that refusal is not a pr_failed', events(wt.id, 'pr_failed').length === 0);
  check('remote untouched mid-merge', remoteSha(wt.branch) === remoteBefore);
  const again = await resolveConflicts(db, writer, getCard(db, wt.id)!, repo, stand.start);
  check('second press refused', !again.ok && again.status === 409);

  // The cap counts this run, so another card is refused before git is touched.
  updateSettings(db, { maxConcurrentRuns: 1 });
  const other = await conflicted('Over the cap');
  const capped = await resolveConflicts(db, writer, getCard(db, other.id)!, repo, standIn('resolve').start);
  check('cap refuses another card', !capped.ok && capped.status === 429);
  check('cap refusal leaves the tree alone', head(other.path) === other.before && !(await mergeInProgress(other.path)));
  updateSettings(db, { maxConcurrentRuns: 3 });

  open();
  await wait(() => !isResolvingConflicts(wt.id));
  const local = head(wt.path);
  check('lock released after the push', !isResolvingConflicts(wt.id));
  check('merge commit pushed', remoteSha(wt.branch) === local);
  check('pushed without force', remoteBefore !== null && run(wt.path, 'merge-base', '--is-ancestor', remoteBefore, local) === '');
  check('merge contains the base head', parents(wt.path).includes(mainHead));
  const resolved = events(wt.id, 'conflicts_resolved')[0];
  check('conflicts_resolved written', resolved !== undefined && resolved.runId === runId);
  check('event carries the per-file notes', (resolved?.meta?.['files'] as unknown[] | undefined)?.length === 1);
  check('event says the tests failed', resolved?.meta?.['testsPassed'] === false);
  check('conflict flag forgotten after the push', !toBoardCard(db, getCard(db, wt.id)!, null, null).prConflicting);
  check('card stage unchanged', getCard(db, wt.id)!.stage === 'done');
  check('card has no current run', toBoardCard(db, getCard(db, wt.id)!, null, null).latestRun === null);
}

// --- a run that fails, is stopped, or leaves markers is rolled back -------------
for (const behaviour of ['fail', 'stop', 'markers'] as const) {
  const wt = await conflicted(`Rolled back ${behaviour}`);
  const remoteBefore = remoteSha(wt.branch);
  const result = await resolveConflicts(db, writer, getCard(db, wt.id)!, repo, standIn(behaviour).start);
  check(`${behaviour}: run started`, result.ok && result.runId !== null);
  await wait(() => !isResolvingConflicts(wt.id));
  const failed = events(wt.id, 'conflicts_failed')[0];
  note(`${behaviour}: reason`, failed?.body);
  check(`${behaviour}: no merge left in progress`, !(await mergeInProgress(wt.path)));
  check(`${behaviour}: HEAD back where it was`, head(wt.path) === wt.before);
  check(`${behaviour}: tree clean again`, run(wt.path, 'status', '--porcelain', '--', '.', ':(exclude).reeve').trim() === '');
  check(`${behaviour}: nothing pushed`, remoteSha(wt.branch) === remoteBefore);
  check(`${behaviour}: conflicts_failed written`, failed !== undefined && events(wt.id, 'conflicts_resolved').length === 0);
  check(`${behaviour}: .reeve left alone`, existsSync(join(wt.path, '.reeve', 'plan.md')));
}

// --- a push that fails keeps the merge, and pressing again pushes it -----------
{
  const wt = await conflicted('Push fails');
  const remoteBefore = remoteSha(wt.branch);
  const result = await resolveConflicts(db, writer, getCard(db, wt.id)!, repo, standIn('resolve', new Promise((r) => setTimeout(r, 50))).start);
  check('push failure: run started', result.ok && result.runId !== null);
  g('remote', 'set-url', 'origin', join(root, 'nowhere.git'));
  await wait(() => !isResolvingConflicts(wt.id));
  g('remote', 'set-url', 'origin', origin);
  const failed = events(wt.id, 'conflicts_failed')[0];
  note('push failure: reason', failed?.body?.split('\n')[0]);
  check('push failure: merge kept locally', failed?.meta?.['kept'] === true && parents(wt.path).includes(wt.before));
  check('push failure: nothing pushed', remoteSha(wt.branch) === remoteBefore);
  const again = await resolveConflicts(db, writer, getCard(db, wt.id)!, repo, standIn('resolve').start);
  check('push failure: retry pushes with no run', again.ok && again.runId === null && remoteSha(wt.branch) === head(wt.path));
}

// --- a merge a restart left behind is cleared first ----------------------------
{
  const wt = await conflicted('Stale merge');
  run(wt.path, 'fetch', '-q', 'origin');
  try {
    run(wt.path, 'merge', '--no-edit', 'origin/main');
  } catch {
    // Stopped on its conflict, exactly as an interrupted run leaves it.
  }
  check('stale merge set up', await mergeInProgress(wt.path));
  const result = await resolveConflicts(db, writer, getCard(db, wt.id)!, repo, standIn('resolve').start);
  note('stale merge', result.ok ? `runId=${result.runId}` : `${result.error}: ${result.detail}`);
  check('stale merge cleared and resolved', result.ok && result.runId !== null);
  await wait(() => !isResolvingConflicts(wt.id));
  check('stale merge then pushed', remoteSha(wt.branch) === head(wt.path) && parents(wt.path).includes(wt.before));
}

// --- a merge committed but never checked is not pushed by the clean path --------
{
  // As a restart between Claude's commit and the server's check leaves it.
  const wt = await conflicted('Unchecked merge');
  const remoteBefore = remoteSha(wt.branch);
  run(wt.path, 'fetch', '-q', 'origin');
  try {
    run(wt.path, 'merge', '--no-edit', 'origin/main');
  } catch {
    // Stopped on its conflict; committed below with the markers still in.
  }
  run(wt.path, 'add', wt.file);
  run(wt.path, 'commit', '-q', '--no-edit');
  const merged = head(wt.path);
  // A file from main that merely looks like a conflict must not trip the check.
  land('fixture.txt', '<<<<<<< ours\n');
  const result = await resolveConflicts(db, writer, getCard(db, wt.id)!, repo, standIn('resolve').start);
  note('unchecked merge', result.ok ? `runId=${result.runId}` : `${result.error}: ${result.detail}`);
  check('unchecked merge refused', !result.ok && result.status === 409 && result.detail.includes(wt.file));
  check('fixture from main not blamed', !result.ok && !result.detail.includes('fixture.txt'));
  check('unchecked merge not pushed', remoteSha(wt.branch) === remoteBefore);
  check('unchecked merge left as it was', head(wt.path) === merged && !(await mergeInProgress(wt.path)));
  check('no conflicts_resolved written', events(wt.id, 'conflicts_resolved').length === 0);
}

rmSync(root, { recursive: true, force: true });
console.log(process.exitCode ? '\nSOME CONFLICT BEHAVIOURS FAILED' : '\nall conflict behaviours verified');
