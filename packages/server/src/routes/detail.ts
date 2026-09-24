import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
  addCriterion,
  addRef,
  criteriaFor,
  deleteCriterion,
  deleteRef,
  getCard,
  refsFor,
  updateCriterion,
} from '../db/queries.js';
import { toApiCardRef, toApiCriterion } from '../mappers.js';

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

export function detailRoutes(db: Db) {
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

  return routes;
}
