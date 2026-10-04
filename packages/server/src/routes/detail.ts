import { Hono } from 'hono';
import { z } from 'zod';
import type { ApiDiff } from '@reeve/shared';
import type { Db } from '../db/client.js';
import {
  addCriterion,
  addRef,
  assetsFor,
  deleteAssetRow,
  getAsset,
  insertAsset,
  criteriaFor,
  deleteCriterion,
  deleteRef,
  getCard,
  getQuestion,
  insertCardEvent,
  latestClaudeRunForStage,
  listRepos,
  liveTaskRun,
  questionsForRun,
  refsFor,
  removeDependency,
  updateCriterion,
} from '../db/queries.js';
import { recordAnswer } from '../answers.js';
import { linkDependency } from '../dependencies.js';
import { checkWorktree, commitAt, commitsSince, diffOfCommit, diffSince } from '../git/worktree.js';
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
import { splitProjectTask } from '../stages/split_project.js';
import { suggestCriteriaTask } from '../stages/suggest_criteria.js';
import type { Card } from '../db/schema.js';
import type { EventWriter } from '../runs/events.js';
import { requireJson } from './security.js';

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
const dependencySchema = z.object({ dependsOnId: z.string().min(1) });
const answerSchema = z.object({ answer: z.string().min(1, 'an answer needs words') });
const noteSchema = z.object({ body: z.string().min(1, 'a note needs words') });

export type StartSplitResult =
  | { ok: true; runId: string }
  | { ok: false; status: 400 | 409; error: string; detail?: string };

/**
 * Ask Claude to break a project's brief into tasks. The Split button and a
 * project's first brief both come through here, so they refuse the same
 * things. Like Suggest it reads the repo's checkout: a project never has a
 * worktree of its own.
 */
export function startSplit(db: Db, writer: EventWriter, card: Card): StartSplitResult {
  if (card.kind !== 'project') return { ok: false, status: 400, error: 'only a project can be split' };
  if (card.archivedAt) return { ok: false, status: 400, error: 'project is archived' };
  if (!card.body.trim()) return { ok: false, status: 400, error: 'project has no brief', detail: 'write one to split' };
  const repo = card.repoId ? listRepos(db).find((p) => p.id === card.repoId) : undefined;
  if (!repo) return { ok: false, status: 400, error: 'project has no repo', detail: 'splitting needs a repo to read' };
  // One at a time. Nothing is awaited between this and startClaudeRun writing
  // its row, so two presses cannot both get through.
  if (liveTaskRun(db, card.id, splitProjectTask.id)) {
    return { ok: false, status: 409, error: 'already splitting this project' };
  }
  const handle = startClaudeRun({
    db, writer, card, repo,
    stage: splitProjectTask as never,
    runStage: card.stage,
    worktreePath: repo.repoPath,
  });
  return { ok: true, runId: handle.runId };
}

