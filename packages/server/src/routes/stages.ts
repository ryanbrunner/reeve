import { Hono } from 'hono';
import { z } from 'zod';
import { isRunnable, type Stage } from '@reeve/shared';
import { config } from '../config.js';
import type { Db } from '../db/client.js';
import {
  artifactsForCard,
  getCard,
  insertReview,
  latestRunForStage,
  listProjects,
  reviewsForCard,
} from '../db/queries.js';
import { checkWorktree } from '../git/worktree.js';
import { toApiRunSummary } from '../mappers.js';
import { startClaudeRun } from '../runs/claude.js';
import type { EventWriter } from '../runs/events.js';
import { runRegistry } from '../runs/registry.js';
import { stageDefinition } from '../stages/index.js';

const reviewSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  notes: z.string().optional(),
});

export function stageRoutes(db: Db, writer: EventWriter) {
  const routes = new Hono();

  const load = (cardId: string) => {
    const card = getCard(db, cardId);
    if (!card) return { error: 'not found' as const, status: 404 as const };
    const project = card.projectId ? listProjects(db).find((p) => p.id === card.projectId) : undefined;
    if (!project) return { error: 'card has no project' as const, status: 400 as const };
    return { card, project };
  };

  /** Kick off the current stage's Claude run. Nothing starts a stage but this. */
  routes.post('/:id/run', async (c) => {
    const loaded = load(c.req.param('id'));
    if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status);
    const { card, project } = loaded;

    if (!isRunnable(card.stage as Stage)) {
      return c.json({ error: 'stage has no Claude work', detail: card.stage }, 400);
    }
    const stage = stageDefinition(card.stage as never);
    if (!stage) return c.json({ error: 'stage not implemented yet', detail: card.stage }, 501);

    if (runRegistry.all().some((r) => r.cardId === card.id && r.kind === 'claude')) {
      return c.json({ error: 'a run is already active for this card' }, 409);
    }
    // Approving four cards at once shouldn't launch four sessions and burn
    // through budget in parallel.
    if (runRegistry.countByKind('claude') >= config.maxConcurrentRuns) {
      return c.json({ error: 'too many concurrent runs', detail: `limit is ${config.maxConcurrentRuns}` }, 429);
    }

    const health = await checkWorktree(project.repoPath, card.worktreePath);
    if (health.state !== 'ok') {
      return c.json(
        { error: 'card has no usable worktree', detail: health.state === 'missing' ? health.reason : 'not created' },
        409,
      );
    }

    const handle = startClaudeRun({
      db, writer, card, project, stage,
      worktreePath: health.path,
    });
    return c.json({ ok: true, runId: handle.runId, sessionId: handle.sessionId }, 201);
  });

  /**
   * The human gate, and only a gate: it records a verdict and never moves the
   * card. Approving marks the stage's output good and leaves it sitting in its
   * column for the human to drag on; rejecting forks the session so the prior
   * attempt stays intact and readable.
   */
  routes.post('/:id/review', async (c) => {
    const loaded = load(c.req.param('id'));
    if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status);
    const { card, project } = loaded;

    const parsed = reviewSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid review', detail: parsed.error.message }, 400);
    const { decision, notes } = parsed.data;

    const lastRun = latestRunForStage(db, card.id, card.stage);
    if (!lastRun || lastRun.status !== 'succeeded') {
      return c.json({ error: 'nothing to review', detail: `latest run is ${lastRun?.status ?? 'absent'}` }, 409);
    }

    if (decision === 'approved') {
      insertReview(db, {
        id: crypto.randomUUID(), cardId: card.id, runId: lastRun.id,
        stage: card.stage, decision: 'approved', notes: notes ?? null,
        // Same column in and out: approval is a verdict on the work, not a move.
        fromStage: card.stage, toStage: card.stage,
      });
      return c.json({ ok: true, stage: card.stage, moved: false });
    }

    if (!notes?.trim()) {
      return c.json({ error: 'rejection needs notes', detail: 'the notes become the next run prompt' }, 400);
    }
    insertReview(db, {
      id: crypto.randomUUID(), cardId: card.id, runId: lastRun.id,
      stage: card.stage, decision: 'rejected', notes,
      fromStage: card.stage, toStage: card.stage,
    });

    const stage = stageDefinition(card.stage as never);
    if (!stage) return c.json({ error: 'stage not implemented yet' }, 501);
    const health = await checkWorktree(project.repoPath, card.worktreePath);
    if (health.state !== 'ok') return c.json({ error: 'card has no usable worktree' }, 409);

    const handle = startClaudeRun({
      db, writer, card, project, stage,
      worktreePath: health.path,
      reviewNotes: notes,
      // Fork rather than continue: the rejected attempt stays readable and the
      // card's history is a list of attempts, not one mutating session.
      resumeSessionId: lastRun.sessionId,
      parentRunId: lastRun.id,
    });
    return c.json({ ok: true, stage: card.stage, revisionRunId: handle.runId, forkedFrom: lastRun.sessionId }, 201);
  });

  routes.get('/:id/artifacts', (c) =>
    c.json(
      artifactsForCard(db, c.req.param('id')).map((a) => ({
        id: a.id, runId: a.runId, stage: a.stage, kind: a.kind,
        path: a.path, content: a.content, createdAt: a.createdAt?.getTime() ?? 0,
      })),
    ),
  );

  routes.get('/:id/reviews', (c) =>
    c.json(
      reviewsForCard(db, c.req.param('id')).map((r) => ({
        id: r.id, runId: r.runId, stage: r.stage, decision: r.decision,
        notes: r.notes, createdAt: r.createdAt?.getTime() ?? 0,
      })),
    ),
  );

  routes.get('/:id/latest-run', (c) => {
    const card = getCard(db, c.req.param('id'));
    if (!card) return c.json({ error: 'not found' }, 404);
    const r = latestRunForStage(db, card.id, card.stage);
    return r ? c.json(toApiRunSummary(r)) : c.json(null);
  });

  return routes;
}
