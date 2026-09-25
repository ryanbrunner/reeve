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
import { defaultWorktreeRoot, expandPath, inspectRepo } from '../git/worktree.js';
import { maybeOpenPullRequest } from '../pullRequest.js';

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

/**
 * Note the absence of `.default()`. `projectSchema.partial()` used to carry
 * `defaultBranch: z.string().default('main')` into PATCH, where zod applied
 * the default to the ABSENT key — so renaming a project silently moved it from
 * `develop` back to `main`. Defaults belong at the create call below, where
 * the repository can be asked what the answer should be, and nowhere else.
 */
const projectSchema = z.object({
  name: z.string().min(1),
  repoPath: z.string().min(1),
  /** Optional: derived from the repo when blank. */
  worktreeRoot: z.string().min(1).optional(),
  defaultBranch: z.string().min(1).optional(),
  setupCommand: z.string().nullable().optional(),
  testCommand: z.string().nullable().optional(),
  serverCommand: z.string().nullable().optional(),
  teardownCommand: z.string().nullable().optional(),
  finishCommand: z.string().nullable().optional(),
  laneColor: z.string().nullable().optional(),
  maxBudgetUsd: z.number().nullable().optional(),
});

/**
 * What a project has to be before it is stored: a real directory, a real
 * repository, and a branch that resolves inside it. Every one of these
 * otherwise surfaces as a failed worktree on the first run, long after the
 * typo, with an error about git rather than about the field that was wrong.
 *
 * Returns the sentence to hand back, or the repo facts when it all checks out.
 */
async function checkRepo(
  repoPath: string,
  defaultBranch: string | undefined,
): Promise<{ error: string } | { toplevel: string; branch: string }> {
  const repo = await inspectRepo(repoPath);
  if (!repo.exists) return { error: `no such directory: ${repo.path}` };
  if (!repo.isRepo) return { error: `not a git repository: ${repo.path}` };
  const toplevel = repo.toplevel!;
  if (defaultBranch === undefined) {
    const branch = repo.currentBranch;
    if (!branch) return { error: `${toplevel} has no commits yet, so there is no branch to work from` };
    return { toplevel, branch };
  }
  if (!repo.branches.includes(defaultBranch)) {
    const known = repo.branches.length ? ` Known branches: ${repo.branches.join(', ')}.` : '';
    return { error: `branch '${defaultBranch}' does not exist in ${toplevel}.${known}` };
  }
  return { toplevel, branch: defaultBranch };
}

/**
 * `name` is unique across every project including archived ones, which
 * `listProjects` cannot see — so this reads the constraint rather than
 * pre-checking a list that is missing rows.
 */
function isDuplicateName(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed: project\.name/.test(e.message);
}

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

    const checked = await checkRepo(parsed.data.repoPath, parsed.data.defaultBranch);
    if ('error' in checked) return c.json({ error: 'unusable repository', detail: checked.error }, 400);

    // The repo's own answers beat anything a person would type: the branch it
    // is actually on, and a worktree root beside it rather than inside it.
    const values = {
      ...parsed.data,
      repoPath: checked.toplevel,
      defaultBranch: checked.branch,
      worktreeRoot:
        parsed.data.worktreeRoot ? expandPath(parsed.data.worktreeRoot) : defaultWorktreeRoot(checked.toplevel),
    };
    try {
      return c.json(toApiProject(createProject(db, values)), 201);
    } catch (e) {
      if (isDuplicateName(e)) {
        return c.json({ error: 'name taken', detail: `another project is already called '${values.name}'` }, 409);
      }
      throw e;
    }
  });

  api.patch('/projects/:id', async (c) => {
    const parsed = projectSchema.partial().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid project', detail: parsed.error.message }, 400);
    const existing = listProjects(db).find((p) => p.id === c.req.param('id'));
    if (!existing) return c.json({ error: 'not found' }, 404);

    const values = { ...parsed.data };
    // Either field can invalidate the other, so a change to one is re-checked
    // against the stored value of the other rather than on its own.
    if (values.repoPath !== undefined || values.defaultBranch !== undefined) {
      const checked = await checkRepo(
        values.repoPath ?? existing.repoPath,
        values.defaultBranch ?? existing.defaultBranch,
      );
      if ('error' in checked) return c.json({ error: 'unusable repository', detail: checked.error }, 400);
      if (values.repoPath !== undefined) values.repoPath = checked.toplevel;
    }
    if (values.worktreeRoot !== undefined) values.worktreeRoot = expandPath(values.worktreeRoot);

    try {
      const updated = updateProject(db, c.req.param('id'), values);
      return updated ? c.json(toApiProject(updated)) : c.json({ error: 'not found' }, 404);
    } catch (e) {
      if (isDuplicateName(e)) {
        return c.json({ error: 'name taken', detail: `another project is already called '${values.name}'` }, 409);
      }
      throw e;
    }
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
    const before = getCard(db, id);
    if (!before) return c.json({ error: 'not found' }, 404);
    const moved = moveCard(db, id, parsed.data.stage, parsed.data.index);
    if (!moved) return c.json({ error: 'not found' }, 404);
    // Started before the response is built, so the card it returns already
    // says a pull request is on its way.
    if (before.stage !== 'done' && moved.stage === 'done') {
      maybeOpenPullRequest(db, moved, listProjects(db).find((p) => p.id === moved.projectId));
    }
    return c.json(toBoardCard(db, moved, null, null));
  });

  api.post('/cards/:id/archive', (c) => {
    const archived = archiveCard(db, c.req.param('id'));
    return archived ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  api.get('/cards/:id/runs', (c) => c.json(runsForCard(db, c.req.param('id')).map(toApiRunSummary)));

  return api;
}
