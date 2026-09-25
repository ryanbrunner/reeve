import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { RUNNABLE_STAGES, type ApiSettings, type StageRunDefaults, type UpdateSettingsBody } from '@reeve/shared';
import { config } from '../config.js';
import type { Db } from './client.js';
import {
  acceptanceCriterion,
  artifact,
  asset,
  card,
  cardEvent,
  cardRef,
  difference,
  question,
  repo,
  review,
  run,
  runEvent,
  settings,
  type AcceptanceCriterion,
  type AssetKind,
  type Card,
  type ArtifactKind,
  type CardRefKind,
  type CriterionVerdict,
  type Question,
  type CardEventActor,
  type CardEventKind,
  type CardStage,
  type NewCardEvent,
  type NewRun,
  type NewRunEvent,
  type RunStatus,
} from './schema.js';

const NON_TERMINAL: RunStatus[] = ['queued', 'running', 'stopping'];

/** The board query: every live card with its repo's lane colour. */
export function boardCards(db: Db) {
  return db
    .select({
      card,
      repoName: repo.name,
      laneColor: repo.laneColor,
    })
    .from(card)
    .leftJoin(repo, eq(card.repoId, repo.id))
    .where(isNull(card.archivedAt))
    .orderBy(asc(card.stage), asc(card.position))
    .all();
}

/**
 * Every live card with a pull request GitHub might yet merge, beside the repo
 * to ask from. Not filtered on stage: a card dragged back out of Done for
 * another round keeps its pull request, and it can be merged from there.
 */
export function cardsAwaitingMerge(db: Db) {
  return db
    .select({ card, repo })
    .from(card)
    .innerJoin(repo, eq(card.repoId, repo.id))
    .where(and(isNotNull(card.prUrl), isNull(card.mergedAt), isNull(card.archivedAt)))
    .all();
}

export function cardsInStage(db: Db, stage: CardStage): Card[] {
  return db
    .select()
    .from(card)
    .where(and(eq(card.stage, stage), isNull(card.archivedAt)))
    .orderBy(asc(card.position))
    .all();
}

/** SSE replay. `(run_id, seq)` is the primary key, so this needs no secondary index. */
export function eventsSince(db: Db, runId: string, since: number) {
  return db
    .select()
    .from(runEvent)
    .where(and(eq(runEvent.runId, runId), gt(runEvent.seq, since)))
    .orderBy(asc(runEvent.seq))
    .all();
}

/**
 * Stamped from JS rather than left to the column default, which is
 * `unixepoch() * 1000` and so accurate only to the second.
 *
 * Every "which run is current" question in the system — the board's activity,
 * the modal's plan, the review gate — answers itself by ordering on this. Two
 * runs starting in the same second would make that order arbitrary, and a
 * rejection forks a new run immediately after the one it rejected.
 */
export function insertRun(db: Db, values: NewRun) {
  return db.insert(run).values({ createdAt: new Date(), ...values }).returning().get();
}

/** Batched to keep synchronous SQLite writes off the event loop's critical path. */
export function insertEvents(db: Db, rows: NewRunEvent[]): void {
  if (rows.length === 0) return;
  db.transaction((tx) => {
    tx.insert(runEvent).values(rows).run();
  });
}

/** The highest seq a run has written, or 0. Where a live-only stream starts. */
export function latestSeq(db: Db, runId: string): number {
  return (
    db
      .select({ max: sql<number | null>`max(${runEvent.seq})` })
      .from(runEvent)
      .where(eq(runEvent.runId, runId))
      .get()?.max ?? 0
  );
}

export function nextSeq(db: Db, runId: string): number {
  const row = db
    .select({ max: sql<number | null>`max(${runEvent.seq})` })
    .from(runEvent)
    .where(eq(runEvent.runId, runId))
    .get();
  return (row?.max ?? 0) + 1;
}

/**
 * Boot reaper: a restart orphans every in-flight run. Session ids were written up
 * front, so these stay resumable rather than being lost.
 */
