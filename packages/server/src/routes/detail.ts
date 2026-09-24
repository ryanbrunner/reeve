import { Hono } from 'hono';
import { z } from 'zod';
import { isRunnable, type ApiDiff, type Stage } from '@reeve/shared';
import type { Db } from '../db/client.js';
import {
  addCriterion,
  addRef,
  answerQuestion,
  criteriaFor,
  deleteCriterion,
  deleteRef,
  getCard,
  getQuestion,
  getRun,
  insertCardEvent,
  latestRunForStage,
  listProjects,
  questionsForRun,
  refsFor,
  updateCriterion,
} from '../db/queries.js';
import { checkWorktree, commitsSince, diffSince } from '../git/worktree.js';
import { parseDiff } from '../git/parseDiff.js';
import { toApiCardRef, toApiCriterion, toApiQuestion } from '../mappers.js';
import { startClaudeRun } from '../runs/claude.js';
import type { EventWriter } from '../runs/events.js';
import { stageDefinition } from '../stages/index.js';

/**
 * Everything the card detail view reads and writes that the board never needed.
 *
 * Mounted under /api/cards alongside the action and stage routes rather than
 * folded into either: those two are about making Claude do things, and this is
 * about what a person put on the card before and after.
 */

const criterionSchema = z.object({ text: z.string().min(1, 'a criterion needs words') });
const criterionPatchSchema = z.object({
  text: z.string().min(1).optional(),
  position: z.number().optional(),
});
const refSchema = z.object({
  kind: z.enum(['file', 'card', 'url']),
  value: z.string().min(1),
  label: z.string().nullable().optional(),
});
const answerSchema = z.object({ answer: z.string().min(1, 'an answer needs words') });

