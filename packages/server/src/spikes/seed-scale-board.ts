/**
 * Seeds a board with the states the scale-up work added, to look at and try
 * without spending API credit, into a server ALREADY RUNNING on the same
 * scratch database (as seed-conversation.ts does, which pairs with this one):
 *
 * - "playground": a real repo, cloned from a bare origin, with a slow test
 *   command, for trying real runs — the worker, the pulse, limits. Its cards
 *   are left in Backlog; starting one spends credit.
 * - "stack": a parent card built on a branch and a card stacked on it, with
 *   real worktrees, so the "on #N" chip, the diff against the parent's branch
 *   and the Release gate can be seen.
 * - A run stopped at its budget, with its Continue.
 * - A project of three tasks, one merged with notes, so a task's prompt has
 *   the rest of the project in it (open the stage's instructions).
 *
 *   REEVE_DB=/tmp/scale.db REEVE_PORT=4420 npm start                 # one shell
 *   REEVE_DB=/tmp/scale.db npx tsx packages/server/src/spikes/seed-conversation.ts
 *   REEVE_DB=/tmp/scale.db npx tsx packages/server/src/spikes/seed-scale-board.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { openDatabase } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { addDependency, createCard, createRepo, getCard, insertRun, listRepos } from '../db/queries.js';
import { artifact, card as cardTable } from '../db/schema.js';
import { EventWriter } from '../runs/events.js';
import { ensureWorktree } from '../startStage.js';

if (!process.env.REEVE_DB) throw new Error('give this the scratch REEVE_DB the running server uses');
const db = openDatabase(config.dbFile);
runMigrations(db);
const writer = new EventWriter(db);

const root = mkdtempSync(join(tmpdir(), 'reeve-scale-'));
const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

/** A repo cloned from a bare origin of its own, with one commit on main. */
function gitRepo(name: string, files: Record<string, string>): string {
  const origin = join(root, `${name}.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const path = join(root, name);
  execFileSync('git', ['clone', '-q', origin, path], { stdio: 'ignore' });
  g(path, 'config', 'user.email', 'reeve@example.com');
  g(path, 'config', 'user.name', 'Reeve');
  for (const [file, text] of Object.entries(files)) writeFileSync(join(path, file), text);
  g(path, 'add', '-A');
  g(path, 'commit', '-qm', 'base');
  g(path, 'push', '-q', 'origin', 'main');
  return path;
}
const commit = (cwd: string, file: string, text: string, message: string) => {
  writeFileSync(join(cwd, file), text);
  g(cwd, 'add', file);
  g(cwd, '-c', 'user.email=reeve@example.com', '-c', 'user.name=Reeve', 'commit', '-qm', message);
};
const succeeded = (cardId: string, stage: 'planning' | 'in_progress', cwd: string) =>
  insertRun(db, {
    id: crypto.randomUUID(), cardId, kind: 'claude', stage, status: 'succeeded', stopReason: 'completed',
    sessionId: crypto.randomUUID(), prompt: 'Seeded.', cwd, model: 'sonnet',
    startedAt: new Date(Date.now() - 600_000), finishedAt: new Date(Date.now() - 300_000), totalCostUsd: 0.42,
  });
const doc = (cardId: string, kind: 'plan' | 'summary', content: string) =>
  db.insert(artifact).values({ id: crypto.randomUUID(), cardId, stage: kind === 'plan' ? 'planning' : 'in_progress', kind, content }).run();

// --- A playground to try real runs on -------------------------------------------
if (!listRepos(db).some((r) => r.name === 'playground')) {
  const path = gitRepo('playground', {
    'package.json': JSON.stringify({ name: 'playground', type: 'module', private: true, scripts: { test: 'node --test' } }, null, 2),
    'README.md': '# playground\n\nA tiny repo for trying Reeve on.\n',
    'math.mjs': 'export const add = (a, b) => a + b;\n',
    'math.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { add } from './math.mjs';\n\ntest('add', () => assert.equal(add(1, 2), 3));\n",
  });
  const repo = createRepo(db, {
    name: 'playground', repoPath: path, worktreeRoot: join(root, 'playground-wt'), defaultBranch: 'main', laneColor: '#34d399',
    // Slow on purpose, so a run has a long call to watch.
    testCommand: 'sleep 45 && node --test',
    focusedTestCommand: 'node --test {{paths}}',
  });
  createCard(db, {
    repoId: repo.id, stage: 'backlog', title: 'Add a multiply function',
    body: 'Add `multiply(a, b)` to `math.mjs`, with a test beside the one for `add`. Commit it.',
  });
  createCard(db, {
    repoId: repo.id, stage: 'backlog', title: 'Add a subtract function',
    body: 'Add `subtract(a, b)` to `math.mjs`, with a test. Commit it.',
  });
}

// --- A stacked pair ----------------------------------------------------------------
if (!listRepos(db).some((r) => r.name === 'stack')) {
  const path = gitRepo('stack', { 'README.md': '# stack\n', 'cart.ts': 'export const cart = [];\n' });
  const repo = createRepo(db, { name: 'stack', repoPath: path, worktreeRoot: join(root, 'stack-wt'), defaultBranch: 'main', laneColor: '#38bdf8' });

  const parentCard = createCard(db, {
    repoId: repo.id, stage: 'in_progress', title: 'Store saved carts',
    body: 'Persist a shopper\'s cart so they can come back to it.',
  });
  await ensureWorktree(db, writer, getCard(db, parentCard.id)!, repo);
  const parent = getCard(db, parentCard.id)!;
  commit(parent.worktreePath!, 'store.ts', 'export function saveCart() {}\nexport function loadCart() {}\n', 'Add saveCart and loadCart');
  succeeded(parent.id, 'in_progress', parent.worktreePath!);
  doc(parent.id, 'summary', '> Adds `saveCart` and `loadCart` in `store.ts`, kept for 30 days.\n');
  db.update(cardTable).set({ stage: 'testing' }).where(eq(cardTable.id, parent.id)).run();

  const childCard = createCard(db, {
    repoId: repo.id, stage: 'backlog', title: 'Saved cart page',
    body: 'A page listing the shopper\'s saved cart, using `loadCart`.',
  });
  addDependency(db, childCard.id, parent.id);
  db.update(cardTable).set({ stage: 'in_progress' }).where(eq(cardTable.id, childCard.id)).run();
  await ensureWorktree(db, writer, getCard(db, childCard.id)!, repo);
  const child = getCard(db, childCard.id)!;
  commit(child.worktreePath!, 'page.ts', "import { loadCart } from './store';\nexport const page = () => loadCart();\n", 'Add the saved cart page');
  succeeded(child.id, 'in_progress', child.worktreePath!);

  // And one that waits on two unmerged cards, which cannot stack.
  const other = createCard(db, { repoId: repo.id, stage: 'in_progress', title: 'Cart totals', body: 'Show the cart\'s total.' });
  const both = createCard(db, { repoId: repo.id, stage: 'backlog', title: 'Checkout summary', body: 'Totals and the saved cart together.' });
  addDependency(db, both.id, parent.id);
  addDependency(db, both.id, other.id);
}

// --- A run stopped at its budget ----------------------------------------------------
{
  const repo = listRepos(db).find((r) => r.name === 'playground')!;
  const c = createCard(db, { repoId: repo.id, stage: 'in_progress', title: 'Rewrite the math module', body: 'A big change that ran out of budget.' });
  db.update(cardTable).set({ budgetUsd: 2 }).where(eq(cardTable.id, c.id)).run();
  insertRun(db, {
    id: crypto.randomUUID(), cardId: c.id, kind: 'claude', stage: 'in_progress', status: 'failed', stopReason: 'budget_exhausted',
    errorMessage: 'run ended: error_max_budget_usd', sessionId: crypto.randomUUID(), prompt: 'Seeded.', cwd: repo.worktreeRoot,
    maxBudgetUsd: 2, totalCostUsd: 2.07, startedAt: new Date(Date.now() - 900_000), finishedAt: new Date(Date.now() - 60_000),
  });
}

// --- A project whose tasks build on each other ---------------------------------------
{
  const repo = listRepos(db).find((r) => r.name === 'playground')!;
  const project = createCard(db, {
    repoId: repo.id, kind: 'project', stage: 'backlog', title: 'A calculator',
    body: 'Grow math.mjs into a small calculator: the four operations, then a parser for "2 + 3 * 4".',
  });
  const ops = createCard(db, { repoId: repo.id, projectId: project.id, stage: 'release', title: 'The four operations', body: 'add, subtract, multiply, divide.' });
  db.update(cardTable).set({ mergedAt: new Date(), archivedAt: new Date() }).where(eq(cardTable.id, ops.id)).run();
  doc(ops.id, 'summary', '> All four operations in `math.mjs`; `divide` throws on zero rather than returning Infinity.\n\n## Where this departed from the plan\n\n- `divide(x, 0)` throws a `RangeError`: the brief did not say, and Infinity would leak into the parser.\n');
  const parser = createCard(db, { repoId: repo.id, projectId: project.id, stage: 'planning', title: 'Parse arithmetic expressions', body: 'Parse and evaluate "2 + 3 * 4" with precedence, using the operations.' });
  addDependency(db, parser.id, ops.id);
  const cli = createCard(db, { repoId: repo.id, projectId: project.id, stage: 'backlog', title: 'A calc command', body: 'A `calc` CLI that evaluates its argument with the parser.' });
  addDependency(db, cli.id, parser.id);
  doc(parser.id, 'plan', '> A recursive-descent parser in `parse.mjs`, calling the operations.\n');
}

writer.flush();
console.log(`seeded the scale board into ${config.dbFile}`);
process.exit(0);
