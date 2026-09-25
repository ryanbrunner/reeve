/**
 * Drives `reeve card …` and `reeve project …` against a real server on a
 * spare port, the way a script would: through the binary, reading its stdout,
 * stderr and exit status.
 *
 * Spends no API credit. Its repos point at directories that do not exist, so
 * a card that enters a column Claude works in fails at making its worktree
 * and never reaches a run; and nothing it moves into Done has a branch, so
 * nothing is pushed. One move waits out the CLI's full watch for a run that
 * never comes, which is most of the time this takes.
 *
 *   REEVE_DB=/tmp/reeve-cli.db npx tsx packages/server/src/spikes/cli-check.ts
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import type { ApiCard, ApiCriterion } from '@reeve/shared';
import { config } from '../config.js';
import { cardEventsFor, createRepo, criteriaFor, getCard, refsFor } from '../db/queries.js';
import { createApp } from '../index.js';

const { app, db } = createApp();
const server = serve({ fetch: app.fetch, port: 0, hostname: config.hostname });
await new Promise((done) => server.once('listening', done));
const url = `http://${config.hostname}:${(server.address() as AddressInfo).port}`;

const stamp = Date.now();
const repo = (name: string) =>
  createRepo(db, {
    name, repoPath: `/tmp/${name}-missing`, worktreeRoot: `/tmp/${name}-worktrees`, defaultBranch: 'main',
    setupCommand: null, testCommand: null, serverCommand: null,
    teardownCommand: null, finishCommand: null, laneColor: null, maxBudgetUsd: null,
  });
const web = repo(`cli-web-${stamp}`);
const api = repo(`cli-api-${stamp}`);

const BIN = resolve(config.root, 'packages/cli/bin/reeve.js');
const run = promisify(execFile);

/** One `reeve` call, from /tmp so the cwd names no repo. */
async function reeve(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], {
      cwd: '/tmp',
      env: { ...process.env, REEVE_URL: url },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const { code, stdout, stderr } = e as { code: number; stdout: string; stderr: string };
    return { code, stdout, stderr };
  }
}

async function ok(...args: string[]) {
  const result = await reeve(...args);
  assert.equal(result.code, 0, `reeve ${args.join(' ')} failed:\n${result.stderr}`);
  return result;
}

// --- card add ---------------------------------------------------------------

// --quiet is the id alone, for `id=$(reeve card add …)`.
const quiet = await ok('card', 'add', 'Gift', 'notes', '--repo', web.name, '--body', 'At checkout.', '--quiet');
const giftId = quiet.stdout.trim();
assert.match(giftId, /^[0-9a-f-]{36}$/);
const gift = getCard(db, giftId)!;
assert.equal(gift.title, 'Gift notes');
assert.equal(gift.body, 'At checkout.');
assert.equal(gift.repoId, web.id);
assert.equal(gift.stage, 'backlog');

// --json is the card; a repo is taken by id as well as name.
const second = JSON.parse((await ok('card', 'add', 'Second', '--repo', api.id, '--no-mockups', '--json')).stdout) as ApiCard;
assert.equal(second.repoId, api.id);
assert.equal(second.repoName, api.name);
assert.equal(getCard(db, second.id)?.generateMockups, false);

// Plain, it says what it made and still prints the id.
const plain = await ok('card', 'add', 'Third', '--repo', web.name, '--ref', 'src/a.ts', '--ref', 'https://example.test/x');
assert.match(plain.stdout, new RegExp(`Created ${web.name}#\\d+ in Backlog: Third`));
const thirdId = /id {3}(\S+)/.exec(plain.stdout)?.[1];
assert.ok(thirdId);
assert.deepEqual(refsFor(db, thirdId).map((r) => [r.kind, r.value]).sort(), [['file', 'src/a.ts'], ['url', 'https://example.test/x']]);

// An unknown repo is the CLI's to refuse, since it resolves the name.
const noRepo = await reeve('card', 'add', 'x', '--repo', 'nope');
assert.equal(noRepo.code, 1);
assert.match(noRepo.stderr, /no repo called 'nope'/);
assert.equal((await reeve('card', 'add')).code, 2);

// --- project add ------------------------------------------------------------

// Titled uniquely, since projects are found by title and a scratch database
// may still hold the last run's.
const projectId = (await ok('project', 'add', 'Checkout', `polish-${stamp}`, '--repo', api.name, '--quiet')).stdout.trim();
assert.equal(getCard(db, projectId)?.kind, 'project');
assert.equal(getCard(db, projectId)?.number, 0);

// Filed under a project by title, a task with no --repo takes the project's:
// /tmp is in no repo, and there is more than one.
const filed = JSON.parse((await ok('card', 'add', 'Filed', '--project', `checkout polish-${stamp}`, '--json')).stdout) as ApiCard;
assert.equal(filed.projectId, projectId);
assert.equal(filed.repoId, api.id);

// --- card edit --------------------------------------------------------------

const giftRef = `${web.name}#${gift.number}`;
const edited = await ok('card', 'edit', giftRef, '--title', 'Gift messages', '--effort', 'high', '--model', 'opus',
  '--no-mockups', '--ref', 'docs/gift.md');
assert.match(edited.stdout, /Updated .*: title, model, effort, mockups, 1 ref/);
const row = getCard(db, giftId)!;
assert.equal(row.title, 'Gift messages');
assert.equal(row.effort, 'high');
assert.equal(row.model, 'opus');
assert.equal(row.generateMockups, false);
await ok('card', 'edit', giftId.slice(0, 8), '--model', 'default');
assert.equal(getCard(db, giftId)?.model, null);

