import { Hono } from 'hono';
import { z } from 'zod';
import { STAGES } from '@reeve/shared';
import type { BoardResponse } from '@reeve/shared';
import { toBoardCard } from '../board.js';
import type { Db } from '../db/client.js';
import {
  archiveCard,
  boardCards,
  createCard,
  createProject,
  getCard,
  listProjects,
  moveCard,
  runsForCard,
  updateCard,
  updateProject,
} from '../db/queries.js';
import { toApiProject, toApiRunSummary } from '../mappers.js';

const stageSchema = z.enum(STAGES);

const createCardSchema = z.object({
  title: z.string().min(1, 'title is required'),
  body: z.string().optional(),
  projectId: z.string().nullable().optional(),
  stage: stageSchema.optional(),
});

const updateCardSchema = z.object({
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  projectId: z.string().nullable().optional(),
});

const moveCardSchema = z.object({
  stage: stageSchema,
  index: z.number().int().min(0),
});

const projectSchema = z.object({
  name: z.string().min(1),
  repoPath: z.string().min(1),
  worktreeRoot: z.string().min(1),
  defaultBranch: z.string().default('main'),
  setupCommand: z.string().nullable().optional(),
  testCommand: z.string().nullable().optional(),
  serverCommand: z.string().nullable().optional(),
  teardownCommand: z.string().nullable().optional(),
  finishCommand: z.string().nullable().optional(),
  laneColor: z.string().nullable().optional(),
  maxBudgetUsd: z.number().nullable().optional(),
});

export function apiRoutes(db: Db) {
  const api = new Hono();

  api.get('/board', (c) => {
    const rows = boardCards(db);
    const body: BoardResponse = {
      projects: listProjects(db).map(toApiProject),
      cards: rows.map((r) => toBoardCard(db, r.card, r.projectName, r.laneColor)),
    };
    return c.json(body);
  });

  api.get('/projects', (c) => c.json(listProjects(db).map(toApiProject)));

  api.post('/projects', async (c) => {
    const parsed = projectSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid project', detail: parsed.error.message }, 400);
    return c.json(toApiProject(createProject(db, parsed.data)), 201);
  });

  api.patch('/projects/:id', async (c) => {
    const parsed = projectSchema.partial().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid project', detail: parsed.error.message }, 400);
    const updated = updateProject(db, c.req.param('id'), parsed.data);
    return updated ? c.json(toApiProject(updated)) : c.json({ error: 'not found' }, 404);
  });

  api.post('/cards', async (c) => {
    const parsed = createCardSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid card', detail: parsed.error.message }, 400);
    if (parsed.data.projectId && !listProjects(db).some((p) => p.id === parsed.data.projectId)) {
      return c.json({ error: 'no such project', detail: parsed.data.projectId }, 400);
    }
    const created = createCard(db, parsed.data);
    const project = created.projectId ? listProjects(db).find((p) => p.id === created.projectId) : undefined;
    return c.json(toBoardCard(db, created, project?.name ?? null, project?.laneColor ?? null), 201);
  });

  api.patch('/cards/:id', async (c) => {
    const parsed = updateCardSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid card', detail: parsed.error.message }, 400);
    const id = c.req.param('id');
    const existing = getCard(db, id);
    if (!existing) return c.json({ error: 'not found' }, 404);

    const { projectId } = parsed.data;
    if (projectId !== undefined && projectId !== existing.projectId) {
      // The branch and the directory on disk belong to the repo the card was in
      // when they were made. Repointing the card leaves them behind in a repo
      // nothing looks at any more, and every later call — diff, server, run —
      // would resolve the new project's `repoPath` against the old tree.
      if (existing.worktreePath) {
        return c.json(
          { error: 'card has a worktree', detail: 'remove the worktree before moving the card to another project' },
          400,
        );
      }
      // Without this the foreign key raises, which is a 500 for what is a
      // caller's mistake.
      if (projectId !== null && !listProjects(db).some((p) => p.id === projectId)) {
        return c.json({ error: 'no such project', detail: projectId }, 400);
      }
    }

    const updated = updateCard(db, id, parsed.data);
    if (!updated) return c.json({ error: 'not found' }, 404);
    const project = updated.projectId ? listProjects(db).find((p) => p.id === updated.projectId) : undefined;
    return c.json(toBoardCard(db, updated, project?.name ?? null, project?.laneColor ?? null));
  });

  api.post('/cards/:id/move', async (c) => {
    const parsed = moveCardSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid move', detail: parsed.error.message }, 400);
    const id = c.req.param('id');
    if (!getCard(db, id)) return c.json({ error: 'not found' }, 404);
    const moved = moveCard(db, id, parsed.data.stage, parsed.data.index);
    return moved ? c.json(toBoardCard(db, moved, null, null)) : c.json({ error: 'not found' }, 404);
  });

  api.post('/cards/:id/archive', (c) => {
    const archived = archiveCard(db, c.req.param('id'));
    return archived ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  api.get('/cards/:id/runs', (c) => c.json(runsForCard(db, c.req.param('id')).map(toApiRunSummary)));

  return api;
}