export function detailRoutes(db: Db, writer: EventWriter) {
  const routes = new Hono();

  const found = (id: string) => Boolean(getCard(db, id));

  routes.get('/:id/criteria', (c) => {
    const id = c.req.param('id');
    if (!found(id)) return c.json({ error: 'not found' }, 404);
    return c.json(criteriaFor(db, id).map(toApiCriterion));
  });

  routes.post('/:id/criteria', async (c) => {
    const id = c.req.param('id');
    if (!found(id)) return c.json({ error: 'not found' }, 404);
    const parsed = criterionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid criterion', detail: parsed.error.message }, 400);
    return c.json(toApiCriterion(addCriterion(db, id, parsed.data.text.trim(), 'human')), 201);
  });

  routes.patch('/:id/criteria/:criterionId', async (c) => {
    const parsed = criterionPatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid criterion', detail: parsed.error.message }, 400);
    const updated = updateCriterion(db, c.req.param('criterionId'), parsed.data);
    return updated ? c.json(toApiCriterion(updated)) : c.json({ error: 'not found' }, 404);
  });

  routes.delete('/:id/criteria/:criterionId', (c) => {
    const gone = deleteCriterion(db, c.req.param('criterionId'));
    return gone ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  routes.get('/:id/refs', (c) => {
    const id = c.req.param('id');
    if (!found(id)) return c.json({ error: 'not found' }, 404);
    return c.json(refsFor(db, id).map(toApiCardRef));
  });

  routes.post('/:id/refs', async (c) => {
    const id = c.req.param('id');
    if (!found(id)) return c.json({ error: 'not found' }, 404);
    const parsed = refSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid ref', detail: parsed.error.message }, 400);
    const { kind, value, label } = parsed.data;
    return c.json(toApiCardRef(addRef(db, id, kind, value.trim(), label)), 201);
  });

  routes.delete('/:id/refs/:refId', (c) => {
    const gone = deleteRef(db, c.req.param('refId'));
    return gone ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  /** The questions the card's current run asked, answered or not. */
  routes.get('/:id/questions', (c) => {
    const card = getCard(db, c.req.param('id'));
    if (!card) return c.json({ error: 'not found' }, 404);
    const run = latestRunForStage(db, card.id, card.stage);
    return c.json(run ? questionsForRun(db, run.id).map(toApiQuestion) : []);
  });

  /**
   * Answer one question, and when it was the last one, put Claude back to work.
   *
   * The resume forks the session exactly as a rejection does: the attempt that
   * asked stays readable, and the answers arrive as prompt rather than as some
   * second channel Claude has to be taught about. Answering out of order is
   * fine — what matters is that none are left, not which came last.
   */
  routes.post('/:id/questions/:questionId/answer', async (c) => {
    const card = getCard(db, c.req.param('id'));
    if (!card) return c.json({ error: 'not found' }, 404);

    const parsed = answerSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid answer', detail: parsed.error.message }, 400);

    const existing = getQuestion(db, c.req.param('questionId'));
    if (!existing || existing.cardId !== card.id) return c.json({ error: 'not found' }, 404);

    const answered = answerQuestion(db, existing.id, parsed.data.answer.trim());
    insertCardEvent(db, {
      cardId: card.id, actor: 'human', kind: 'answered', stage: existing.stage,
      runId: existing.runId, body: answered.answer,
      meta: { question: existing.text, position: existing.position },
    });

    const siblings = existing.runId ? questionsForRun(db, existing.runId) : [];
    const pending = siblings.filter((q) => q.answer === null);
    if (pending.length > 0) {
      return c.json({ ok: true, answered: siblings.length - pending.length, of: siblings.length, resumed: null });
    }

    // Everything answered. Anything that stops the resume is reported rather
    // than thrown: the answer is already saved, and losing it because the
    // worktree went missing would be the worse failure.
    const blocked = (detail: string) =>
      c.json({ ok: true, answered: siblings.length, of: siblings.length, resumed: null, blocked: detail });

    const project = card.projectId ? listProjects(db).find((p) => p.id === card.projectId) : undefined;
    if (!project) return blocked('card has no project');
    if (!isRunnable(card.stage as Stage)) return blocked('stage has no Claude work');
    const stage = stageDefinition(card.stage as never);
    if (!stage) return blocked('stage not implemented yet');
    const health = await checkWorktree(project.repoPath, card.worktreePath);
    if (health.state !== 'ok') return blocked('card has no usable worktree');

    // Fork the run that ASKED, not simply the latest one: those are the same
    // run today, and would quietly stop being so the moment anything else can
    // start one in between.
    const asked = existing.runId ? getRun(db, existing.runId) : null;

    const handle = startClaudeRun({
      db, writer, card, project, stage,
      worktreePath: health.path,
      answers: siblings.map((q) => ({ question: q.text, answer: q.answer ?? '' })),
      resumeSessionId: asked?.sessionId ?? null,
      parentRunId: asked?.id ?? null,
    });
    return c.json({ ok: true, answered: siblings.length, of: siblings.length, resumed: handle.runId }, 201);
  });

  /**
   * What the card has changed, against the sha its worktree started from.
   *
   * Its own endpoint rather than part of `/detail` because it shells out to
   * git, and the modal only needs it when the Changes tab is actually open.
   */
  routes.get('/:id/diff', async (c) => {
    const card = getCard(db, c.req.param('id'));
    if (!card) return c.json({ error: 'not found' }, 404);
    const project = card.projectId ? listProjects(db).find((p) => p.id === card.projectId) : undefined;
    if (!card.worktreePath || !card.baseSha || !project) {
      // No worktree is a normal state for a card in Backlog, not an error.
      return c.json({ base: '', baseBranch: project?.defaultBranch ?? '', files: [], additions: 0, deletions: 0 } satisfies ApiDiff);
    }
    const files = parseDiff(await diffSince(card.worktreePath, card.baseSha));
    const body: ApiDiff = {
      base: card.baseSha,
      baseBranch: project.defaultBranch,
      files,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    };
    return c.json(body);
  });

  routes.get('/:id/commits', async (c) => {
    const card = getCard(db, c.req.param('id'));
    if (!card) return c.json({ error: 'not found' }, 404);
    if (!card.worktreePath || !card.baseSha) return c.json([]);
    return c.json(await commitsSince(card.worktreePath, card.baseSha));
  });

  return routes;
}
