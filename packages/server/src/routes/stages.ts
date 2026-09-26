import { Hono } from 'hono';
import { z } from 'zod';
import { nextStage, type Stage } from '@reeve/shared';
import { blockedMove } from '../blockers.js';
import { entryRefusal } from '../board.js';
import type { Db } from '../db/client.js';
import {
  artifactsForCard,
  getCard,
  latestClaudeRunForStage,
  listRepos,
  reviewsForCard,
} from '../db/queries.js';
import { checkWorktree } from '../git/worktree.js';
import { toApiRunSummary } from '../mappers.js';
import { approveStage, sendBackForRevision } from '../review.js';
import { startClaudeRun } from '../runs/claude.js';
import type { EventWriter } from '../runs/events.js';
import { stageDefinition } from '../stages/index.js';
import { maybeStartStage, startStage } from '../startStage.js';

const reviewSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  notes: z.string().optional(),
});

export function stageRoutes(db: Db, writer: EventWriter) {
  const routes = new Hono();

  const load = (cardId: string) => {
    const card = getCard(db, cardId);
    if (!card) return { error: 'not found' as const, status: 404 as const };
    // Off the board means nothing happens to it until it is restored.
    if (card.archivedAt) return { error: 'card is archived' as const, status: 409 as const };
    const repo = card.repoId ? listRepos(db).find((p) => p.id === card.repoId) : undefined;
    if (!repo) return { error: 'card has no repo' as const, status: 400 as const };
    return { card, repo };
  };

  /**
   * Kick off the current stage's Claude run, making the worktree first if there
   * isn't one. A card entering a runnable column starts on its own; this is
   * the Run button, for a card that didn't, or whose run failed.
   */
  routes.post('/:id/run', async (c) => {
    const loaded = load(c.req.param('id'));
    if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status);
    const result = await startStage(db, writer, loaded.card, loaded.repo);
    if (!result.ok) return c.json({ error: result.error, detail: result.detail }, result.status);
    return c.json(result, 201);
  });

  /**
   * The human gate. Approving records the verdict and advances the card one
   * column; rejecting forks a revision run with the notes as its prompt. Both
   * live in ../review.ts, which a review in Crit ends in too. A run finishing
   * on its own still moves nothing.
   */
  routes.post('/:id/review', async (c) => {
    const loaded = load(c.req.param('id'));
    if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status);
    const { card, repo } = loaded;

    const parsed = reviewSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid review', detail: parsed.error.message }, 400);
    const { decision, notes } = parsed.data;

    const lastRun = latestClaudeRunForStage(db, card.id, card.stage);
    if (!lastRun || lastRun.status !== 'succeeded') {
      return c.json({ error: 'nothing to review', detail: `latest run is ${lastRun?.status ?? 'absent'}` }, 409);
    }

    if (decision === 'approved') {
      const to = nextStage(card.stage) ?? card.stage;
      // Approving is a move, and a card waiting on another may only move back
      // to Backlog. Refused before anything is recorded, so there is no
      // approved verdict for a card that went nowhere.
      const blocked = blockedMove(db, card, to);
      if (blocked) return c.json({ error: blocked.error, detail: blocked.detail }, blocked.status);
      // Approving Testing is a move into Done, which pushes the branch. A card
      // that reached Testing without being built would push an empty one.
      const refusal = entryRefusal(db, card, to);
      if (refusal) return c.json({ error: 'not implemented', detail: refusal }, 409);
      return c.json({ ok: true, ...approveStage(db, writer, card, repo, lastRun, { notes }) });
    }

    if (!notes?.trim()) {
      return c.json({ error: 'rejection needs notes', detail: 'the notes become the next run prompt' }, 400);
    }
    const revision = await sendBackForRevision(db, writer, card, repo, lastRun, notes);
    if (!revision.ok) return c.json({ error: revision.error }, revision.status);
    return c.json(
      { ok: true, stage: card.stage, revisionRunId: revision.revisionRunId, forkedFrom: revision.forkedFrom },
      201,
    );
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
    const r = latestClaudeRunForStage(db, card.id, card.stage);
    return r ? c.json(toApiRunSummary(r)) : c.json(null);
  });

  return routes;
}
