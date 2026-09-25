import { Hono } from 'hono';
import { needsWorktree } from '@reeve/shared';
import type { Db } from '../db/client.js';
import { getCard, listProjects } from '../db/queries.js';
import { card as cardTable, type Card, type Project } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { checkWorktree, createWorktree, isDirty, removeWorktree } from '../git/worktree.js';
import { toApiRunSummary } from '../mappers.js';
import { openPullRequest } from '../pullRequest.js';
import type { EventWriter } from '../runs/events.js';
import { ensureDevServer } from '../runs/devServer.js';
import { runRegistry } from '../runs/registry.js';
import { startShellRun } from '../runs/shell.js';

export function actionRoutes(db: Db, writer: EventWriter) {
  const routes = new Hono();

  const projectFor = (projectId: string | null) =>
    projectId ? listProjects(db).find((p) => p.id === projectId) : undefined;

  /** Teardown, then remove. Ordered so a failed teardown never strands the tree. */
  const teardownWorktree = async (card: Card, project: Project, path: string) => {
    for (const run of runRegistry.all().filter((r) => r.cardId === card.id && r.kind === 'server')) {
      await run.stop('cancelled_by_user');
    }
    if (project.teardownCommand) {
      const handle = startShellRun({
        db, writer, cardId: card.id, stage: card.stage,
        command: project.teardownCommand, cwd: path,
      });
      await handle.done;
    }
    const force = await isDirty(path).catch(() => true);
    await removeWorktree(project.repoPath, path, force);
    db.update(cardTable)
      .set({ worktreePath: null, updatedAt: new Date() })
      .where(eq(cardTable.id, card.id))
      .run();
    return force;
  };

  /** Create the worktree and, if the project defines one, run its setup command. */
  routes.post('/:id/worktree', async (c) => {
    const cardId = c.req.param('id');
    const card = getCard(db, cardId);
    if (!card) return c.json({ error: 'not found' }, 404);
    if (card.archivedAt) return c.json({ error: 'card is archived' }, 409);
    const project = projectFor(card.projectId);
    if (!project) return c.json({ error: 'card has no project', detail: 'a worktree needs a repo' }, 400);
    if (!needsWorktree(card.stage)) {
      return c.json({ error: 'stage does not need a worktree', detail: card.stage }, 400);
    }

    const health = await checkWorktree(project.repoPath, card.worktreePath);
    if (health.state === 'ok') return c.json({ ok: true, reused: true, path: health.path });

    const created = await createWorktree({
      repoPath: project.repoPath,
      worktreeRoot: project.worktreeRoot,
      cardId,
      title: card.title,
      baseBranch: project.defaultBranch,
    });
    db.update(cardTable)
      .set({ worktreePath: created.path, branchName: created.branch, baseSha: created.baseSha, updatedAt: new Date() })
      .where(eq(cardTable.id, cardId))
      .run();

    let setupRunId: string | null = null;
    if (project.setupCommand) {
      const handle = startShellRun({
        db, writer, cardId, stage: card.stage,
        command: project.setupCommand, cwd: created.path,
      });
      setupRunId = handle.runId;
    }
    return c.json({ ok: true, reused: false, path: created.path, branch: created.branch, setupRunId }, 201);
  });

  routes.delete('/:id/worktree', async (c) => {
    const card = getCard(db, c.req.param('id'));
    if (!card) return c.json({ error: 'not found' }, 404);
    const project = projectFor(card.projectId);
    if (!project || !card.worktreePath) return c.json({ error: 'no worktree to remove' }, 400);
    const forced = await teardownWorktree(card, project, card.worktreePath);
    return c.json({ ok: true, forced });
  });

  /**
   * Open the pull request by hand. Entering Done already tries once on its
   * own; this is for after that failed and the cause — a dirty tree, a missing
   * login — has been put right.
   */
  routes.post('/:id/pr', async (c) => {
    const card = getCard(db, c.req.param('id'));
    if (!card) return c.json({ error: 'not found' }, 404);
    const project = projectFor(card.projectId);
    if (!project) return c.json({ error: 'card has no project', detail: 'a pull request needs a repo' }, 400);
    const result = await openPullRequest(db, card, project);
    if (!result.ok) return c.json({ error: result.error, detail: result.detail }, result.status);
    return c.json(result, result.reused ? 200 : 201);
  });

  /** Start the project's dev server for this card, on its own port. */
  routes.post('/:id/server', async (c) => {
    const cardId = c.req.param('id');
    const card = getCard(db, cardId);
    if (!card) return c.json({ error: 'not found' }, 404);
    if (card.archivedAt) return c.json({ error: 'card is archived' }, 409);
    const project = projectFor(card.projectId);
    if (!project) return c.json({ error: 'card has no project' }, 400);

    const server = await ensureDevServer(db, writer, card, project);
    if (server.state === 'unavailable') return c.json({ error: server.reason }, 400);
    // Pressing start twice is not an error, but it is worth saying which it was.
    if (!server.started) return c.json({ error: 'server already running', detail: server.runId }, 409);
    return c.json({ ok: true, runId: server.runId, port: server.port, url: server.url }, 201);
  });

  routes.delete('/:id/server', async (c) => {
    const cardId = c.req.param('id');
    const active = runRegistry.all().find((r) => r.cardId === cardId && r.kind === 'server');
    if (!active) return c.json({ error: 'no server running' }, 404);
    await active.stop('cancelled_by_user');
    return c.json({ ok: true });
  });

  /** Run the project's test command against the worktree. */
  routes.post('/:id/test', (c) => {
    const cardId = c.req.param('id');
    const card = getCard(db, cardId);
    if (!card) return c.json({ error: 'not found' }, 404);
    if (card.archivedAt) return c.json({ error: 'card is archived' }, 409);
    const project = projectFor(card.projectId);
    if (!project?.testCommand) return c.json({ error: 'project has no test command' }, 400);
    if (!card.worktreePath) return c.json({ error: 'card has no worktree' }, 400);
    const handle = startShellRun({
      db, writer, cardId, stage: card.stage,
      command: project.testCommand, cwd: card.worktreePath,
    });
    return c.json({ ok: true, runId: handle.runId }, 201);
  });

  return routes;
}

