import { Hono } from 'hono';
import {
  needsWorktree,
  type CritReviewResponse,
  type MergePullRequestResponse,
  type ResolveConflictsResponse,
} from '@reeve/shared';
import { cardActivity } from '../board.js';
import { startCritReview } from '../crit.js';
import type { Db } from '../db/client.js';
import { getCard, insertCardEvent, latestClaudeRunForStage, listRepos } from '../db/queries.js';
import { GitError, checkWorktree } from '../git/worktree.js';
import { writeHandoff } from '../handoff.js';
import { toApiRunSummary } from '../mappers.js';
import { canMergePr, isPrConflicting, landPullRequest, openPullRequest } from '../pullRequest.js';
import { resolveConflicts } from '../resolveConflicts.js';
import type { EventWriter } from '../runs/events.js';
import { ensureDevServer } from '../runs/devServer.js';
import { runRegistry } from '../runs/registry.js';
import { startShellRun } from '../runs/shell.js';
import { ensureWorktree, refuseMergedWorktree, removeCardWorktree } from '../startStage.js';

export function actionRoutes(db: Db, writer: EventWriter) {
  const routes = new Hono();

  const repoFor = (repoId: string | null) =>
    repoId ? listRepos(db).find((p) => p.id === repoId) : undefined;

  /** Create the worktree and, if the repo defines one, run its setup command. */
  routes.post('/:id/worktree', async (c) => {
    const cardId = c.req.param('id');
    const card = getCard(db, cardId);
    if (!card) return c.json({ error: 'not found' }, 404);
    if (card.archivedAt) return c.json({ error: 'card is archived' }, 409);
    const repo = repoFor(card.repoId);
    if (!repo) return c.json({ error: 'card has no repo', detail: 'a worktree needs a repo' }, 400);
    if (!needsWorktree(card.stage)) {
      return c.json({ error: 'stage does not need a worktree', detail: card.stage }, 400);
    }
    const merged = refuseMergedWorktree(card);
    if (merged) return c.json(merged, 409);

    // Caught, so git's own words reach the caller rather than a bare 500 —
    // the same answer startStage gives when the worktree cannot be made.
    let worktree: Awaited<ReturnType<typeof ensureWorktree>>;
    try {
      worktree = await ensureWorktree(db, writer, card, repo);
    } catch (e) {
      const detail = e instanceof GitError ? e.stderr || e.message : String(e);
      return c.json({ error: 'could not create the worktree', detail }, 500);
    }
    return c.json({ ok: true, ...worktree }, worktree.reused ? 200 : 201);
  });

  routes.delete('/:id/worktree', async (c) => {
    const card = getCard(db, c.req.param('id'));
    if (!card) return c.json({ error: 'not found' }, 404);
    const repo = repoFor(card.repoId);
    if (!repo || !card.worktreePath) return c.json({ error: 'no worktree to remove' }, 400);
    const removal = await removeCardWorktree(db, writer, card, repo, { reason: 'by_hand' });
    return c.json({ ok: true, forced: removal.removed && removal.forced });
  });

  /**
   * Open the pull request by hand. Entering Done already tries once on its
   * own; this is for after that failed and the cause — a dirty tree, a missing
   * login — has been put right.
   */
  routes.post('/:id/pr', async (c) => {
    const card = getCard(db, c.req.param('id'));
    if (!card) return c.json({ error: 'not found' }, 404);
    const repo = repoFor(card.repoId);
    if (!repo) return c.json({ error: 'card has no repo', detail: 'a pull request needs a repo' }, 400);
    const result = await openPullRequest(db, card, repo);
    if (!result.ok) return c.json({ error: result.error, detail: result.detail }, result.status);
    return c.json(result, result.reused ? 200 : 201);
  });

  /**
   * Merge the base branch into a Done card's branch and push it to its pull
   * request, with Claude resolving the conflicts in between. Answers once the
   * run has started, or once the push is done if the base merged cleanly and
   * no run was needed. See resolveConflicts.ts.
   */
  routes.post('/:id/resolve-conflicts', async (c) => {
    const card = getCard(db, c.req.param('id'));
    if (!card) return c.json({ error: 'not found' }, 404);
    if (card.archivedAt) return c.json({ error: 'card is archived' }, 409);
    const repo = repoFor(card.repoId);
    if (!repo) return c.json({ error: 'card has no repo', detail: 'a merge needs a repo' }, 400);
    const result = await resolveConflicts(db, writer, card, repo);
    if (!result.ok) return c.json({ error: result.error, detail: result.detail }, result.status);
    const body: ResolveConflictsResponse = { runId: result.runId, pushed: result.pushed };
    return c.json(body, result.runId ? 201 : 200);
  });

  /**
   * Merge a Done card's pull request on GitHub, from the board. Only one that
   * GitHub has said merges cleanly: the button is not offered otherwise, and a
   * page left open since is refused the same. Branch protection still applies;
   * see mergePullRequest.
   */
  routes.post('/:id/merge', async (c) => {
    const card = getCard(db, c.req.param('id'));
    if (!card) return c.json({ error: 'not found' }, 404);
    if (card.archivedAt) return c.json({ error: 'card is archived' }, 409);
    const repo = repoFor(card.repoId);
    if (!repo) return c.json({ error: 'card has no repo', detail: 'a merge needs a repo' }, 400);
    if (card.mergedAt) return c.json({ error: 'already merged', detail: card.prUrl ?? `#${card.number}` }, 409);
    if (!canMergePr(card)) {
      return c.json({
        error: 'not ready to merge',
        detail: card.stage !== 'done' ? 'only a Done card’s pull request is merged'
          : !card.prUrl ? 'the card has no pull request'
          : isPrConflicting(card) ? 'GitHub says the pull request has conflicts'
          : 'GitHub has not yet said the pull request can merge; it is asked again on the next sync',
      }, 409);
    }
    const result = await landPullRequest(db, card, repo, 'human');
    if (!result.ok) return c.json({ error: result.error, detail: result.detail }, result.status);
    const body: MergePullRequestResponse = { merged: result.merged };
    return c.json(body);
  });

  /** Start the repo's dev server for this card, on its own port. */
  routes.post('/:id/server', async (c) => {
    const cardId = c.req.param('id');
    const card = getCard(db, cardId);
    if (!card) return c.json({ error: 'not found' }, 404);
    if (card.archivedAt) return c.json({ error: 'card is archived' }, 409);
    const repo = repoFor(card.repoId);
    if (!repo) return c.json({ error: 'card has no repo' }, 400);

    const server = await ensureDevServer(db, writer, card, repo);
    if (server.state === 'unavailable') return c.json({ error: server.reason }, 400);
    // Pressing start twice is not an error, but it is worth saying which it was.
    if (!server.started) return c.json({ error: 'server already running', detail: server.runId }, 409);
    // `url` is null for a server that has yet to print where it is; the card's
    // detail picks it up from the run once it does.
    return c.json({ ok: true, runId: server.runId, port: server.port, url: server.url }, 201);
  });

  routes.delete('/:id/server', async (c) => {
    const cardId = c.req.param('id');
    const active = runRegistry.all().find((r) => r.cardId === cardId && r.kind === 'server');
    if (!active) return c.json({ error: 'no server running' }, 404);
    await active.stop('cancelled_by_user');
    return c.json({ ok: true });
  });

  /**
   * Hand the card to Claude Code in a terminal: write the context file into the
   * worktree and answer with the command that opens a session on it.
   *
   * Refused while a run is going, because a Reeve run and a CLI session editing
   * the same tree at once is how work gets lost. Nothing is locked afterwards;
   * the event records the handoff, and the human decides what runs next.
   */
  routes.post('/:id/handoff', async (c) => {
    const cardId = c.req.param('id');
    const card = getCard(db, cardId);
    if (!card) return c.json({ error: 'not found' }, 404);
    const repo = repoFor(card.repoId);
    if (!repo) return c.json({ error: 'card has no repo', detail: 'a handoff needs a repo' }, 400);
    // `needsWorktree` is true for Done too, and Done has nothing left to hand over.
    if (card.stage === 'done' || !needsWorktree(card.stage)) {
      return c.json({ error: 'stage cannot be handed off', detail: card.stage }, 400);
    }
    // The row as well as the registry: a run is only registered once its
    // `prepare` is done, and Testing's takes a dev server boot and a round of
    // screenshots — long enough to hand off a tree it is about to edit.
    const latest = latestClaudeRunForStage(db, cardId, card.stage);
    if (
      runRegistry.all().some((r) => r.cardId === cardId && r.kind === 'claude') ||
      (latest && ['queued', 'running', 'stopping'].includes(latest.status))
    ) {
      return c.json({ error: 'a run is already active for this card' }, 409);
    }
    const health = await checkWorktree(repo.repoPath, card.worktreePath);
    if (health.state !== 'ok') {
      return c.json(
        { error: 'card has no usable worktree', detail: health.state === 'missing' ? health.reason : 'not created' },
        409,
      );
    }

    const handoff = writeHandoff(db, card, repo, health.path);
    insertCardEvent(db, {
      cardId, actor: 'human', kind: 'handed_off', stage: card.stage,
      meta: { path: handoff.path },
    });
    return c.json(handoff, 201);
  });

  /**
   * Open the card's plan for review in Crit. Finishing there sends the plan
   * back with the comments as notes, or approves it when there are none.
   *
   * Only a plan waiting for review, the same state the review buttons appear
   * in: a plan still being written, or one whose questions are unanswered, is
   * not ready to be judged. A second click answers with the review already
   * open rather than starting another.
   */
  routes.post('/:id/crit', async (c) => {
    const cardId = c.req.param('id');
    const card = getCard(db, cardId);
    if (!card) return c.json({ error: 'not found' }, 404);
    if (card.archivedAt) return c.json({ error: 'card is archived' }, 409);
    const repo = repoFor(card.repoId);
    if (!repo) return c.json({ error: 'card has no repo', detail: 'a plan review needs a repo' }, 400);
    if (card.stage !== 'planning') {
      return c.json({ error: 'only a plan can be reviewed in Crit', detail: card.stage }, 400);
    }
    const { activity, run } = cardActivity(db, card);
    if (!run || activity !== 'needs_review') {
      return c.json({ error: 'the plan is not waiting for review', detail: activity }, 409);
    }
    if (runRegistry.all().some((r) => r.cardId === cardId && r.kind === 'claude' && !r.outOfBand)) {
      return c.json({ error: 'a run is already active for this card' }, 409);
    }
    const health = await checkWorktree(repo.repoPath, card.worktreePath);
    if (health.state !== 'ok') {
      return c.json(
        { error: 'card has no usable worktree', detail: health.state === 'missing' ? health.reason : 'not created' },
        409,
      );
    }

    const review = await startCritReview(db, writer, card, health.path, run);
    if (!review.ok) return c.json({ error: review.error, detail: review.detail }, review.status);
    const body: CritReviewResponse = { runId: review.runId, url: review.url, reused: review.reused };
    return c.json(body, review.reused ? 200 : 201);
  });

  /** Run the repo's test command against the worktree. */
  routes.post('/:id/test', (c) => {
    const cardId = c.req.param('id');
    const card = getCard(db, cardId);
    if (!card) return c.json({ error: 'not found' }, 404);
    if (card.archivedAt) return c.json({ error: 'card is archived' }, 409);
    const repo = repoFor(card.repoId);
    if (!repo?.testCommand) return c.json({ error: 'repo has no test command' }, 400);
    if (!card.worktreePath) return c.json({ error: 'card has no worktree' }, 400);
    const handle = startShellRun({
      db, writer, cardId, stage: card.stage,
      command: repo.testCommand, cwd: card.worktreePath,
    });
    return c.json({ ok: true, runId: handle.runId }, 201);
  });

  return routes;
}

