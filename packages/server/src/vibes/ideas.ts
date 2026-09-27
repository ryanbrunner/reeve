import type { Db } from '../db/client.js';
import {
  getSettings,
  hadTaskRun,
  latestIntoDone,
  listRepos,
  liveTaskRunInRepo,
  openCardsInRepo,
} from '../db/queries.js';
import type { Card, Repo } from '../db/schema.js';
import { checkWorktree } from '../git/worktree.js';
import { startClaudeRun } from '../runs/claude.js';
import type { EventWriter } from '../runs/events.js';
import { runRegistry } from '../runs/registry.js';
import { ideasTask } from '../stages/ideas.js';

/**
 * VIBES MODE deciding what to build next, once a repo has nothing left to do.
 *
 * Without this the switch runs a board down to empty and stops, waiting for a
 * person to think of something — the one human step it had left. With it, the
 * last card to finish in a repo is asked what should follow it, and the answer
 * lands in Backlog, where the sweep starts it like any card a person typed.
 *
 * The board's switch only. A card in VIBES MODE on its own was promised one
 * card taken to a merged pull request, and a chain of cards thinking of more
 * cards, with no HUD to count them and no overlay that said it would, would be
 * breaking that promise.
 *
 * A statement about the board as it is now, like every rule in the sweep, so
 * that the cap being full or the switch going off simply means it happens on a
 * later pass or not at all.
 */

/**
 * The card a repo should have its next ideas after, or null while it should
 * not have any: while it still has work open, or is already thinking.
 *
 * Only the card that last arrived in Done since the switch went on, and only
 * once. Not "any finished card without ideas yet", which would work back
 * through the repo's whole history as each newest card was archived, and a
 * run for every card anyone ever finished is not what anyone flipped the
 * switch for. So a repo that has finished nothing since then has no ideas, and
 * one whose ideas came to nothing — the run failed, or thought of nothing
 * worth doing — stays empty until something else in it finishes.
 */
export function ideaSource(db: Db, repo: Repo, since: Date): Card | null {
  if (repo.archivedAt) return null;
  if (openCardsInRepo(db, repo.id).length > 0) return null;
  if (liveTaskRunInRepo(db, repo.id, ideasTask.id)) return null;
  const last = latestIntoDone(db, repo.id, since);
  if (!last || hadTaskRun(db, last.id, ideasTask.id)) return null;
  return last;
}

/** Start the ideas for every repo that has run dry, as far as the concurrency cap allows. */
export async function thinkOfIdeas(db: Db, writer: EventWriter): Promise<void> {
  for (const repo of listRepos(db)) {
    const since = getSettings(db).vibesSince;
    if (since === null) return;
    const source = ideaSource(db, repo, new Date(since));
    if (!source) continue;

    // Its own worktree if that is still there, since it holds the work that
    // just finished; the repo's checkout if not, which a card merged and
    // archived no longer has.
    const health = await checkWorktree(repo.repoPath, source.worktreePath);
    const cwd = health.state === 'ok' ? health.path : repo.repoPath;

    // Everything read again after the last await, nothing awaited between here
    // and `startClaudeRun` writing its row: the switch may have gone off, a
    // person may have added a card, and the cap is still the cap.
    const now = getSettings(db);
    if (now.vibesSince === null) return;
    if (runRegistry.countByKind('claude') >= now.maxConcurrentRuns) return;
    if (ideaSource(db, repo, new Date(now.vibesSince))?.id !== source.id) continue;
    startClaudeRun({
      db, writer, card: source, repo,
      stage: ideasTask as never,
      runStage: source.stage,
      worktreePath: cwd,
    });
  }
}
