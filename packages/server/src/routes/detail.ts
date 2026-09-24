import { Hono } from 'hono';
import { z } from 'zod';
import { isRunnable, type ApiDiff, type Stage } from '@reeve/shared';
import type { Db } from '../db/client.js';
import {
  addCriterion,
  addRef,
  answerQuestion,
  assetsFor,
  deleteAssetRow,
  getAsset,
  insertAsset,
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
import { cardDetail } from '../detail.js';
import { toApiAsset, toApiCardEvent, toApiCardRef, toApiCriterion, toApiQuestion } from '../mappers.js';
import {
  CONTENT_TYPES,
  MAX_ASSET_BYTES,
  deleteAsset,
  imageSize,
  relativeAssetPath,
  writeAsset,
} from '../assets/store.js';
import { startClaudeRun } from '../runs/claude.js';
import { suggestCriteriaTask } from '../stages/suggest_criteria.js';
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
const noteSchema = z.object({ body: z.string().min(1, 'a note needs words') });

export function detailRoutes(db: Db, writer: EventWriter) {
  const routes = new Hono();

  const found = (id: string) => Boolean(getCard(db, id));

  /** The whole card, in one response. See detail.ts for why it is one. */
  routes.get('/:id/detail', async (c) => {
    const card = getCard(db, c.req.param('id'));
    if (!card) return c.json({ error: 'not found' }, 404);
    const project = card.projectId ? listProjects(db).find((p) => p.id === card.projectId) : undefined;
    return c.json(await cardDetail(db, card, project?.name ?? null, project?.laneColor ?? null, project ?? null));
  });

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

  /**
   * Ask Claude what done should mean. A real run, so it shows in the card's
   * history and its cost is counted — but not a stage, so it needs no worktree
   * of its own and reads the project's checkout instead. It is read-only.
   */
  routes.post('/:id/criteria/suggest', async (c) => {
    const card = getCard(db, c.req.param('id'));
    if (!card) return c.json({ error: 'not found' }, 404);
    const project = card.projectId ? listProjects(db).find((p) => p.id === card.projectId) : undefined;
    if (!project) return c.json({ error: 'card has no project', detail: 'suggesting needs a repo to read' }, 400);

    // Its own worktree if it has one, the project's checkout if not: a card in
    // Backlog has no worktree, and this is exactly the stage it is most useful.
    const health = await checkWorktree(project.repoPath, card.worktreePath);
    const cwd = health.state === 'ok' ? health.path : project.repoPath;

    const handle = startClaudeRun({
      db, writer, card, project,
      stage: suggestCriteriaTask as never,
      runStage: card.stage,
      worktreePath: cwd,
    });
    return c.json({ ok: true, runId: handle.runId }, 201);
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
  /**
   * A note for Claude's next run. The third thing a human can say, beside a
   * rejection and an answer — and like both of those it reaches Claude as
   * prompt rather than through a channel of its own.
   */
  routes.post('/:id/notes', async (c) => {
    const card = getCard(db, c.req.param('id'));
    if (!card) return c.json({ error: 'not found' }, 404);
    const parsed = noteSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid note', detail: parsed.error.message }, 400);
    const event = insertCardEvent(db, {
      cardId: card.id, actor: 'human', kind: 'note', stage: card.stage,
      body: parsed.data.body.trim(),
    });
    return c.json(toApiCardEvent(event), 201);
  });

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

  /**
   * Attach a mockup: the picture of what this should look like.
   *
   * `url` and `viewport` are not decoration — they are what tells the capturer
   * which page to photograph and how wide, so that a mockup and its screenshot
   * end up as a pair rather than two unrelated images.
   */
  routes.post('/:id/assets', async (c) => {
    const cardId = c.req.param('id');
    if (!found(cardId)) return c.json({ error: 'not found' }, 404);

    const form = await c.req.parseBody().catch(() => null);
    const file = form?.['file'];
    if (!(file instanceof File)) return c.json({ error: 'expected a file field' }, 400);
    if (!CONTENT_TYPES[file.type]) {
      return c.json({ error: 'unsupported image type', detail: `${file.type || 'unknown'}; use png, jpeg or webp` }, 415);
    }
    if (file.size > MAX_ASSET_BYTES) {
      return c.json({ error: 'image too large', detail: `${file.size} bytes, limit is ${MAX_ASSET_BYTES}` }, 413);
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const id = crypto.randomUUID();
    const rel = relativeAssetPath(cardId, id, file.type);
    writeAsset(rel, bytes);

    const size = imageSize(bytes);
    const viewport = Number(form?.['viewport']);
    const row = insertAsset(db, {
      cardId,
      kind: 'mockup',
      label: String(form?.['label'] ?? file.name),
      url: form?.['url'] ? String(form['url']) : null,
      // Falls back to the image's own width, which is usually what was meant.
      viewport: Number.isFinite(viewport) && viewport > 0 ? viewport : (size?.width ?? null),
      path: rel,
      contentType: file.type,
      width: size?.width ?? null,
      height: size?.height ?? null,
    });
    return c.json(toApiAsset(row), 201);
  });

  routes.get('/:id/assets', (c) => {
    const id = c.req.param('id');
    if (!found(id)) return c.json({ error: 'not found' }, 404);
    return c.json(assetsFor(db, id).map(toApiAsset));
  });

  routes.delete('/:id/assets/:assetId', (c) => {
    const row = getAsset(db, c.req.param('assetId'));
    if (!row || row.cardId !== c.req.param('id')) return c.json({ error: 'not found' }, 404);
    // Row first: a file with no row is litter, a row with no file is a broken image.
    deleteAssetRow(db, row.id);
    deleteAsset(row.path);
    return c.json({ ok: true });
  });

  routes.get('/:id/commits', async (c) => {
    const card = getCard(db, c.req.param('id'));
    if (!card) return c.json({ error: 'not found' }, 404);
    if (!card.worktreePath || !card.baseSha) return c.json([]);
    return c.json(await commitsSince(card.worktreePath, card.baseSha));
  });

  return routes;
}
