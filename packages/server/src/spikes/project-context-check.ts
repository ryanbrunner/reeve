/**
 * Throwaway check on what a project's task is told about the rest of the
 * project (projectContext.ts), with no API credit: four tasks — one merged,
 * one with its pull request open, one only planned, and the one being run,
 * which waits on the first two — and the section its In Progress prompt gets.
 *
 *   REEVE_DB=/tmp/project-context.db npx tsx packages/server/src/spikes/project-context-check.ts
 */
import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { addDependency, createCard, createRepo, getCard } from '../db/queries.js';
import { artifact, card as cardTable } from '../db/schema.js';
import { createApp } from '../index.js';
import { projectContextFor } from '../projectContext.js';
import { stageContextFor } from '../runs/claude.js';
import { inProgressStage } from '../stages/in_progress.js';

if (!process.env.REEVE_DB) throw new Error('give this a scratch REEVE_DB');
for (const f of [config.dbFile, `${config.dbFile}-wal`, `${config.dbFile}-shm`]) rmSync(f, { force: true });

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const { db } = createApp();
const repo = createRepo(db, { name: 'shop', repoPath: '/tmp/nowhere', worktreeRoot: '/tmp/nowhere-wt', defaultBranch: 'main' });
const project = createCard(db, { repoId: repo.id, title: 'Saved carts', kind: 'project', body: 'Shoppers can save a cart and come back to it on another device.', stage: 'backlog' });
const task = (title: string, stage: 'backlog' | 'in_progress' | 'release' | 'planning') =>
  createCard(db, { repoId: repo.id, title, body: '', stage, projectId: project.id });
const doc = (cardId: string, kind: 'plan' | 'summary', content: string) =>
  db.insert(artifact).values({ id: crypto.randomUUID(), cardId, stage: kind === 'plan' ? 'planning' : 'in_progress', kind, content }).run();

const schema = task('Store carts server-side', 'release');
db.update(cardTable).set({ mergedAt: new Date(), archivedAt: new Date(), branchName: 'reeve/1-store' }).where(eq(cardTable.id, schema.id)).run();
doc(schema.id, 'summary', '> Adds a `saved_cart` table and `saveCart`/`loadCart` in `src/carts/store.ts`.\n\n## Where this departed from the plan\n\n- Kept carts for 30 days, not forever: the brief said "come back to it".\n\n## Files\n\n- `src/carts/store.ts`\n- `migrations/0042_saved_cart.sql`\n');

const api = task('Cart API endpoints', 'release');
db.update(cardTable).set({ prUrl: 'https://github.com/example/shop/pull/77', branchName: 'reeve/2-api' }).where(eq(cardTable.id, api.id)).run();
doc(api.id, 'summary', '> `GET/PUT /api/cart/saved`, authenticated, calling `loadCart`/`saveCart`.\n');

const later = task('Email a saved cart reminder', 'backlog');
doc(later.id, 'plan', '> A nightly job that emails shoppers whose saved cart is a week old.\n');

const ui = task('Saved cart page', 'in_progress');
addDependency(db, ui.id, schema.id);
addDependency(db, ui.id, api.id);
addDependency(db, later.id, ui.id);

const section = projectContextFor(db, getCard(db, ui.id)!);
console.log(`\n${section}\n`);
check('it names the project and opens its brief', section.includes('**Saved carts**') && section.includes('save a cart and come back'));
check('a merged dependency carries its notes, decisions included', section.includes('#1 Store carts server-side**: merged — **this card waits on it**') && section.includes('30 days'));
check('an open one says where its pull request is, and its branch', section.includes('pull request open (https://github.com/example/shop/pull/77)') && section.includes('reeve/2-api'));
check('a task only planned says what it means to do', section.includes('Planned: A nightly job'));
check('and one waiting on this card says so', section.includes('#3 Email a saved cart reminder**: in Backlog, not started — waits on this card'));
check('this card is not listed among the others', !section.includes('Saved cart page'));

const prompt = inProgressStage.buildPrompt(stageContextFor(db, { card: getCard(db, ui.id)!, repo, worktreePath: '/tmp/nowhere-wt', reviewNotes: null, answers: [] }, 'in_progress'), {});
check('In Progress\'s prompt carries it, between the brief and the plan', prompt.indexOf('## The rest of this project') > prompt.indexOf('## The work') && prompt.indexOf('## The rest of this project') < prompt.indexOf('## The approved plan'));

const alone = createCard(db, { repoId: repo.id, title: 'No project', body: '', stage: 'in_progress' });
check('a card in no project gets nothing', projectContextFor(db, alone) === '');

// A big project stays bounded.
for (let i = 0; i < 40; i++) {
  const t = task(`Task ${i}`, 'backlog');
  doc(t.id, 'summary', `> ${'Did a thing. '.repeat(40)}`);
}
const big = projectContextFor(db, getCard(db, ui.id)!);
check('forty more tasks stay within the budget, dependencies kept whole', big.length < 11_000 && big.includes('30 days'), `${big.length} chars`);

console.log(`\n${failures === 0 ? 'all good' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