// The server's refusals come through as they are, with the field named.
const badEffort = await reeve('card', 'edit', giftRef, '--effort', 'extreme');
assert.equal(badEffort.code, 1);
assert.match(badEffort.stderr, /invalid card: effort: /);
assert.equal((await reeve('card', 'edit', giftRef)).code, 2);

// A project is a card to these commands, by title.
await ok('card', 'edit', `Checkout polish-${stamp}`, '--title', `Checkout ${stamp}`);
assert.equal(getCard(db, projectId)?.title, `Checkout ${stamp}`);

// --- criteria ---------------------------------------------------------------

await ok('card', 'criteria', 'add', giftRef, 'A', 'note', 'prints');
await ok('card', 'criteria', 'add', giftRef, 'It is optional');
await ok('card', 'criteria', 'add', giftRef, 'Max 200 characters');
const listed = await ok('card', 'criteria', 'list', giftRef);
assert.match(listed.stdout, /1\. A note prints\n.*2\. It is optional\n.*3\. Max 200 characters/);
const removed = await ok('card', 'criteria', 'rm', giftRef, '2');
assert.match(removed.stdout, /Removed criterion 2 .*: It is optional/);
assert.deepEqual(criteriaFor(db, giftId).map((c) => c.text), ['A note prints', 'Max 200 characters']);
const asJson = JSON.parse((await ok('card', 'criteria', 'list', giftRef, '--json')).stdout) as ApiCriterion[];
assert.equal(asJson.length, 2);
assert.equal((await reeve('card', 'criteria', 'rm', giftRef, '9')).code, 1);
const check = await reeve('card', 'criteria', 'check', giftRef, '1');
assert.equal(check.code, 1);
assert.match(check.stderr, /checked by Testing/);

// --- note -------------------------------------------------------------------

await ok('card', 'note', giftRef, 'Keep', 'it', 'short');
const noted = cardEventsFor(db, giftId).find((e) => e.kind === 'note');
assert.equal(noted?.body, 'Keep it short');
assert.equal(noted?.actor, 'human');

// --- move -------------------------------------------------------------------

// The help is where a person learns a move is not free.
const help = await ok('card', 'move', '--help');
assert.match(help.stdout, /starts a Claude run/);
assert.match(help.stdout, /opens a pull request/);

// A reorder enters nothing and says nothing.
const reorder = await ok('card', 'move', `${web.name}#${getCard(db, thirdId)!.number}`, 'backlog', '--index', '0');
assert.match(reorder.stdout, /within Backlog/);
assert.equal(reorder.stderr, '');

// With no repo there is nowhere for a run to happen, and it says so at once.
const loose = (await ok('card', 'add', 'Loose', '--repo', web.name, '--quiet')).stdout.trim();
await ok('card', 'edit', loose, '--no-repo');
const noRun = await ok('card', 'move', loose, 'planning');
assert.match(noRun.stdout, /from Backlog to Planning/);
assert.match(noRun.stderr, /No Planning run: .* has no repo/);
assert.equal(getCard(db, loose)?.stage, 'planning');

// Into Done with no branch: nothing to push, and it says that rather than
// promising a pull request.
const noPr = await ok('card', 'move', loose, 'done');
assert.match(noPr.stderr, /No pull request: .* has no branch to push/);

// With a repo, the server tries to start the stage. This one's directory is
// missing, so the worktree fails and no run appears; the CLI waits, then says so.
const tried = await ok('card', 'move', giftRef, 'in-progress', '--json');
assert.match(tried.stderr, /In Progress runs Claude: starting a run/);
assert.match(tried.stderr, /No In Progress run has appeared yet/);
assert.equal((JSON.parse(tried.stdout) as ApiCard).stage, 'in_progress');

// Into a project's lane and out again, as the move goes.
await ok('card', 'move', second.id, 'backlog', '--project', projectId.slice(0, 8));
assert.equal(getCard(db, second.id)?.projectId, projectId);
await ok('card', 'move', second.id, 'backlog', '--no-project');
assert.equal(getCard(db, second.id)?.projectId, null);

// A project is not moved. The server says so, and the CLI passes it on.
const project = await reeve('card', 'move', `Checkout ${stamp}`, 'planning');
assert.equal(project.code, 1, project.stderr);
assert.match(project.stderr, new RegExp(`a project cannot be moved: Checkout ${stamp}`));
// A title that is no project's says so, rather than that it is not a card.
assert.match((await reeve('card', 'note', 'Nowhere at all', 'x')).stderr, /no project matches 'Nowhere at all'/);

// --- archive and restore ----------------------------------------------------

await ok('card', 'archive', thirdId);
assert.ok(getCard(db, thirdId)?.archivedAt);
// Off the board, a card's number no longer finds it — except to restore it.
assert.equal((await reeve('card', 'edit', `${web.name}#${getCard(db, thirdId)!.number}`, '--title', 'x')).code, 1);
const restored = await ok('card', 'restore', `${web.name}#${getCard(db, thirdId)!.number}`);
assert.match(restored.stdout, /Restored .* to Backlog/);
assert.equal(getCard(db, thirdId)?.archivedAt, null);

console.log(`cli-check: every assertion passed against ${url}`);
server.close();
