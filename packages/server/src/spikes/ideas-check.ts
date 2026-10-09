/**
 * Throwaway check on VIBES MODE thinking of its own work: when a repo is asked
 * for ideas, on which card, how often, and what the answer turns into.
 *
 *   REEVE_DB=/tmp/ideas.db npx tsx packages/server/src/spikes/ideas-check.ts
 *
 * Never started for real, so no API credit is spent: the rule is asked who it
 * would pick, the sweep's half is only ever run with the cap full or the switch
 * off, and the task is fed canned output.
 */
import assert from 'node:assert/strict';
import { PLACEHOLDER_TITLE } from '@reeve/shared';
import { createApp } from '../index.js';
import {
  archiveCard,
  archiveProject,
  cardEventsFor,
  cardLinks,
  cardsInRepo,
  createCard,
  createRepo,
  criteriaFor,
  getCard,
  insertRun,
  moveCard,
  runsForCard,
  setRunStatus,
  updateSettings,
} from '../db/queries.js';
import type { Card, Repo } from '../db/schema.js';
import { ideasTask } from '../stages/ideas.js';
import type { StageContext } from '../stages/types.js';
import { ideaSource, thinkOfIdeas } from '../vibes/ideas.js';
import { vibesState } from '../vibes/state.js';

const { db, writer } = createApp();

const repo = (name: string) =>
  createRepo(db, {
    name: `${name}-${Date.now()}`, repoPath: '/tmp/x', worktreeRoot: '/tmp/x', defaultBranch: 'main',
    setupCommand: null, testCommand: null, serverCommand: null,
    teardownCommand: null, finishCommand: null, laneColor: null,
  });
// Events are compared to the switch's moment by the millisecond, so make sure
// the ones that are meant to come after it do.
const tick = () => new Promise((r) => setTimeout(r, 5));
const finish = (id: string) => moveCard(db, id, 'release', 0, 'claude')!;
const sourceOf = (r: Repo) => ideaSource(db, r, new Date(vibesState(db)!.since))?.title ?? null;

// From off, so the switch's moment is this run's and not a crashed one's.
updateSettings(db, { vibes: false });
const shop = repo('ideas-shop');
// Finished before the switch went on: not what anyone flipped it for.
createCard(db, { title: 'Old work', repoId: shop.id, stage: 'release' });
updateSettings(db, { vibes: true, maxConcurrentRuns: 3 });
await tick();
assert.equal(sourceOf(shop), null, 'nothing has finished since the switch went on');

// Nothing while there is still work open.
const first = createCard(db, { title: 'Cart page', repoId: shop.id, stage: 'testing' });
const second = createCard(db, { title: 'Saved for later', repoId: shop.id, stage: 'in_progress' });
finish(first.id);
assert.equal(sourceOf(shop), null, 'a card is still in progress');

// The last card to finish, once nothing is open. A blank card someone has
// only just added is not open work.
createCard(db, { title: PLACEHOLDER_TITLE, repoId: shop.id, stage: 'backlog' });
await tick();
finish(second.id);
assert.equal(sourceOf(shop), 'Saved for later');

// Archived a few minutes after merging, it is still the last to finish, and the
// card before it does not take its place.
archiveCard(db, second.id, { reason: 'merged' });
assert.equal(sourceOf(shop), 'Saved for later', 'archiving it changes nothing');

// Once per card, whatever became of the run, and never back to an older one.
const run = insertRun(db, {
  id: crypto.randomUUID(), cardId: second.id, kind: 'claude', stage: 'release',
  status: 'running', task: ideasTask.id, cwd: '/tmp/x',
});
assert.equal(sourceOf(shop), null, 'already thinking');
setRunStatus(db, run.id, { status: 'failed' });
assert.equal(sourceOf(shop), null, 'thought once already, and it came to nothing');

// The sweep's half starts nothing with the cap full, or with the switch off.
const other = repo('ideas-other');
const lone = createCard(db, { title: 'Lone card', repoId: other.id, stage: 'testing' });
await tick();
finish(lone.id);
assert.equal(sourceOf(other), 'Lone card');
updateSettings(db, { maxConcurrentRuns: 0 });
await thinkOfIdeas(db, writer);
assert.equal(runsForCard(db, lone.id).length, 0, 'the cap is full');
updateSettings(db, { vibes: false, maxConcurrentRuns: 3 });
await thinkOfIdeas(db, writer);
assert.equal(runsForCard(db, lone.id).length, 0, 'the switch is off');
updateSettings(db, { vibes: true });
// Longer here: a card's `created` event takes the card's own `createdAt`,
// which SQLite stamps to the second, so one made in the same second as the
// switch would read as made before it.
await new Promise((r) => setTimeout(r, 1_100));

