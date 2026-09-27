import { Hono } from 'hono';
import { z } from 'zod';
import { CARD_KINDS, EFFORT_LEVELS, RUNNABLE_STAGES, STAGES, stageEntryRefusal } from '@reeve/shared';
import type { ApiSettings, ArchiveCardResponse, BoardResponse, ModelsResponse, StageRunDefaults } from '@reeve/shared';
import { deleteAsset } from '../assets/store.js';
import { entryRefusal, toBoardCard } from '../board.js';
import { blockedMove } from '../blockers.js';
import type { Db } from '../db/client.js';
import {
  archiveCard,
  archiveProject,
  archivedCards,
  boardCards,
  boardProjects,
  createCard,
  createRepo,
  cardLinks,
  discardIfBlank,
  getCard,
  getSettings,
  listRepos,
  liveProject,
  liveTasksInProject,
  moveCard,
  prunePastedAssets,
  restoreCard,
  restoreProject,
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
import { SERVER_VARS, unknownVars } from '../runs/serverUrl.js';
import { cleanUpArchivedWorktrees, maybeOpenPullRequest } from '../pullRequest.js';
import { vibesState } from '../vibes/state.js';
import { maybeStartStage } from '../startStage.js';
import { startSplit } from './detail.js';
import { STAGE_DEFINITIONS } from '../stages/index.js';
import { usageState } from '../usage.js';

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
  vibes: z.boolean().optional(),
});

const moveCardSchema = z.object({
  stage: stageSchema,
  index: z.number().int().min(0),
  projectId: z.string().nullable().optional(),
});