export function reapOrphanedRuns(db: Db, now: Date) {
  return db
    .update(run)
    .set({ status: 'interrupted', finishedAt: now })
    .where(inArray(run.status, NON_TERMINAL))
    .returning({ id: run.id, pid: run.pid, kind: run.kind, sessionId: run.sessionId })
    .all();
}

/**
 * The run that IS the card's attempt at its current stage: Claude only, and
 * only for the stage the card sits in.
 *
 * Every question about "the current run" goes through here — the board's
 * activity, the review gate, the questions in the modal — because the answer
 * has to be the same one in all three. A stage-scoped query that did not
 * filter by kind used to exist beside this, and starting a dev server after
 * the last Claude run made it answer with the server: the card was suddenly
 * unreviewable because the newest run for the stage was a `vite` process.
 * An out-of-band task — Suggest — is excluded for the same reason.
 */
export function latestClaudeRunForStage(db: Db, cardId: string, stage: CardStage) {
  return db
    .select()
    .from(run)
    .where(and(eq(run.cardId, cardId), eq(run.stage, stage), eq(run.kind, 'claude'), isNull(run.task)))
    .orderBy(desc(run.createdAt))
    .limit(1)
    .get();
}

/**
 * A task of this kind still in flight for the card, if there is one.
 *
 * Read off the rows rather than the registry, which only hears about a run once
 * its body has started: two requests close together would both find it empty.
 * The boot reaper settles anything a restart left behind, so a stale row here
 * cannot lock the task out for good.
 */
export function liveTaskRun(db: Db, cardId: string, task: string) {
  return db
    .select()
    .from(run)
    .where(and(eq(run.cardId, cardId), eq(run.task, task), inArray(run.status, NON_TERMINAL)))
    .get();
}

/**
 * A stage run still in flight for the card, in any column. The same reading as
 * `liveTaskRun`, for the same reason, but for the one run a card may have at a
 * time: a planning run carries on after the card is dragged to In Progress,
 * and the stage it was for does not make it any less the card's run.
 */
export function liveStageRun(db: Db, cardId: string) {
  return db
    .select()
    .from(run)
    .where(and(eq(run.cardId, cardId), eq(run.kind, 'claude'), isNull(run.task), inArray(run.status, NON_TERMINAL)))
    .get();
}

// ---------------------------------------------------------------------------
// Board mutations
// ---------------------------------------------------------------------------

const POSITION_GAP = 1000;
/** Below this, float precision starts to bite and the column is renormalised. */
const MIN_GAP = 0.0001;

/**
 * Fractional index for dropping a card at `index` within `stage`.
 * Averaging neighbours means a drag rewrites one row, not the whole column.
 */
export function positionForSlot(db: Db, stage: CardStage, index: number, excludeId?: string): number {
  const siblings = cardsInStage(db, stage).filter((c) => c.id !== excludeId);
  const before = siblings[index - 1]?.position;
  const after = siblings[index]?.position;
  if (before === undefined && after === undefined) return POSITION_GAP;
  if (before === undefined) return after! - POSITION_GAP;
  if (after === undefined) return before + POSITION_GAP;
  return (before + after) / 2;
}

/** Rewrite a column to evenly spaced integers once fractions get too tight. */
export function renormaliseIfNeeded(db: Db, stage: CardStage): boolean {
  const siblings = cardsInStage(db, stage);
  let tight = false;
  for (let i = 1; i < siblings.length; i++) {
    const gap = (siblings[i]?.position ?? 0) - (siblings[i - 1]?.position ?? 0);
    if (gap < MIN_GAP) { tight = true; break; }
  }
  if (!tight) return false;
  db.transaction((tx) => {
    siblings.forEach((c, i) => {
      tx.update(card).set({ position: (i + 1) * POSITION_GAP }).where(eq(card.id, c.id)).run();
    });
  });
  return true;
}

/**
 * The only place a card's stage changes, and it is only ever reached by a human
 * — a drag, a click in the stage rail, or an approval. A move into a different
 * column is recorded; a reorder within one is not, because where a card sits
 * among its neighbours is not a thing anyone wants to read back later.
 */
