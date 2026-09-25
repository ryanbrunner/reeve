import { Hono } from 'hono';
import { z } from 'zod';
import { nextStage, type Stage } from '@reeve/shared';
import type { Db } from '../db/client.js';
import {
  artifactsForCard,
  getCard,
  cardsInStage,
  insertCardEvent,
  insertReview,
  latestClaudeRunForStage,
  listRepos,
  moveCard,
  reviewsForCard,
} from '../db/queries.js';
import { checkWorktree } from '../git/worktree.js';
import { toApiRunSummary } from '../mappers.js';
import { maybeOpenPullRequest } from '../pullRequest.js';
import { startClaudeRun } from '../runs/claude.js';
import type { EventWriter } from '../runs/events.js';
import { stageDefinition } from '../stages/index.js';
import { startStage } from '../startStage.js';

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
   * The human gate. Approving says the stage's output is good, so it records the
   * verdict AND advances the card one column — a human deciding the work is done
   * is the whole point of the gate, and making them then drag the card is asking
   * them to say it twice. A run finishing on its own still moves nothing.
   *
   * Rejecting moves nothing either: it forks the session so the prior attempt
   * stays intact and readable, and the notes become the revision prompt.
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
      // Done is the end of the board; approving there is a verdict with nowhere
      // to go, so the card stays put rather than the request failing.
      const to = nextStage(card.stage as Stage) ?? card.stage;
      insertReview(db, {
        id: crypto.randomUUID(), cardId: card.id, runId: lastRun.id,
        stage: card.stage, decision: 'approved', notes: notes ?? null,
        fromStage: card.stage, toStage: to,
      });
      insertCardEvent(db, {
        cardId: card.id, actor: 'human', kind: 'reviewed', stage: card.stage,
        runId: lastRun.id, body: notes ?? null, meta: { decision: 'approved' },
      });
      if (to !== card.stage) {
        // Appended, not inserted: the human chose the column, not the slot.
        // moveCard writes the `moved` event, so the timeline reads as a verdict
        // followed by a move rather than one conflated entry.
        const moved = moveCard(db, card.id, to, cardsInStage(db, to).length);
        // The same automatic pull request a drag into Done gets.
        if (moved?.stage === 'done') maybeOpenPullRequest(db, moved, repo);
      }
      return c.json({ ok: true, fromStage: card.stage, toStage: to, moved: to !== card.stage });
    }

    if (!notes?.trim()) {
      return c.json({ error: 'rejection needs notes', detail: 'the notes become the next run prompt' }, 400);
    }
    insertReview(db, {
      id: crypto.randomUUID(), cardId: card.id, runId: lastRun.id,
      stage: card.stage, decision: 'rejected', notes,
      fromStage: card.stage, toStage: card.stage,
    });
    insertCardEvent(db, {
      cardId: card.id, actor: 'human', kind: 'reviewed', stage: card.stage,
      runId: lastRun.id, body: notes, meta: { decision: 'rejected' },
    });

    const stage = stageDefinition(card.stage as never);
    if (!stage) return c.json({ error: 'stage not implemented yet' }, 501);
    const health = await checkWorktree(repo.repoPath, card.worktreePath);
    if (health.state !== 'ok') return c.json({ error: 'card has no usable worktree' }, 409);

    const handle = startClaudeRun({
      db, writer, card, repo, stage,
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
    const r = latestClaudeRunForStage(db, card.id, card.stage);
    return r ? c.json(toApiRunSummary(r)) : c.json(null);
  });

  return routes;
}