const archiveCardSchema = z.object({
  detachOpen: z.boolean().optional(),
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
  serverCommand: z.string().nullable().optional().superRefine(knownVarsOnly('Server command')),
  serverUrl: z
    .string()
    .nullable()
    .optional()
    .superRefine(knownVarsOnly('Server URL'))
    .refine((v) => !v || /^https?:\/\//.test(v), 'Server URL must start with http:// or https://'),
  teardownCommand: z.string().nullable().optional(),
  finishCommand: z.string().nullable().optional(),
  laneColor: z.string().nullable().optional(),
  syncDefaultBranch: z.boolean().optional(),
});

/**
 * Refuses a `{{name}}` that `fillVars` would not fill. Left in, it would reach
 * the shell or the browser as written, and fail long after the typo that
 * caused it. On the field rather than the object, so `.partial()` keeps it.
 */
function knownVarsOnly(field: string) {
  return (value: string | null | undefined, ctx: z.RefinementCtx) => {
    const unknown = value ? unknownVars(value) : [];
    if (unknown.length === 0) return;
    ctx.addIssue({
      code: 'custom',
      message:
        `${field} uses ${unknown.map((n) => `{{${n}}}`).join(', ')}, which Reeve does not fill. ` +
        `It knows ${SERVER_VARS.map((n) => `{{${n}}}`).join(', ')}.`,
    });
  };
}

/**
 * The sentences zod's issues carry, rather than its JSON dump of them: the
 * form shows `detail` as written, and an unknown variable should read as one.
 */
const issuesText = (error: z.ZodError) =>
  error.issues.map((i) => (i.code === 'custom' ? i.message : `${i.path.join('.')}: ${i.message}`)).join('; ');

/** At least one: a cap of zero would refuse every run, which is a switch, not a limit. */
const settingsSchema = z.object({
  maxConcurrentRuns: z.number().int().min(1).optional(),
  vibes: z.boolean().optional(),
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
    const links = cardLinks(db);
    const body: BoardResponse = {
      repos: listRepos(db).map(toApiRepo),
      projects: boardProjects(db).map((p) => toApiProject(p.card, p.laneColor, p.taskCount)),
      cards: rows.map((r) => toBoardCard(db, r.card, r.repoName, r.laneColor, links)),
      // On the board response rather than its own endpoint: every number in it
      // changes on the same beat as the cards, and the board is already polling.
      vibes: vibesState(db),
      // Here for the same reason. Read from memory, never the table: see usage.ts.
      usage: usageState(Date.now()),
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
    if (!parsed.success) return c.json({ error: 'invalid repo', detail: issuesText(parsed.error) }, 400);

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
    if (!parsed.success) return c.json({ error: 'invalid repo', detail: issuesText(parsed.error) }, 400);
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
    // Made straight into a column is entering it, so the rule a drag meets
    // applies here too, and a card that does not exist yet has built nothing.
    const refusal = stageEntryRefusal('backlog', parsed.data.stage ?? 'backlog', false);
    if (refusal) return c.json({ error: 'not implemented', detail: refusal }, 409);
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
      // Once merged, the branch outlives the worktree, and its diff and commits
      // are read from it in the repo it was cut in. Moved, the card would ask
      // the new repo for a branch it has never had.
      if (existing.mergedAt && existing.branchName) {
        return c.json(
          { error: 'card has merged', detail: 'its branch stays in the repo it was merged from' },
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
    // Saving the brief is the one moment an image pasted into it can stop being
    // linked, and nothing else ever deletes one. Only when the body was sent:
    // renaming the card or flipping a toggle changes nothing it links. The body
    // it had goes too, for the images it linked that another card owns.
    if (parsed.data.body !== undefined) {
      for (const path of prunePastedAssets(db, id, existing.body)) deleteAsset(path);
    }
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
    // A card whose dependencies have not cleared may only go back to Backlog,
    // from wherever it is: every other column runs Claude on code that is not
    // on main yet, or pushes a branch built without it. A card already past
    // Backlog when a dependency was added stays where it is — nothing pulls it
    // back — but can only be moved to Backlog. Reorders are always fine.
    const blocked = blockedMove(db, before, parsed.data.stage);
    if (blocked) return c.json({ error: blocked.error, detail: blocked.detail }, blocked.status);
    // Entering Testing starts a run against the branch and entering Done pushes
    // it, so with nothing built yet one tests nothing and the other opens an
    // empty pull request. Reorders and moves backwards are never refused.
    const refusal = entryRefusal(db, before, parsed.data.stage);
    if (refusal) return c.json({ error: 'not implemented', detail: refusal }, 409);
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

  api.get('/cards/archived', (c) => {
    const links = cardLinks(db);
    return c.json(archivedCards(db).map((r) => toBoardCard(db, r.card, r.repoName, r.laneColor, links)));
  });

  // One card as the board has it. After `/cards/archived`, which it would
  // otherwise answer for. `reeve card wait` polls this: `/detail` is the whole
  // card modal and shells out to git, and `/board` is every card there is.
  api.get('/cards/:id', (c) => {
    const card = getCard(db, c.req.param('id'));
    if (!card) return c.json({ error: 'not found' }, 404);
    const repo = card.repoId ? listRepos(db).find((p) => p.id === card.repoId) : undefined;
    return c.json(toBoardCard(db, card, repo?.name ?? null, repo?.laneColor ?? null));
  });

  api.post('/cards/:id/archive', async (c) => {
    const parsed = archiveCardSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid archive', detail: parsed.error.message }, 400);
    const id = c.req.param('id');
    const existing = getCard(db, id);
    if (!existing) return c.json({ error: 'not found' }, 404);
    if (existing.archivedAt) return c.json({ ok: true } satisfies ArchiveCardResponse);
    // Nothing is awaited from here on, so no run can start and no card can
    // move between these checks and the archive they allow.
    if (existing.kind === 'project') {
      const { done, open } = liveTasksInProject(db, id);
      // Its Done cards leave with it, so they are held to the rule below too.
      // Its open cards stay on the board, and may keep running there.
      const leaving = new Set([id, ...done.map((t) => t.id)]);
      if (runRegistry.all().some((r) => leaving.has(r.cardId))) {
        return c.json({
          error: 'card is running',
          detail: 'stop the runs and servers on the project and its Done cards before archiving',
        }, 409);
      }
      if (open.length > 0 && !parsed.data.detachOpen) {
        const named = [...open].sort((a, b) => a.number - b.number).slice(0, 3).map((t) => `#${t.number} ${t.title}`);
        const more = open.length > 3 ? ` and ${open.length - 3} more` : '';
        return c.json({
          error: 'project has open cards',
          detail: `${open.length} ${open.length === 1 ? 'card is' : 'cards are'} not Done (${named.join(', ')}${more}).`
            + ' Archive with detachOpen (--detach-open) to move them to No project.',
        }, 409);
      }
      const counts = archiveProject(db, id);
      // The Done cards that went with it lose their worktrees now too, if they
      // merged, as when each is archived on its own. The sweep only acts on
      // merged cards, so it costs one query when none of them did.
      if (counts?.archived) {
        cleanUpArchivedWorktrees(db, writer).catch((e) => {
          console.error(`[reeve] removing worktrees of project #${existing.number}'s cards failed: ${String(e)}`);
        });
      }
      return c.json({ ok: true, ...counts } satisfies ArchiveCardResponse);
    }
    // Anything still running would carry on out of sight: a Claude run spending
    // budget, or a dev server holding its port, on a card nobody can see.
    if (runRegistry.all().some((r) => r.cardId === id)) {
      return c.json({ error: 'card is running', detail: 'stop the run and the server before archiving' }, 409);
    }
    const archived = archiveCard(db, id);
    // A merged card's worktree goes now rather than on the next tick. Not
    // awaited, the same as the automatic pull request: a teardown command can
    // take a while, and the card is already off the board.
    if (archived?.mergedAt && archived.worktreePath) {
      cleanUpArchivedWorktrees(db, writer).catch((e) => {
        console.error(`[reeve] removing the worktree of #${archived.number} failed: ${String(e)}`);
      });
    }
    return c.json({ ok: true } satisfies ArchiveCardResponse);
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
    // A project brings back the Done cards archived with it.
    const restored = !existing.archivedAt ? existing
      : ((existing.kind === 'project' ? restoreProject(db, id) : restoreCard(db, id)) ?? existing);
    const repo = restored.repoId ? listRepos(db).find((p) => p.id === restored.repoId) : undefined;
    return c.json(toBoardCard(db, restored, repo?.name ?? null, repo?.laneColor ?? null));
  });

  api.get('/cards/:id/runs', (c) => c.json(runsForCard(db, c.req.param('id')).map(toApiRunSummary)));

  return api;
}