export function moveCard(db: Db, id: string, stage: CardStage, index: number) {
  const before = getCard(db, id);
  const position = positionForSlot(db, stage, index, id);
  const updated = db
    .update(card)
    .set({ stage, position, updatedAt: new Date() })
    .where(eq(card.id, id))
    .returning()
    .get();
  if (before && before.stage !== stage) {
    insertCardEvent(db, {
      cardId: id,
      actor: 'human',
      kind: 'moved',
      stage: before.stage,
      fromStage: before.stage,
      toStage: stage,
    });
  }
  renormaliseIfNeeded(db, stage);
  return updated;
}

export function createCard(
  db: Db,
  values: { title: string; body?: string; repoId?: string | null; stage?: CardStage; generateMockups?: boolean },
) {
  const stage = values.stage ?? 'backlog';
  const siblings = cardsInStage(db, stage);
  const last = siblings[siblings.length - 1]?.position ?? 0;
  const repoId = values.repoId ?? null;
  const created = db
    .insert(card)
    .values({
      id: crypto.randomUUID(),
      number: nextCardNumber(db, repoId),
      title: values.title,
      body: values.body ?? '',
      repoId,
      stage,
      position: last + POSITION_GAP,
      // Left out when not given, so the column's default decides.
      ...(values.generateMockups === undefined ? {} : { generateMockups: values.generateMockups }),
    })
    .returning()
    .get();
  // The first entry in the card's story, and the one the stage rail reads as
  // the moment it arrived in whatever column it started in.
  insertCardEvent(db, {
    cardId: created.id,
    actor: 'human',
    kind: 'created',
    stage,
    createdAt: created.createdAt,
  });
  return created;
}

/**
 * Next free `#n` for a repo. Counting live rows would reuse an archived
 * card's number, so this reads the high-water mark instead: numbers are handed
 * out once and never again, which is what makes them worth quoting to a person.
 */
function nextCardNumber(db: Db, repoId: string | null): number {
  const top = db
    .select({ max: sql<number | null>`max(${card.number})` })
    .from(card)
    .where(repoId === null ? isNull(card.repoId) : eq(card.repoId, repoId))
    .get();
  return (top?.max ?? 0) + 1;
}

/**
 * Moving a card to another repo renumbers it into that repo's sequence.
 * `#n` is per-repo, so carrying the old number across would put two `#3`s in
 * one repo — worse than a number that changed once while the card was still
 * being filed. The number it vacates is not reused: `nextCardNumber` reads a
 * high-water mark, not a count.
 */
