/**
 * Checks deciding on a suggested card without spending API credit: which
 * cards read as pending suggestions, what Accept and Reject each do through
 * the route, what the route refuses, that moving a suggestion out of Backlog
 * takes it on for good, that a rejected title is not suggested again, and
 * that the migration's backfill stamps only suggestions already decided.
 *
 *   REEVE_DB=/tmp/reeve-decide.db npx tsx packages/server/src/spikes/suggestion-decision-check.ts
 *
 * With no REEVE_DB it makes its own under /tmp rather than opening
 * data/reeve.db.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planningOutput, type ApiCard, type BoardResponse } from '@reeve/shared';

const scratch = mkdtempSync(join(tmpdir(), 'reeve-decide-'));
// Before anything reads config, which fixes the database path at import.
process.env.REEVE_DB ??= join(scratch, 'app.db');

const { config } = await import('../config.js');
const { createApp } = await import('../index.js');
const { cardEventsFor, cardsSuggestedBy, createRepo, getCard, insertRun, moveCard } =
  await import('../db/queries.js');
const { card: cardTable } = await import('../db/schema.js');
const { planningStage } = await import('../stages/planning.js');
const { stageContextFor } = await import('../runs/claude.js');
const { eq, sql } = await import('drizzle-orm');

// --- the migration's place in the journal ----------------------------------
type Journal = { entries: Array<{ tag: string; when: number }> };
const journal = JSON.parse(readFileSync(join(config.migrationsFolder, 'meta/_journal.json'), 'utf8')) as Journal;
const at = journal.entries.findIndex((e) => e.tag === '0022_suggestion_accepted');
assert.notEqual(at, -1, 'suggestion_accepted is in the journal');
assert.ok(journal.entries.slice(0, at).every((e) => e.when < journal.entries[at]!.when), 'the entry would be skipped');

const { app, db } = createApp();
const repo = createRepo(db, {
  name: `decide-check-${Date.now()}`,
  repoPath: '/tmp/decide-check', worktreeRoot: '/tmp/decide-check-worktrees', defaultBranch: 'main',
  setupCommand: null, testCommand: null, serverCommand: null,
  teardownCommand: null, finishCommand: null, laneColor: '#6b7db3',
});

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as T };
}
const onBoard = async (id: string) => (await call<BoardResponse>('GET', '/api/board')).json.cards.find((c) => c.id === id);
const decide = (id: string, decision: string) => call<ApiCard & { error?: string; detail?: string }>(
  'POST', `/api/cards/${id}/suggestion`, { decision },
);

const PLAN = {
  summary: 's', risk: 'low', files_to_touch: [], details: [], steps: [],
  open_questions: [], acceptance_criteria: [], captures: [],
};
const suggest = (suggesterId: string, ...titles: string[]) =>
  planningStage.onPersist!(
    db,
    stageContextFor(db, { card: getCard(db, suggesterId)!, repo, worktreePath: '/tmp/decide-check' }),
    planningOutput.parse({ ...PLAN, suggested_tasks: titles.map((title) => ({ title, body: `About ${title}.` })) }),
    insertRun(db, {
      id: crypto.randomUUID(), cardId: suggesterId, kind: 'claude', stage: 'planning', status: 'succeeded', cwd: '/tmp/x',
    }).id,
  );

// --- who is pending ----------------------------------------------------------
const suggester = (await call<ApiCard>('POST', '/api/cards', { title: 'Suggester', repoId: repo.id })).json;
const person = (await call<ApiCard>('POST', '/api/cards', { title: 'Made by a person', repoId: repo.id })).json;
suggest(suggester.id, 'Keep this one', 'Throw this away', 'Drag this one');
const byTitle = (t: string) => cardsSuggestedBy(db, suggester.id).find((c) => c.title === t)!;
const keep = byTitle('Keep this one');
const toss = byTitle('Throw this away');
const drag = byTitle('Drag this one');

for (const c of [keep, toss, drag]) assert.equal((await onBoard(c.id))!.pendingSuggestion, true, c.title);
assert.equal((await onBoard(person.id))!.pendingSuggestion, false, 'a card a person made');
assert.equal((await onBoard(suggester.id))!.pendingSuggestion, false, 'the suggester itself');
console.log('[reeve] suggested Backlog cards read as pending, and nothing else does');

// --- Accept ------------------------------------------------------------------
const accepted = await decide(keep.id, 'accepted');
assert.equal(accepted.status, 200);
assert.equal(accepted.json.pendingSuggestion, false);
assert.equal(accepted.json.stage, 'backlog', 'it stays where it is');
assert.equal(accepted.json.suggestedBy?.id, suggester.id, 'and keeps where it came from');
assert.ok(getCard(db, keep.id)!.suggestionAcceptedAt, 'stamped');
assert.deepEqual(
  cardEventsFor(db, keep.id).filter((e) => e.kind === 'suggestion_accepted').map((e) => [e.actor, e.stage]),
  [['human', 'backlog']],
);
console.log('[reeve] Accept stamps the card in Backlog and writes suggestion_accepted');

// --- Reject ------------------------------------------------------------------
const rejected = await decide(toss.id, 'rejected');
assert.equal(rejected.status, 200);
assert.ok(rejected.json.archivedAt, 'archived');
assert.equal(await onBoard(toss.id), undefined, 'off the board');
const archived = (await call<ApiCard[]>('GET', '/api/cards/archived')).json;
assert.ok(archived.some((c) => c.id === toss.id), 'and in the Archive');
assert.equal(getCard(db, toss.id)!.suggestionAcceptedAt, null, 'not stamped');
const archivedEvent = cardEventsFor(db, toss.id).find((e) => e.kind === 'archived');
assert.equal(archivedEvent?.meta?.['rejectedSuggestion'], true);
console.log('[reeve] Reject archives the card, marked as a rejected suggestion');

// A rerun that suggests the rejected title again does not remake it.
suggest(suggester.id, 'throw this AWAY', 'Something new');
assert.deepEqual(
  cardsSuggestedBy(db, suggester.id).map((c) => c.title).sort(),
  ['Drag this one', 'Keep this one', 'Something new', 'Throw this away'],
);
console.log('[reeve] a rejected title is not suggested again');

// --- what the route refuses ----------------------------------------------------
for (const [id, why, detail] of [
  [keep.id, 'already accepted', 'the suggestion was already accepted'],
  [toss.id, 'already rejected', 'the card is archived'],
  [person.id, 'made by a person', 'a person made this card'],
] as const) {
  for (const decision of ['accepted', 'rejected']) {
    const res = await decide(id, decision);
    assert.equal(res.status, 409, `${decision} on a card ${why}`);
    assert.equal(res.json.detail, detail);
  }
}
assert.equal((await decide(drag.id, 'maybe')).status, 400, 'an unknown decision');
assert.equal((await decide(crypto.randomUUID(), 'accepted')).status, 404, 'no such card');
assert.equal(getCard(db, drag.id)!.suggestionAcceptedAt, null, 'refusals changed nothing');
console.log('[reeve] the route refuses decided cards, cards a person made, and bad bodies');

// --- moving it on is taking it on --------------------------------------------
// `moveCard` directly: the move route would start Planning, which needs a real
// worktree, and the stamp is `moveCard`'s whoever calls it.
moveCard(db, drag.id, 'planning', 0);
assert.ok(getCard(db, drag.id)!.suggestionAcceptedAt, 'leaving Backlog stamps it');
assert.equal((await onBoard(drag.id))!.pendingSuggestion, false);
const out = await decide(drag.id, 'accepted');
assert.equal(out.status, 409);
assert.equal(out.json.detail, 'the suggestion was already accepted');
moveCard(db, drag.id, 'backlog', 0);
assert.equal((await onBoard(drag.id))!.pendingSuggestion, false, 'back in Backlog, it does not ask again');
// A reorder within Backlog is not taking it on.
const fresh = cardsSuggestedBy(db, suggester.id).find((c) => c.title === 'Something new')!;
moveCard(db, fresh.id, 'backlog', 0);
assert.equal((await onBoard(fresh.id))!.pendingSuggestion, true, 'a reorder in Backlog');
// Nor is moving a card a person made: it never gets a stamp.
moveCard(db, person.id, 'planning', 0);
assert.equal(getCard(db, person.id)!.suggestionAcceptedAt, null, 'a card a person made');
console.log('[reeve] moving a suggestion out of Backlog accepts it for good');

// --- restored from the Archive, a rejection asks again -------------------------
const restored = await call<ApiCard>('POST', `/api/cards/${toss.id}/restore`);
assert.equal(restored.json.pendingSuggestion, true, 'the person changed their mind, and has not said to what');
console.log('[reeve] a rejected suggestion restored from the Archive is pending again');

// --- the migration's backfill ----------------------------------------------------
// Re-run on three undecided suggestions: one out of Backlog, one archived, and
// one still waiting. Only the first two were decided before there was a column.
suggest(suggester.id, 'Planned before the column', 'Archived before the column', 'Still waiting');
const old = cardsSuggestedBy(db, suggester.id);
const planned = old.find((c) => c.title === 'Planned before the column')!;
const gone = old.find((c) => c.title === 'Archived before the column')!;
const waiting = old.find((c) => c.title === 'Still waiting')!;
db.update(cardTable).set({ stage: 'planning' }).where(eq(cardTable.id, planned.id)).run();
db.update(cardTable).set({ archivedAt: new Date() }).where(eq(cardTable.id, gone.id)).run();
const migration = readFileSync(join(config.migrationsFolder, '0022_suggestion_accepted.sql'), 'utf8');
const backfill = migration.split('--> statement-breakpoint')[1]!;
db.run(sql.raw(backfill));
assert.equal(getCard(db, planned.id)!.suggestionAcceptedAt?.getTime(), planned.createdAt.getTime(), 'out of Backlog');
assert.equal(getCard(db, gone.id)!.suggestionAcceptedAt?.getTime(), gone.createdAt.getTime(), 'archived');
assert.equal(getCard(db, waiting.id)!.suggestionAcceptedAt, null, 'still in Backlog');
assert.equal(getCard(db, person.id)!.suggestionAcceptedAt, null, 'a card a person made, out of Backlog');
console.log('[reeve] the backfill stamps only suggestions already decided');

console.log('[reeve] suggestion-decision-check passed');
process.exit(0);
