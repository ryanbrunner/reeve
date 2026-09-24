import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  artifact,
  card,
  project,
  review,
  run,
  runEvent,
  type Card,
  type ArtifactKind,
  type CardStage,
  type NewRun,
  type NewRunEvent,
  type RunStatus,
} from './schema.js';

const NON_TERMINAL: RunStatus[] = ['queued', 'running', 'stopping'];

/** The board query: every live card with its project's lane colour. */
export function boardCards(db: Db) {
  return db
    .select({
      card,
      projectName: project.name,
      laneColor: project.laneColor,
    })
    .from(card)
    .leftJoin(project, eq(card.projectId, project.id))
    .where(isNull(card.archivedAt))
    .orderBy(asc(card.stage), asc(card.position))
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

export function insertRun(db: Db, values: NewRun) {
  return db.insert(run).values(values).returning().get();
}

/** Batched to keep synchronous SQLite writes off the event loop's critical path. */
export function insertEvents(db: Db, rows: NewRunEvent[]): void {
  if (rows.length === 0) return;
  db.transaction((tx) => {
    tx.insert(runEvent).values(rows).run();
  });
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

export function latestRunForCard(db: Db, cardId: string) {
  return db
    .select()
    .from(run)
    .where(eq(run.cardId, cardId))
    .orderBy(desc(run.createdAt))
    .limit(1)
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

export function moveCard(db: Db, id: string, stage: CardStage, index: number) {
  const position = positionForSlot(db, stage, index, id);
  const updated = db
    .update(card)
    .set({ stage, position, updatedAt: new Date() })
    .where(eq(card.id, id))
    .returning()
    .get();
  renormaliseIfNeeded(db, stage);
  return updated;
}

export function createCard(db: Db, values: { title: string; body?: string; projectId?: string | null; stage?: CardStage }) {
  const stage = values.stage ?? 'backlog';
  const siblings = cardsInStage(db, stage);
  const last = siblings[siblings.length - 1]?.position ?? 0;
  return db
    .insert(card)
    .values({
      id: crypto.randomUUID(),
      title: values.title,
      body: values.body ?? '',
      projectId: values.projectId ?? null,
      stage,
      position: last + POSITION_GAP,
    })
    .returning()
    .get();
}

export function updateCard(db: Db, id: string, patch: Partial<Pick<Card, 'title' | 'body' | 'projectId'>>) {
  return db.update(card).set({ ...patch, updatedAt: new Date() }).where(eq(card.id, id)).returning().get();
}

export function archiveCard(db: Db, id: string) {
  return db.update(card).set({ archivedAt: new Date() }).where(eq(card.id, id)).returning().get();
}

export function getCard(db: Db, id: string) {
  return db.select().from(card).where(eq(card.id, id)).get();
}

export function listProjects(db: Db) {
  return db.select().from(project).where(isNull(project.archivedAt)).orderBy(asc(project.name)).all();
}

export function createProject(db: Db, values: Omit<typeof project.$inferInsert, 'id' | 'createdAt'>) {
  return db.insert(project).values({ ...values, id: crypto.randomUUID() }).returning().get();
}

export function updateProject(db: Db, id: string, patch: Partial<typeof project.$inferInsert>) {
  return db.update(project).set(patch).where(eq(project.id, id)).returning().get();
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
export function latestRunForStage(db: Db, cardId: string, stage: CardStage) {
  return db
    .select()
    .from(run)
    .where(and(eq(run.cardId, cardId), eq(run.stage, stage)))
    .orderBy(desc(run.createdAt))
    .limit(1)
    .get();
}

export function insertReview(db: Db, values: typeof review.$inferInsert) {
  return db.insert(review).values(values).returning().get();
}

export function reviewsForCard(db: Db, cardId: string) {
  return db.select().from(review).where(eq(review.cardId, cardId)).orderBy(desc(review.createdAt)).all();
}

export function setCardStage(db: Db, id: string, stage: CardStage) {
  return db.update(card).set({ stage, updatedAt: new Date() }).where(eq(card.id, id)).returning().get();
}