export function updateCard(
  db: Db,
  id: string,
  patch: Partial<Pick<Card, 'title' | 'body' | 'repoId' | 'model' | 'effort' | 'generateMockups'>>,
) {
  const before = patch.repoId === undefined ? undefined : getCard(db, id);
  const reassigned = before !== undefined && patch.repoId !== before.repoId;
  return db
    .update(card)
    .set({
      ...patch,
      ...(reassigned ? { number: nextCardNumber(db, patch.repoId ?? null) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(card.id, id))
    .returning()
    .get();
}

/**
 * Taking a card off the board is a soft delete: the row, its runs and its
 * worktree all stay put, and `archivedCards` is where it can be found again.
 */
export function archiveCard(db: Db, id: string) {
  const now = new Date();
  const archived = db
    .update(card)
    .set({ archivedAt: now, updatedAt: now })
    .where(and(eq(card.id, id), isNull(card.archivedAt)))
    .returning()
    .get();
  if (archived) insertCardEvent(db, { cardId: id, actor: 'human', kind: 'archived', stage: archived.stage });
  return archived;
}

/**
 * Back onto the board at the foot of the column it left. Not at its old
 * position: the column may have been renormalised while it was away, and a
 * card reappearing wedged between two others is harder to spot than one at
 * the bottom.
 */
export function restoreCard(db: Db, id: string) {
  const before = getCard(db, id);
  if (!before?.archivedAt) return undefined;
  const stage = before.stage as CardStage;
  const restored = db
    .update(card)
    .set({
      archivedAt: null,
      position: positionForSlot(db, stage, cardsInStage(db, stage).length, id),
      updatedAt: new Date(),
    })
    .where(eq(card.id, id))
    .returning()
    .get();
  insertCardEvent(db, { cardId: id, actor: 'human', kind: 'restored', stage });
  renormaliseIfNeeded(db, stage);
  return restored;
}

/** The archive: every card taken off the board, most recently first. */
export function archivedCards(db: Db) {
  return db
    .select({
      card,
      repoName: repo.name,
      laneColor: repo.laneColor,
    })
    .from(card)
    .leftJoin(repo, eq(card.repoId, repo.id))
    .where(isNotNull(card.archivedAt))
    .orderBy(desc(card.archivedAt))
    .all();
}

export function getCard(db: Db, id: string) {
  return db.select().from(card).where(eq(card.id, id)).get();
}

export function listRepos(db: Db) {
  return db.select().from(repo).where(isNull(repo.archivedAt)).orderBy(asc(repo.name)).all();
}

export function createRepo(db: Db, values: Omit<typeof repo.$inferInsert, 'id' | 'createdAt'>) {
  return db.insert(repo).values({ ...values, id: crypto.randomUUID() }).returning().get();
}

export function updateRepo(db: Db, id: string, patch: Partial<typeof repo.$inferInsert>) {
  return db.update(repo).set(patch).where(eq(repo.id, id)).returning().get();
}

/**
 * The stored row with every unset field filled from `config`. Stage defaults
 * are filled out to every runnable stage, with nulls where nothing is set:
 * those fall through at run time, not here.
 */
export function getSettings(db: Db): ApiSettings {
  const row = db.select().from(settings).where(eq(settings.id, 1)).get();
  const stored = row?.stageDefaults ?? {};
  return {
    maxConcurrentRuns: row?.maxConcurrentRuns ?? config.maxConcurrentRuns,
    stageDefaults: Object.fromEntries(
      RUNNABLE_STAGES.map((s) => [s, { model: stored[s]?.model ?? null, effort: stored[s]?.effort ?? null }]),
    ) as StageRunDefaults,
  };
}

export function updateSettings(db: Db, patch: UpdateSettingsBody) {
  // Drizzle refuses an update with nothing in its SET, and an empty PATCH is no change anyway.
  if (Object.keys(patch).length === 0) return getSettings(db);
  const { stageDefaults, ...rest } = patch;
  const values = {
    ...rest,
    // Merged into what is stored rather than written over it, so saving one
    // stage's row leaves the other stages as they were.
    ...(stageDefaults ? { stageDefaults: { ...getSettings(db).stageDefaults, ...stageDefaults } } : {}),
  };
  db.insert(settings)
    .values({ ...values, id: 1 })
    .onConflictDoUpdate({ target: settings.id, set: values })
    .run();
  return getSettings(db);
}

export function runsForCard(db: Db, cardId: string) {
  return db.select().from(run).where(eq(run.cardId, cardId)).orderBy(desc(run.createdAt)).all();
}

export function getRun(db: Db, id: string) {
  return db.select().from(run).where(eq(run.id, id)).get();
}

export function setRunStatus(db: Db, id: string, patch: Partial<typeof run.$inferInsert>) {
  return db.update(run).set(patch).where(eq(run.id, id)).returning().get();
}

// ---------------------------------------------------------------------------
// Artifacts and reviews
// ---------------------------------------------------------------------------

export function artifactsForCard(db: Db, cardId: string) {
  return db
    .select()
    .from(artifact)
    .where(eq(artifact.cardId, cardId))
    .orderBy(desc(artifact.createdAt))
    .all();
}

export function latestArtifact(db: Db, cardId: string, stage: CardStage, kind: ArtifactKind) {
  return db
    .select()
    .from(artifact)
    .where(and(eq(artifact.cardId, cardId), eq(artifact.stage, stage), eq(artifact.kind, kind)))
    .orderBy(desc(artifact.createdAt))
    .limit(1)
    .get();
}

/** The most recent run of a given stage, whatever its outcome. */

export function insertReview(db: Db, values: typeof review.$inferInsert) {
  return db.insert(review).values(values).returning().get();
}

export function reviewsForCard(db: Db, cardId: string) {
  return db.select().from(review).where(eq(review.cardId, cardId)).orderBy(desc(review.createdAt)).all();
}

// ---------------------------------------------------------------------------
// The card's story
// ---------------------------------------------------------------------------

export interface CardEventDraft {
  cardId: string;
  actor: CardEventActor;
  kind: CardEventKind;
  stage?: CardStage | null;
  runId?: string | null;
  fromStage?: CardStage | null;
  toStage?: CardStage | null;
  body?: string | null;
  meta?: Record<string, unknown> | null;
  /** Only for backfills, where the event's real time is not now. */
  createdAt?: Date;
}

/**
 * Stamped from JS rather than left to the column default, which is
 * `unixepoch() * 1000` and so only accurate to the second. Everywhere else
 * that is fine; here it is not. Approving a card writes a verdict and a move
 * in the same breath, and at second resolution the timeline could show them
 * the wrong way round.
 */
export function insertCardEvent(db: Db, draft: CardEventDraft) {
  const row: NewCardEvent = { createdAt: new Date(), ...draft, id: crypto.randomUUID() };
  return db.insert(cardEvent).values(row).returning().get();
}

/**
 * Newest first: the activity tab reads top-down and so does a person.
 *
 * Tie-broken on rowid, which is insertion order, because `createdAt` is only
 * accurate to the millisecond and several of these land together — approving a
 * card writes a verdict and a move in the same breath. An id tie-break would
 * be a random UUID, which is to say no order at all.
 */
export function cardEventsFor(db: Db, cardId: string) {
  return db
    .select()
    .from(cardEvent)
    .where(eq(cardEvent.cardId, cardId))
    .orderBy(desc(cardEvent.createdAt), desc(sql`rowid`))
    .all();
}

/**
 * When the card entered each stage, or null for stages it has never reached.
 *
 * Read off the `moved` events rather than stored, for the same reason activity
 * is derived: a second copy of the card's history is a second thing that can be
 * wrong. A card that has bounced back to a column shows its LATEST arrival,
 * which is what "since 10:38" means to the person reading it.
 */
export function stageHistory(db: Db, cardId: string): Partial<Record<CardStage, number>> {
  const entered: Partial<Record<CardStage, number>> = {};
  // Oldest first, so a later arrival in the same column overwrites an earlier one.
  for (const e of cardEventsFor(db, cardId).reverse()) {
    const at = e.createdAt?.getTime();
    if (at === undefined) continue;
    if (e.kind === 'moved' && e.toStage) entered[e.toStage] = at;
    // A card starts life already in a column, and never moved into it.
    else if (e.kind === 'created' && e.stage) entered[e.stage] = at;
  }
  return entered;
}

// ---------------------------------------------------------------------------
// What "done" means, and what to read first
// ---------------------------------------------------------------------------

export function criteriaFor(db: Db, cardId: string) {
  return db
    .select()
    .from(acceptanceCriterion)
    .where(eq(acceptanceCriterion.cardId, cardId))
    .orderBy(asc(acceptanceCriterion.position))
    .all();
}

/** Appended at the end of the list, which is where a new one belongs. */
export function addCriterion(
  db: Db,
  cardId: string,
  text: string,
  source: CardEventActor = 'human',
) {
  const siblings = criteriaFor(db, cardId);
  const last = siblings[siblings.length - 1]?.position ?? 0;
  return db
    .insert(acceptanceCriterion)
    .values({ id: crypto.randomUUID(), cardId, position: last + POSITION_GAP, text, source })
    .returning()
    .get();
}

export function updateCriterion(
  db: Db,
  id: string,
  patch: Partial<Pick<AcceptanceCriterion, 'text' | 'position' | 'verdict' | 'evidence' | 'verifiedRunId'>>,
) {
  return db.update(acceptanceCriterion).set(patch).where(eq(acceptanceCriterion.id, id)).returning().get();
}

export function deleteCriterion(db: Db, id: string) {
  return db.delete(acceptanceCriterion).where(eq(acceptanceCriterion.id, id)).returning().get();
}

/**
 * Record a Testing run's verdicts by the position a person sees, not by id:
 * Claude is handed a numbered list and answers in those numbers, so this is
 * where "criterion 3" becomes a row. Numbers that match nothing are dropped
 * rather than throwing — a miscounted index should not fail a whole run.
 */
export function recordVerdicts(
  db: Db,
  cardId: string,
  runId: string,
  verdicts: Array<{ index: number; verdict: CriterionVerdict; evidence: string }>,
): number {
  const ordered = criteriaFor(db, cardId);
  let applied = 0;
  for (const v of verdicts) {
    const row = ordered[v.index - 1];
    if (!row) continue;
    updateCriterion(db, row.id, { verdict: v.verdict, evidence: v.evidence, verifiedRunId: runId });
    applied++;
  }
  return applied;
}

/** Wipe the previous run's marking, so a fresh Testing run starts unjudged. */
export function clearVerdicts(db: Db, cardId: string) {
  db.update(acceptanceCriterion)
    .set({ verdict: null, evidence: null, verifiedRunId: null })
    .where(eq(acceptanceCriterion.cardId, cardId))
    .run();
}

export function refsFor(db: Db, cardId: string) {
  return db
    .select()
    .from(cardRef)
    .where(eq(cardRef.cardId, cardId))
    .orderBy(asc(cardRef.createdAt))
    .all();
}

export function addRef(db: Db, cardId: string, kind: CardRefKind, value: string, label?: string | null) {
  return db
    .insert(cardRef)
    .values({ id: crypto.randomUUID(), cardId, kind, value, label: label ?? null })
    .returning()
    .get();
}

export function deleteRef(db: Db, id: string) {
  return db.delete(cardRef).where(eq(cardRef.id, id)).returning().get();
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/**
 * Replace a run's questions with the ones it just asked.
 *
 * `position` is 1-based and assigned in array order, because that number is
 * what a person sees in the band AND what a plan step means by "waits on
 * question 2". Nothing else keeps those two in step.
 */
export function replaceQuestions(
  db: Db,
  cardId: string,
  runId: string,
  stage: CardStage,
  asked: Array<{ question: string; suggestions: string[] }>,
): Question[] {
  return db.transaction((tx) => {
    tx.delete(question).where(eq(question.runId, runId)).run();
    return asked.map((q, i) =>
      tx
        .insert(question)
        .values({
          id: crypto.randomUUID(),
          cardId,
          runId,
          stage,
          position: i + 1,
          text: q.question,
          suggestions: q.suggestions,
        })
        .returning()
        .get(),
    );
  });
}

export function questionsForRun(db: Db, runId: string) {
  return db.select().from(question).where(eq(question.runId, runId)).orderBy(asc(question.position)).all();
}

/**
 * Every question the card has had answered, oldest run first.
 *
 * Card-wide rather than per run: answering the last question forks a new run,
 * which asks nothing, so the latest run's questions are exactly the ones
 * already settled and no longer attached to it.
 */
export function answeredQuestionsFor(db: Db, cardId: string) {
  return db
    .select()
    .from(question)
    .where(and(eq(question.cardId, cardId), isNotNull(question.answer)))
    .orderBy(asc(question.createdAt), asc(question.position))
    .all();
}

export function getQuestion(db: Db, id: string) {
  return db.select().from(question).where(eq(question.id, id)).get();
}

export function answerQuestion(db: Db, id: string, answer: string) {
  return db
    .update(question)
    .set({ answer, answeredAt: new Date() })
    .where(eq(question.id, id))
    .returning()
    .get();
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

export interface AssetDraft {
  cardId: string;
  runId?: string | null;
  kind: AssetKind;
  label: string;
  url?: string | null;
  viewport?: number | null;
  path: string;
  contentType: string;
  width?: number | null;
  height?: number | null;
}

export function insertAsset(db: Db, draft: AssetDraft) {
  return db.insert(asset).values({ ...draft, id: crypto.randomUUID() }).returning().get();
}

export function assetsFor(db: Db, cardId: string) {
  return db.select().from(asset).where(eq(asset.cardId, cardId)).orderBy(asc(asset.createdAt)).all();
}

export function getAsset(db: Db, id: string) {
  return db.select().from(asset).where(eq(asset.id, id)).get();
}

export function deleteAssetRow(db: Db, id: string) {
  return db.delete(asset).where(eq(asset.id, id)).returning().get();
}

/**
 * The screenshots a run took, replaced wholesale when it runs again.
 *
 * A second Testing run photographs the same states afresh, so keeping the
 * first run's pictures would leave the Preview tab showing two versions of
 * "Cart with saved items" with no way to tell which is current.
 */
export function replaceScreenshots(db: Db, cardId: string, runId: string): string[] {
  const stale = db
    .select()
    .from(asset)
    .where(and(eq(asset.cardId, cardId), eq(asset.kind, 'screenshot')))
    .all()
    .filter((a) => a.runId !== runId);
  for (const a of stale) db.delete(asset).where(eq(asset.id, a.id)).run();
  return stale.map((a) => a.path);
}

/**
 * The mockups an earlier plan drew, replaced wholesale when a new plan draws
 * its own. Generated ones are the mockups with a run; a person's have none and
 * are never touched here.
 */
export function replaceGeneratedMockups(db: Db, cardId: string, runId: string): string[] {
  const stale = db
    .select()
    .from(asset)
    .where(and(eq(asset.cardId, cardId), eq(asset.kind, 'mockup'), isNotNull(asset.runId)))
    .all()
    .filter((a) => a.runId !== runId);
  for (const a of stale) db.delete(asset).where(eq(asset.id, a.id)).run();
  return stale.map((a) => a.path);
}

export function differencesFor(db: Db, cardId: string) {
  return db.select().from(difference).where(eq(difference.cardId, cardId)).orderBy(asc(difference.position)).all();
}

/** As with screenshots: a fresh run's judgement replaces the previous one's. */
export function replaceDifferences(
  db: Db,
  cardId: string,
  runId: string,
  found: Array<{ claim: string; note: string; mockupAssetId: string | null; screenshotAssetId: string | null }>,
) {
  return db.transaction((tx) => {
    tx.delete(difference).where(eq(difference.cardId, cardId)).run();
    return found.map((d, i) =>
      tx
        .insert(difference)
        .values({
          id: crypto.randomUUID(),
          cardId,
          runId,
          position: i + 1,
          claim: d.claim,
          note: d.note,
          mockupAssetId: d.mockupAssetId,
          screenshotAssetId: d.screenshotAssetId,
        })
        .returning()
        .get(),
    );
  });
}

/**
 * Notes left on the card since the last run started.
 *
 * "Unread" is defined by when the previous run began rather than by a flag,
 * because that is what the human means: a note written while Claude was
 * working, or after it stopped, is for the next attempt. Nothing needs marking
 * off, and a note can never be consumed twice or silently lost. A Suggest
 * starting is not the previous run: it never reads the notes, so it must not
 * mark them read either.
 */
export function unreadNotesFor(db: Db, cardId: string): string[] {
  const events = cardEventsFor(db, cardId);
  const tasks = new Set(runsForCard(db, cardId).filter((r) => r.task !== null).map((r) => r.id));
  const lastStart =
    events.find((e) => e.kind === 'run_started' && !(e.runId && tasks.has(e.runId)))?.createdAt?.getTime() ?? 0;
  return events
    .filter((e) => e.kind === 'note' && (e.createdAt?.getTime() ?? 0) > lastStart)
    .map((e) => e.body)
    .filter((b): b is string => Boolean(b))
    .reverse();
}