export function detailRoutes(db: Db, writer: EventWriter) {
  const routes = new Hono();

  const found = (id: string) => Boolean(getCard(db, id));

  /** The whole card, in one response. See detail.ts for why it is one. */
  routes.get('/:id/detail', async (c) => {
    const card = getCard(db, c.req.param('id'));
    if (!card) return c.json({ error: 'not found' }, 404);
    const repo = card.repoId ? listRepos(db).find((p) => p.id === card.repoId) : undefined;
    return c.json(await cardDetail(db, card, repo?.name ?? null, repo?.laneColor ?? null, repo ?? null));
  });

  routes.get('/:id/criteria', (c) => {
    const id = c.req.param('id');
    if (!found(id)) return c.json({ error: 'not found' }, 404);
    return c.json(criteriaFor(db, id).map(toApiCriterion));
  });

  routes.post('/:id/criteria', requireJson, async (c) => {
    const id = c.req.param('id');
    if (!found(id)) return c.json({ error: 'not found' }, 404);
    const parsed = criterionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid criterion', detail: parsed.error.message }, 400);
    return c.json(toApiCriterion(addCriterion(db, id, parsed.data.text.trim(), 'human')), 201);
  });

  /**
   * Ask Claude what done should mean. A real run, so it shows in the card's
   * history and its cost is counted — but not a stage, so it needs no worktree
   * of its own and reads the repo's checkout instead. Its prompt tells it to
   * change nothing, and here that is the person's own checkout at stake.
   */
  routes.post('/:id/criteria/suggest', async (c) => {
    const card = getCard(db, c.req.param('id'));
    if (!card) return c.json({ error: 'not found' }, 404);
    const repo = card.repoId ? listRepos(db).find((p) => p.id === card.repoId) : undefined;
    if (!repo) return c.json({ error: 'card has no repo', detail: 'suggesting needs a repo to read' }, 400);

    // Its own worktree if it has one, the repo's checkout if not: a card in
    // Backlog has no worktree, and this is exactly the stage it is most useful.
    const health = await checkWorktree(repo.repoPath, card.worktreePath);
    const cwd = health.state === 'ok' ? health.path : repo.repoPath;

    // One at a time. Checked after the last await, so nothing can start between
    // this and startClaudeRun writing its row.
    if (liveTaskRun(db, card.id, suggestCriteriaTask.id)) {
      return c.json({ error: 'already suggesting for this card' }, 409);
    }

    const handle = startClaudeRun({
      db, writer, card, repo,
      stage: suggestCriteriaTask as never,
      runStage: card.stage,
      worktreePath: cwd,
    });
    return c.json({ ok: true, runId: handle.runId }, 201);
  });

  /** Break a project's brief into tasks, again or for the first time. */
  routes.post('/:id/split', (c) => {
    const card = getCard(db, c.req.param('id'));
    if (!card) return c.json({ error: 'not found' }, 404);
    const result = startSplit(db, writer, card);
    if (!result.ok) return c.json({ error: result.error, detail: result.detail }, result.status);
    return c.json({ ok: true, runId: result.runId }, 201);
  });

  routes.patch('/:id/criteria/:criterionId', requireJson, async (c) => {
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

  routes.post('/:id/refs', requireJson, async (c) => {
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

  /** Make this card depend on another. What is refused, and why, is in ../dependencies.ts. */
  routes.post('/:id/dependencies', requireJson, async (c) => {
    const card = getCard(db, c.req.param('id'));
    if (!card) return c.json({ error: 'not found' }, 404);
    const parsed = dependencySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid dependency', detail: parsed.error.message }, 400);
    const result = linkDependency(db, card, parsed.data.dependsOnId);
    if (!result.ok) return c.json({ error: result.error, detail: result.detail }, result.status);
    return c.json({ ok: true }, 201);
  });

  routes.delete('/:id/dependencies/:dependsOnId', (c) => {
    const gone = removeDependency(db, c.req.param('id'), c.req.param('dependsOnId'));
    return gone ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  /** The questions the card's current run asked, answered or not. */
  routes.get('/:id/questions', (c) => {
    const card = getCard(db, c.req.param('id'));
    if (!card) return c.json({ error: 'not found' }, 404);
    const run = latestClaudeRunForStage(db, card.id, card.stage);
    return c.json(run ? questionsForRun(db, run.id).map(toApiQuestion) : []);
  });

  /** Answer one question. The work is in ../answers.ts, which VIBES MODE shares. */
  routes.post('/:id/questions/:questionId/answer', requireJson, async (c) => {
    const card = getCard(db, c.req.param('id'));
    if (!card) return c.json({ error: 'not found' }, 404);

    const parsed = answerSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid answer', detail: parsed.error.message }, 400);

    const existing = getQuestion(db, c.req.param('questionId'));
    if (!existing || existing.cardId !== card.id) return c.json({ error: 'not found' }, 404);

    const result = await recordAnswer(db, writer, card, existing, parsed.data.answer);
    return c.json({ ok: true, ...result }, result.resumed ? 201 : 200);
  });

  /**
   * What the card has changed, against the sha its worktree started from.
   *
   * Its own endpoint rather than part of `/detail` because it shells out to
   * git, and has no reason to be re-read on every poll of `/detail`.
   */
  /**
   * A note for Claude's next run. The third thing a human can say, beside a
   * rejection and an answer — and like both of those it reaches Claude as
   * prompt rather than through a channel of its own.
   */
  routes.post('/:id/notes', requireJson, async (c) => {
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
    const repo = card.repoId ? listRepos(db).find((p) => p.id === card.repoId) : undefined;
    // Merged, the worktree and branch are gone, and what the card changed is
    // exactly the squash commit it landed as.
    if (card.mergedSha && repo) {
      const raw = await diffOfCommit(repo.repoPath, card.mergedSha).catch(() => null);
      const files = raw === null ? [] : parseDiff(raw);
      return c.json({
        base: `${card.mergedSha}^`,
        baseBranch: repo.defaultBranch,
        files,
        additions: files.reduce((n, f) => n + f.additions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
      } satisfies ApiDiff);
    }
    const { worktreePath, branchName, baseSha } = card;
    if (!(worktreePath || branchName) || !baseSha || !repo) {
      // No worktree is a normal state for a card in Backlog, not an error.
      return c.json({ base: '', baseBranch: repo?.defaultBranch ?? '', files: [], additions: 0, deletions: 0 } satisfies ApiDiff);
    }
    // A worktree removed from under the card is a state the rail already
    // reports, so it reads here as "nothing changed" rather than a 500 that
    // takes the tab down with it. One Reeve removed on purpose, once the card
    // merged and was archived, left its branch behind in the repo, and what is
    // committed there is what the card changed.
    const raw = await (worktreePath
      ? diffSince(worktreePath, baseSha)
      : diffSince(repo.repoPath, baseSha, branchName!)
    ).catch(() => null);
    const files = raw === null ? [] : parseDiff(raw);
    const body: ApiDiff = {
      base: baseSha,
      baseBranch: repo.defaultBranch,
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
   *
   * Or, with `kind=pasted`, an image pasted into the brief. That one is none
   * of those things: it is part of the writing, referenced from the body by its
   * `src`, so it takes neither and nothing downstream mistakes it for a mockup.
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
    if (form?.['kind'] === 'pasted') {
      const row = insertAsset(db, {
        cardId,
        kind: 'pasted',
        label: String(form['label'] ?? file.name),
        path: rel,
        contentType: file.type,
        width: size?.width ?? null,
        height: size?.height ?? null,
      });
      return c.json(toApiAsset(row), 201);
    }

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
    const repo = card.repoId ? listRepos(db).find((p) => p.id === card.repoId) : undefined;
    if (card.mergedSha) {
      return c.json(repo ? await commitAt(repo.repoPath, card.mergedSha).catch(() => []) : []);
    }
    if (!card.baseSha) return c.json([]);
    if (card.worktreePath) return c.json(await commitsSince(card.worktreePath, card.baseSha).catch(() => []));
    // The worktree is gone, but its branch is not: see `/diff`.
    if (!card.branchName || !repo) return c.json([]);
    return c.json(await commitsSince(repo.repoPath, card.baseSha, card.branchName).catch(() => []));
  });

  return routes;
}
