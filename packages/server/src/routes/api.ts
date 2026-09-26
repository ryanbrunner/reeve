import { Hono } from 'hono';
import { z } from 'zod';
import { CARD_KINDS, EFFORT_LEVELS, RUNNABLE_STAGES, STAGES } from '@reeve/shared';
import type { ApiSettings, BoardResponse, ModelsResponse, StageRunDefaults } from '@reeve/shared';
import { toBoardCard } from '../board.js';
import type { Db } from '../db/client.js';
import {
  archiveCard,
  archivedCards,
  boardCards,
  boardProjects,
  createCard,
  createRepo,
  discardIfBlank,
  getCard,
  getSettings,
  listRepos,
  liveProject,
  moveCard,
  restoreCard,
  runsForCard,
  tasksInProject,
  updateCard,
  updateRepo,
  updateSettings,
} from '../db/queries.js';
import { toApiProject, toApiRepo, toApiRunSummary } from '../mappers.js';
import { defaultWorktreeRoot, expandPath, inspectRepo } from '../git/worktree.js';
import type { EventWriter } from '../runs/events.js';
import { listModels } from '../runs/models.js';
import { runRegistry } from '../runs/registry.js';
import { maybeOpenPullRequest } from '../pullRequest.js';
import { sickoState } from '../sicko/state.js';
import { maybeStartStage } from '../startStage.js';
import { startSplit } from './detail.js';
import { STAGE_DEFINITIONS } from '../stages/index.js';

const stageSchema = z.enum(STAGES);

/**
 * Any non-empty string, not one of the listed models: an alias or id stored
 * while the CLI listed it should keep working on a day it cannot be asked.
 * The pickers are what keep a person to the list.
 */
const modelSchema = z.string().min(1).nullable();
const effortSchema = z.enum(EFFORT_LEVELS).nullable();

const createCardSchema = z.object({
  title: z.string().min(1, 'title is required'),
  body: z.string().optional(),
  repoId: z.string().nullable().optional(),
  stage: stageSchema.optional(),
  kind: z.enum(CARD_KINDS).optional(),
  projectId: z.string().nullable().optional(),
  generateMockups: z.boolean().optional(),
});

const updateCardSchema = z.object({
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  repoId: z.string().nullable().optional(),
  model: modelSchema.optional(),
  effort: effortSchema.optional(),
  generateMockups: z.boolean().optional(),
});

const moveCardSchema = z.object({
  stage: stageSchema,
  index: z.number().int().min(0),
  projectId: z.string().nullable().optional(),
});

/**
 * Note the absence of `.default()`. `repoSchema.partial()` used to carry
 * `defaultBranch: z.string().default('main')` into PATCH, where zod applied
 * the default to the ABSENT key — so renaming a repo silently moved it from
 * `develop` back to `main`. Defaults belong at the create call below, where
 * the repository can be asked what the answer should be, and nowhere else.
 */
