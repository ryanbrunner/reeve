import { Hono } from 'hono';
import { z } from 'zod';
import { STAGES } from '@reeve/shared';
import type { BoardResponse } from '@reeve/shared';
import type { Db } from '../db/client.js';
import {
  archiveCard,
  boardCards,
  createCard,
  createProject,
  getCard,
  latestRunForCard,
  listProjects,
  moveCard,
  runsForCard,
  updateCard,
  updateProject,
} from '../db/queries.js';
import { toApiCard, toApiProject, toApiRunSummary } from '../mappers.js';

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
      cards: rows.map((r) =>
        toApiCard(r.card, r.projectName, r.laneColor, latestRunForCard(db, r.card.id) ?? null),
      ),
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
    const created = createCard(db, parsed.data);
    return c.json(toApiCard(created, null, null, null), 201);
  });

  api.patch('/cards/:id', async (c) => {
    const parsed = updateCardSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid card', detail: parsed.error.message }, 400);
    const updated = updateCard(db, c.req.param('id'), parsed.data);
    return updated ? c.json(toApiCard(updated, null, null, null)) : c.json({ error: 'not found' }, 404);
  });

  api.post('/cards/:id/move', async (c) => {
    const parsed = moveCardSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid move', detail: parsed.error.message }, 400);
    const id = c.req.param('id');
    if (!getCard(db, id)) return c.json({ error: 'not found' }, 404);
    const moved = moveCard(db, id, parsed.data.stage, parsed.data.index);
    return moved ? c.json(toApiCard(moved, null, null, null)) : c.json({ error: 'not found' }, 404);
  });

  api.post('/cards/:id/archive', (c) => {
    const archived = archiveCard(db, c.req.param('id'));
    return archived ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  api.get('/cards/:id/runs', (c) => c.json(runsForCard(db, c.req.param('id')).map(toApiRunSummary)));

  return api;
}
