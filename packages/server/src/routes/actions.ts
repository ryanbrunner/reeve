import { Hono } from 'hono';
import { needsWorktree } from '@reeve/shared';
import type { Db } from '../db/client.js';
import { getCard, insertCardEvent, listProjects } from '../db/queries.js';
import { card as cardTable, type Card, type Project } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  GitError,
  checkWorktree,
  commitsSince,
  createWorktree,
  deleteBranch,
  findCheckout,
  isDirty,
  removeWorktree,
  squashMerge,
} from '../git/worktree.js';
import { toApiRunSummary } from '../mappers.js';
import type { EventWriter } from '../runs/events.js';
import { ensureDevServer } from '../runs/devServer.js';
import { runRegistry } from '../runs/registry.js';
import { startShellRun } from '../runs/shell.js';

/**
 * Projects with a merge under way. Two presses at once would squash twice into
 * the same checkout, and the second one's reset would undo the first.
 */
const merging = new Set<string>();

const reason = (e: unknown) => (e instanceof GitError ? e.stderr || e.message : String(e));

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
   * Land a Done card on the project's default branch as one commit, titled with
   * the card, then clear away its worktree and branch.
   *
   * The one action that writes outside a card's own sandbox — into the checkout
   * a person works in — so it refuses anything it could not put back: work left
   * uncommitted on either side, or a base branch it cannot find. The merge is
   * recorded before the cleanup starts, so a cleanup that fails leaves a card
   * that knows it merged, rather than one a second press would squash again.
   */
  routes.post('/:id/merge', async (c) => {
    const cardId = c.req.param('id');
    const card = getCard(db, cardId);
    if (!card) return c.json({ error: 'not found' }, 404);
    if (card.stage !== 'done') return c.json({ error: 'only a Done card can be merged', detail: card.stage }, 400);
    if (card.mergedSha) return c.json({ error: 'already merged', detail: card.mergedSha }, 409);
    const project = projectFor(card.projectId);
    if (!project) return c.json({ error: 'card has no project', detail: 'a merge needs a repo' }, 400);
    const { branchName: branch, worktreePath, baseSha } = card;
    if (!branch || !worktreePath || !baseSha) {
      return c.json({ error: 'nothing to merge', detail: 'the card has no worktree' }, 400);
    }

    // Taken before the first await, so no second press can slip in between
    // reading the card and holding the checkout.
    if (merging.has(project.id)) return c.json({ error: 'a merge is already under way', detail: project.name }, 409);
    merging.add(project.id);
    try {
      const health = await checkWorktree(project.repoPath, worktreePath);
      if (health.state !== 'ok') {
        return c.json({ error: 'worktree missing', detail: health.state === 'missing' ? health.reason : worktreePath }, 400);
      }
      if ((await commitsSince(health.path, baseSha)).length === 0) {
        return c.json({ error: 'nothing to merge', detail: 'the card has no commits on its branch' }, 400);
      }
      // `.reeve/` is where every stage leaves its record, untracked. It is not
      // work, and counting it would refuse every card there is.
      if (await isDirty(health.path, { ignore: ['.reeve'] })) {
        return c.json({
          error: 'the card has uncommitted changes',
          detail: 'only commits are merged — commit or discard them in the worktree first',
        }, 409);
      }

      const base = project.defaultBranch;
      const checkout = await findCheckout(project.repoPath, base);
      if (!checkout) {
        return c.json({ error: `${base} is not checked out anywhere`, detail: `check it out in ${project.repoPath} first` }, 409);
      }
      // Tracked changes only: a failed squash is put back with a reset that
      // would take them too. Untracked files are safe — git refuses to merge
      // over one rather than overwrite it.
      if (await isDirty(checkout, { untracked: false })) {
        return c.json({ error: `${base} has uncommitted changes`, detail: `commit or stash them in ${checkout} first` }, 409);
      }

      let sha: string;
      try {
        sha = await squashMerge({
          checkoutPath: checkout,
          branch,
          message: [card.title, `Reeve #${card.number}, branch ${branch}`],
        });
      } catch (e) {
        return c.json({ error: e instanceof GitError ? e.message : 'merge failed', detail: reason(e) }, 409);
      }

      const mergedAt = new Date();
      db.update(cardTable)
        .set({ mergedSha: sha, mergedAt, updatedAt: mergedAt })
        .where(eq(cardTable.id, cardId))
        .run();
      insertCardEvent(db, {
        cardId, actor: 'human', kind: 'merged', stage: card.stage,
        meta: { sha, branch, into: base },
      });

      // Landed. Everything after this is tidying, and a failure in it is
      // reported beside the success rather than instead of it.
      const cleanup: string[] = [];
      await teardownWorktree(card, project, worktreePath).catch((e) => cleanup.push(`worktree: ${reason(e)}`));
      await deleteBranch(project.repoPath, branch).catch((e) => cleanup.push(`branch: ${reason(e)}`));
      return c.json({ ok: true, sha, ...(cleanup.length ? { cleanup: cleanup.join('; ') } : {}) });
    } finally {
      merging.delete(project.id);
    }
  });

  /** Start the project's dev server for this card, on its own port. */
  routes.post('/:id/server', async (c) => {
    const cardId = c.req.param('id');
    const card = getCard(db, cardId);
    if (!card) return c.json({ error: 'not found' }, 404);
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