const repoSchema = z.object({
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

/** At least one: a cap of zero would refuse every run, which is a switch, not a limit. */
const settingsSchema = z.object({
  maxConcurrentRuns: z.number().int().min(1).optional(),
  sicko: z.boolean().optional(),
  // Partial: a stage left out is left as it is.
  stageDefaults: z
    .partialRecord(z.enum(RUNNABLE_STAGES), z.object({ model: modelSchema, effort: effortSchema }))
    .optional(),
});

/** Each stage's model and effort as its own module sets them, beneath Settings and the card. */
function builtInStageDefaults(): StageRunDefaults {
  return Object.fromEntries(
    RUNNABLE_STAGES.map((s) => [
      s,
      { model: STAGE_DEFINITIONS[s]?.model ?? null, effort: STAGE_DEFINITIONS[s]?.effort ?? null },
    ]),
  ) as StageRunDefaults;
}

/**
 * What a repo has to be before it is stored: a real directory, a real
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
 * `name` is unique across every repo including archived ones, which
 * `listRepos` cannot see — so this reads the constraint rather than
 * pre-checking a list that is missing rows.
 */
function isDuplicateName(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed: repo\.name/.test(e.message);
}

export function apiRoutes(db: Db, writer: EventWriter) {
  const api = new Hono();

  api.get('/board', (c) => {
    const rows = boardCards(db);
    const body: BoardResponse = {
      repos: listRepos(db).map(toApiRepo),
      projects: boardProjects(db).map((p) => toApiProject(p.card, p.laneColor, p.taskCount)),
      cards: rows.map((r) => toBoardCard(db, r.card, r.repoName, r.laneColor)),
      // On the board response rather than its own endpoint: every number in it
      // changes on the same beat as the cards, and the board is already polling.
      sicko: sickoState(db),
    };
    return c.json(body);
  });

  // Not on `/board`, which the board polls every few seconds for something
  // that changes when a person opens Settings and nothing else.
  api.get('/settings', (c) => {
    const body: ApiSettings = getSettings(db);
    return c.json(body);
  });

  api.patch('/settings', async (c) => {
    const parsed = settingsSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid settings', detail: parsed.error.message }, 400);
    const body: ApiSettings = updateSettings(db, parsed.data);
    return c.json(body);
  });

  // Asked of the CLI once per process, so only the first call after boot can
  // be slow. An empty list is an answer: the pickers offer defaults only.
  api.get('/models', async (c) => {
    const body: ModelsResponse = { models: await listModels(), builtIn: builtInStageDefaults() };
    return c.json(body);
  });

  api.get('/repos', (c) => c.json(listRepos(db).map(toApiRepo)));

  api.post('/repos', async (c) => {
    const parsed = repoSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid repo', detail: parsed.error.message }, 400);

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
      return c.json(toApiRepo(createRepo(db, values)), 201);
    } catch (e) {
      if (isDuplicateName(e)) {
        return c.json({ error: 'name taken', detail: `another repo is already called '${values.name}'` }, 409);
      }
      throw e;
    }
  });

  api.patch('/repos/:id', async (c) => {
    const parsed = repoSchema.partial().safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid repo', detail: parsed.error.message }, 400);
    const existing = listRepos(db).find((p) => p.id === c.req.param('id'));
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
      const updated = updateRepo(db, c.req.param('id'), values);
      return updated ? c.json(toApiRepo(updated)) : c.json({ error: 'not found' }, 404);
    } catch (e) {
      if (isDuplicateName(e)) {
        return c.json({ error: 'name taken', detail: `another repo is already called '${values.name}'` }, 409);
      }
      throw e;
    }
  });

  api.post('/cards', async (c) => {
    const parsed = createCardSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid card', detail: parsed.error.message }, 400);
    if (parsed.data.repoId && !listRepos(db).some((p) => p.id === parsed.data.repoId)) {
      return c.json({ error: 'no such repo', detail: parsed.data.repoId }, 400);
    }
    const { kind, projectId } = parsed.data;
    if (kind === 'project' && projectId) {
      return c.json({ error: 'projects do not nest', detail: 'a project cannot belong to another project' }, 400);
    }
    if (kind === 'project' && parsed.data.stage && parsed.data.stage !== 'backlog') {
      return c.json({ error: 'a project has no stage', detail: parsed.data.stage }, 400);
    }
    if (projectId && !liveProject(db, projectId)) {
      return c.json({ error: 'no such project', detail: projectId }, 400);
    }
    const created = createCard(db, parsed.data);
    const repo = created.repoId ? listRepos(db).find((p) => p.id === created.repoId) : undefined;
    // Made straight into a column Claude works in is entering it, the same as a drag.
    maybeStartStage(db, writer, created, repo);
    return c.json(toBoardCard(db, created, repo?.name ?? null, repo?.laneColor ?? null), 201);
  });

  api.patch('/cards/:id', async (c) => {
    const parsed = updateCardSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid card', detail: parsed.error.message }, 400);
    const id = c.req.param('id');
    const existing = getCard(db, id);
    if (!existing) return c.json({ error: 'not found' }, 404);

    const { repoId } = parsed.data;
    if (repoId !== undefined && repoId !== existing.repoId) {
      // The branch and the directory on disk belong to the repo the card was in
      // when they were made. Repointing the card leaves them behind in a repo
      // nothing looks at any more, and every later call — diff, server, run —
      // would resolve the new repo's `repoPath` against the old tree.
      if (existing.worktreePath) {
        return c.json(
          { error: 'card has a worktree', detail: 'remove the worktree before moving the card to another repo' },
          400,
        );
      }
      // Without this the foreign key raises, which is a 500 for what is a
      // caller's mistake.
      if (repoId !== null && !listRepos(db).some((p) => p.id === repoId)) {
        return c.json({ error: 'no such repo', detail: repoId }, 400);
      }
    }

    const updated = updateCard(db, id, parsed.data);
    if (!updated) return c.json({ error: 'not found' }, 404);
    // A project's first brief is split on its own. Only the first: compared
    // against the body before this save, so rewording a brief later never
    // spends money unasked — that is the Split button's job. A refusal, or
    // anything thrown, must not fail the save: the brief is already stored.
    if (updated.kind === 'project' && !existing.body.trim() && updated.body.trim()
      && tasksInProject(db, id).length === 0) {
      try {
        const split = startSplit(db, writer, updated);
        if (!split.ok) console.log(`[reeve] project "${updated.title}" not split: ${split.error}`);
      } catch (e) {
        console.error(`[reeve] splitting project "${updated.title}" failed: ${String(e)}`);
      }
    }
    const repo = updated.repoId ? listRepos(db).find((p) => p.id === updated.repoId) : undefined;
    return c.json(toBoardCard(db, updated, repo?.name ?? null, repo?.laneColor ?? null));
  });

  api.post('/cards/:id/move', async (c) => {
    const parsed = moveCardSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid move', detail: parsed.error.message }, 400);
    const id = c.req.param('id');
    const before = getCard(db, id);
    if (!before) return c.json({ error: 'not found' }, 404);
    // A project is a lane, not something in one.
    if (before.kind === 'project') return c.json({ error: 'a project cannot be moved', detail: before.title }, 400);
    const { projectId } = parsed.data;
    if (projectId && !liveProject(db, projectId)) {
      return c.json({ error: 'no such project', detail: projectId }, 400);
    }
    const moved = moveCard(db, id, parsed.data.stage, parsed.data.index, 'human', projectId);
    if (!moved) return c.json({ error: 'not found' }, 404);
    // Started before the response is built, so the card it returns already
    // says a pull request is on its way. A reorder within a column is not
    // entering it, and starts nothing.
    if (before.stage !== moved.stage) {
      const repo = listRepos(db).find((p) => p.id === moved.repoId);
      if (moved.stage === 'done') maybeOpenPullRequest(db, moved, repo);
      else maybeStartStage(db, writer, moved, repo);
    }
    return c.json(toBoardCard(db, moved, null, null));
  });

  api.get('/cards/archived', (c) =>
    c.json(archivedCards(db).map((r) => toBoardCard(db, r.card, r.repoName, r.laneColor))),
  );

  api.post('/cards/:id/archive', (c) => {
    const id = c.req.param('id');
    const existing = getCard(db, id);
    if (!existing) return c.json({ error: 'not found' }, 404);
    if (existing.archivedAt) return c.json({ ok: true });
    // Anything still running would carry on out of sight: a Claude run spending
    // budget, or a dev server holding its port, on a card nobody can see.
    if (runRegistry.all().some((r) => r.cardId === id)) {
      return c.json({ error: 'card is running', detail: 'stop the run and the server before archiving' }, 409);
    }
    archiveCard(db, id);
    return c.json({ ok: true });
  });

  // Asked whenever a card closes, of every card, and it is the server that
  // decides whether this one goes, because only the server sees its criteria,
  // references, pictures and tasks as they are right now. It is conditional,
  // which is why it is a POST: a DELETE would read as "get rid of it", and
  // nothing a person does on the board removes a card outright.
  api.post('/cards/:id/discard', (c) => {
    const id = c.req.param('id');
    if (!getCard(db, id)) return c.json({ error: 'not found' }, 404);
    return c.json({ deleted: discardIfBlank(db, id) });
  });

  api.post('/cards/:id/restore', (c) => {
    const id = c.req.param('id');
    const existing = getCard(db, id);
    if (!existing) return c.json({ error: 'not found' }, 404);
    const restored = existing.archivedAt ? (restoreCard(db, id) ?? existing) : existing;
    const repo = restored.repoId ? listRepos(db).find((p) => p.id === restored.repoId) : undefined;
    return c.json(toBoardCard(db, restored, repo?.name ?? null, repo?.laneColor ?? null));
  });

  api.get('/cards/:id/runs', (c) => c.json(runsForCard(db, c.req.param('id')).map(toApiRunSummary)));

  return api;
}