// What an answer becomes: at most three cards in Backlog, made by Claude, each
// suggested by the card it came after, and nothing the repo already had.
const stored = getCard(db, second.id)!;
const ctx = { card: stored, repo: shop, worktreePath: shop.repoPath } as StageContext;
const before = cardsInRepo(db, shop.id).length;
const idea = (title: string) => ({ title, body: `Why ${title}`, criteria: [`${title} works`] });
ideasTask.onPersist!(db, ctx, {
  ideas: [idea('cart page'), idea('  '), idea('Gift notes'), idea('Wishlists'), idea('Gift notes'), idea('Reorder'), idea('One too many')],
}, 'run');
const after = cardsInRepo(db, shop.id);
assert.equal(after.length - before, 3);
for (const title of ['Gift notes', 'Wishlists', 'Reorder']) {
  const c = after.find((x) => x.title === title)!;
  assert.ok(c, title);
  assert.equal(c.stage, 'backlog');
  assert.equal(c.vibes, false, 'these go because the board is on, not on a flag of their own');
  const created = cardEventsFor(db, c.id).find((e) => e.kind === 'created')!;
  assert.equal(created.actor, 'claude');
  assert.deepEqual(created.meta, { ideaFrom: second.id, runId: 'run' });
  assert.deepEqual(criteriaFor(db, c.id).map((x) => [x.text, x.source]), [[`${c.title} works`, 'claude']]);
  // Named on the board as a stage's suggested task is, even with the card
  // it came after merged and archived.
  assert.equal(c.suggestedById, second.id);
  assert.equal(cardLinks(db, c.id)(c.id).suggestedBy?.id, second.id, 'the board draws it as suggested');
  assert.equal(c.projectId, null, 'no lane, as the card it came after had none');
}
assert.equal(ideasTask.summarise({ ideas: [] }), 'Thought of nothing worth doing');

// Counted and told on the HUD, and a project's split, also made by Claude, is
// not. Nor is a stage's suggested task, which is suggested by a card too.
createCard(db, { title: 'From a split', repoId: shop.id, stage: 'backlog', actor: 'claude' });
createCard(db, { title: 'An aside', repoId: shop.id, stage: 'backlog', suggestedById: second.id, actor: 'claude' });
const state = vibesState(db)!;
assert.equal(state.ideas, 3);
assert.ok(state.log.includes('Claude thought of “Reorder” · building it next'), state.log.join('\n'));

// In the lane of the card it came after, as a stage's suggested task is, so
// its chip never points into a lane it sits outside.
const ideaAfter = (source: Card, title: string) => {
  ideasTask.onPersist!(db, { ...ctx, card: source }, { ideas: [idea(title)] }, 'run');
  return cardsInRepo(db, shop.id).find((c) => c.title === title)!;
};
const lane = createCard(db, { title: 'Checkout', kind: 'project', repoId: shop.id });
const inLane = createCard(db, { title: 'Pay later', repoId: shop.id, stage: 'release', projectId: lane.id });
assert.equal(ideaAfter(inLane, 'Split payments').projectId, lane.id, 'in the lane it came from');

// The lane the card is in now, not the one it was in when the run started.
const drifted = createCard(db, { title: 'Receipts', repoId: shop.id, stage: 'release' });
moveCard(db, drifted.id, 'release', 0, 'human', lane.id);
assert.equal(ideaAfter(drifted, 'Emailed receipts').projectId, lane.id, 'dragged into the lane mid-run');

// Nowhere, once that project has been archived: taking the card it came after
// with it, since that is in Release.
archiveProject(db, lane.id);
const gone = getCard(db, inLane.id)!;
assert.ok(gone.archivedAt, 'archived with its project');
assert.equal(ideaAfter(gone, 'Store credit').projectId, null, 'no lane that is no longer on the board');

// --- the suggest-tasks switch ------------------------------------------------
// Off, ideaSource answers null for a repo that would otherwise get ideas, and
// a run already in flight when it went off lands no cards.
updateSettings(db, { vibes: true, suggestTasks: false });
const quiet = repo('ideas-quiet');
const quietCard = createCard(db, { title: 'Last one', repoId: quiet.id, stage: 'testing' });
await tick();
finish(quietCard.id);
assert.equal(sourceOf(quiet), null, 'suggestions off: a dry repo gets no ideas');

const beforeQuiet = cardsInRepo(db, quiet.id).length;
const quietCtx = { card: getCard(db, quietCard.id)!, repo: quiet, worktreePath: quiet.repoPath } as StageContext;
ideasTask.onPersist!(db, quietCtx, { ideas: [idea('Should not land')] }, 'run-quiet');
assert.equal(cardsInRepo(db, quiet.id).length, beforeQuiet, 'suggestions off: an ideas run already going lands nothing');

// A positive control: the same still-dry repo gets an idea the moment the
// switch goes back on, so the null above was the switch and not some other
// reason the repo never qualifies.
updateSettings(db, { suggestTasks: true });
assert.equal(sourceOf(quiet), 'Last one', 'suggestions back on: the same dry repo gets ideas again');
console.log('[reeve] suggestions off: ideaSource answers null, and onPersist lands no cards');

updateSettings(db, { vibes: false });
console.log('[reeve] ideas check passed');
process.exit(0);
