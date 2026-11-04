/**
 * Throwaway check on Settings' stage hooks: are they stored the way the form
 * expects, does a move build the prompt it should, and does one real move run
 * one real hook, past the concurrency cap, in the card's history?
 *
 * Run it against a scratch database:
 *
 *     REEVE_DB=/tmp/hooks.db npx tsx packages/server/src/spikes/hooks-check.ts
 *
 * The last part spends real API credit — two hook runs, each a turn or so at
 * low effort — and needs Claude credentials. `--offline` stops before it.
 *
 * The move it makes is Planning to Backlog, so nothing but the hook runs: a
 * card arriving in Backlog starts no stage.
 *
 * Exits 1 if any check fails.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../index.js';
import {
  boardCards,
  createCard,
  createRepo,
  getCard,
  getRun,
  getSettings,
  runsForCard,
  updateSettings,
} from '../db/queries.js';
import { runRegistry } from '../runs/registry.js';
import { stageHookTask } from '../stages/hook.js';

const { db, app } = createApp();
const offline = process.argv.includes('--offline');

const already = boardCards(db).length;
if (already > 0) {
  console.error(`hooks-check wants an empty board and this one has ${already} cards. Give it a fresh REEVE_DB.`);
  process.exit(1);
}

let failures = 0;
const check = (label: string, ok: boolean, got: unknown) => {
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}`);
  if (!ok) failures++;
};

// A real repo, so the hook has a directory to run in.
const dir = mkdtempSync(join(tmpdir(), 'reeve-hooks-'));
execFileSync('git', ['init', '-q', '-b', 'main', dir]);
writeFileSync(join(dir, 'README.md'), '# hooks-check\n');
execFileSync('git', ['-C', dir, 'add', '.']);
execFileSync('git', ['-C', dir, '-c', 'user.email=x@x', '-c', 'user.name=x', 'commit', '-q', '-m', 'init']);
const repo = createRepo(db, {
  name: `hooks-check-${Date.now()}`,
  repoPath: dir, worktreeRoot: join(dir, '..'), defaultBranch: 'main',
  setupCommand: null, testCommand: null, focusedTestCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: null,
});

// --- storage ---------------------------------------------------------------
console.log('--- storage ---');
const empty = getSettings(db).stageHooks;
check('every column reads as no hook on a board with no row', Object.keys(empty).length === 5 && Object.values(empty).every((h) => h.enter === null && h.leave === null), empty);
updateSettings(db, { stageHooks: { planning: { leave: 'Say goodbye to {{ref}} leaving {{from}}.' } } });
updateSettings(db, { stageHooks: { backlog: { enter: 'Say hello to {{title}} in {{to}}.' } } });
const both = getSettings(db).stageHooks;
check('saving one column leaves the others as they were', both.planning.leave !== null && both.backlog.enter !== null, { planning: both.planning, backlog: both.backlog });
updateSettings(db, { stageHooks: { testing: { enter: '   ' } } });
check('a blank hook is stored as none', getSettings(db).stageHooks.testing.enter === null, getSettings(db).stageHooks.testing);

// --- the prompt ------------------------------------------------------------
console.log('\n--- the prompt ---');
const probe = createCard(db, { title: 'Probe card', body: 'A brief.', repoId: repo.id, stage: 'planning' });
const prompt = stageHookTask({ from: 'planning', to: 'backlog', leave: both.planning.leave, enter: both.backlog.enter })
  .buildPrompt({ card: probe, repo, worktreePath: dir, brief: probe.body });
check('it carries the leave half, filled', prompt.includes('### On leaving Planning') && prompt.includes(`Say goodbye to ${repo.name}#${probe.number} leaving Planning.`), prompt.match(/### On leaving[^#]*/)?.[0]);
check('and the enter half after it, filled', prompt.indexOf('### On entering Backlog') > prompt.indexOf('### On leaving') && prompt.includes('Say hello to Probe card in Backlog.'), prompt.match(/### On entering[^#]*/)?.[0]);
check('and says what happened', prompt.includes('moved from Planning to Backlog'), prompt.match(/Card .*moved.*/)?.[0]);
check('with no var left unfilled', !/\{\{\w+\}\}/.test(prompt), prompt.match(/\{\{\w+\}\}/g));
const made = stageHookTask({ from: null, to: 'backlog', leave: 'never', enter: 'Hi.' }).buildPrompt({ card: probe, repo, worktreePath: dir, brief: '' });
check('a card just made has no leave half', !made.includes('On leaving') && made.includes('was just made, in Backlog'), made.match(/Card .*made.*/)?.[0]);

if (offline) {
  console.log(failures ? `\n${failures} check(s) failed` : '\nall offline hook checks pass');
  process.exit(failures ? 1 : 0);
}

// --- a real move -----------------------------------------------------------
console.log('\n--- a real move (spends API credit) ---');
updateSettings(db, { maxConcurrentRuns: 1 });
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const res = await app.request(`/api/cards/${probe.id}/move`, json({ stage: 'backlog', index: 0 }));
check('the move is accepted', res.status === 200, res.status);
// The hook is queued behind a worktree check; give it a moment to start.
let hook = undefined as ReturnType<typeof runsForCard>[number] | undefined;
for (let i = 0; i < 50 && !hook; i++) {
  await new Promise((r) => setTimeout(r, 200));
  hook = runsForCard(db, probe.id).find((r) => r.task === 'stage_hook');
}
check('one hook run starts, on the card, out of band', hook !== undefined && hook.stage === 'backlog', hook && { task: hook.task, stage: hook.stage, cwd: hook.cwd });
check('and the cap does not count it', runRegistry.countByKind('claude') === 0, runRegistry.countByKind('claude'));
check('and the card stays where the person put it', getCard(db, probe.id)!.stage === 'backlog', getCard(db, probe.id)!.stage);

// A card made by a person with a real title counts as entering its column.
const created = await app.request('/api/cards', json({ title: 'Made by hand', repoId: repo.id }));
const createdId = ((await created.json()) as { id: string }).id;

if (hook) {
  const end = Date.now() + 5 * 60_000;
  while (runRegistry.get(hook.id) && Date.now() < end) await new Promise((r) => setTimeout(r, 1000));
  const final = getRun(db, hook.id)!;
  check('the hook run succeeds', final.status === 'succeeded', { status: final.status, error: final.errorMessage });
  console.log(`  summary: ${JSON.stringify((final.structuredOutput as { summary?: string } | null)?.summary)}`);
  console.log(`  cost: $${final.totalCostUsd}`);
}
let createdHook = undefined as ReturnType<typeof runsForCard>[number] | undefined;
for (let i = 0; i < 50 && !createdHook; i++) {
  await new Promise((r) => setTimeout(r, 200));
  createdHook = runsForCard(db, createdId).find((r) => r.task === 'stage_hook');
}
check('a card made by hand runs its column\'s enter hook', createdHook !== undefined, createdHook?.stage);
if (createdHook) {
  const end = Date.now() + 5 * 60_000;
  while (runRegistry.get(createdHook.id) && Date.now() < end) await new Promise((r) => setTimeout(r, 1000));
  const final = getRun(db, createdHook.id)!;
  check('and it succeeds', final.status === 'succeeded', { status: final.status, error: final.errorMessage });
  console.log(`  summary: ${JSON.stringify((final.structuredOutput as { summary?: string } | null)?.summary)}`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall hook checks pass');
process.exit(failures ? 1 : 0);
