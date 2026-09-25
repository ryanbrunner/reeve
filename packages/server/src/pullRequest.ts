import { eq } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { insertCardEvent } from './db/queries.js';
import { card as cardTable, type Card, type Project } from './db/schema.js';
import { createPullRequest, findPullRequest, pushBranch } from './git/github.js';
import { GitError, checkWorktree, commitsSince, isDirty } from './git/worktree.js';

/**
 * Cards with a push under way. Two quick drags into Done, or a retry pressed
 * while the automatic attempt is still talking to GitHub, would otherwise
 * both find no pull request and both create one.
 */
const opening = new Set<string>();

export const isOpeningPr = (cardId: string) => opening.has(cardId);

export type PullRequestResult =
  | { ok: true; url: string; number: number; reused: boolean }
  | { ok: false; status: 400 | 409 | 502; error: string; detail: string };

const reason = (e: unknown) => (e instanceof GitError ? e.stderr || e.message : String(e));

/**
 * Push a Done card's branch to `origin` and open a pull request for it against
 * the project's default branch — or, if one is already open, leave it to pick
 * up the push. Nothing is merged and nothing is torn down: review comments may
 * yet want more commits, and they go in the same worktree.
 *
 * The first thing Reeve does that cannot be taken back from inside the app,
 * so it refuses what the merge it replaced refused: a card with nothing
 * committed, or with work left uncommitted that a pull request would quietly
 * leave out. Every refusal and failure past the preconditions is written to
 * the card as `pr_failed`, because the automatic attempt has nobody waiting on
 * a response to read it in.
 */
export async function openPullRequest(db: Db, card: Card, project: Project): Promise<PullRequestResult> {
  if (card.stage !== 'done') {
    return { ok: false, status: 400, error: 'only a Done card gets a pull request', detail: card.stage };
  }
  const { branchName: branch, worktreePath, baseSha } = card;
  if (!branch || !worktreePath || !baseSha) {
    return { ok: false, status: 400, error: 'nothing to push', detail: 'the card has no worktree' };
  }

  // Taken before the first await, so no second attempt can slip in between
  // looking for a pull request and creating one.
  if (opening.has(card.id)) {
    return { ok: false, status: 409, error: 'a pull request is already being opened', detail: `#${card.number}` };
  }
  opening.add(card.id);

  const failed = (status: 409 | 502, error: string, detail: string): PullRequestResult => {
    insertCardEvent(db, {
      cardId: card.id, actor: 'human', kind: 'pr_failed', stage: card.stage,
      body: `${error}: ${detail}`, meta: { branch },
    });
    return { ok: false, status, error, detail };
  };

  try {
    const health = await checkWorktree(project.repoPath, worktreePath);
    if (health.state !== 'ok') {
      return failed(409, 'worktree missing', health.state === 'missing' ? health.reason : worktreePath);
    }
    if ((await commitsSince(health.path, baseSha)).length === 0) {
      return failed(409, 'nothing to push', 'the card has no commits on its branch');
    }
    // `.reeve/` is where every stage leaves its record, untracked. It is not
    // work, and counting it would refuse every card there is.
    if (await isDirty(health.path, { ignore: ['.reeve'] })) {
      return failed(409, 'the card has uncommitted changes', 'only commits are pushed — commit or discard them in the worktree first');
    }

    try {
      await pushBranch(health.path, branch);
    } catch (e) {
      return failed(502, 'push to origin failed', reason(e));
    }

    const base = project.defaultBranch;
    let pr: { url: string; number: number };
    let reused: boolean;
    try {
      const existing = await findPullRequest(health.path, branch);
      reused = existing !== null;
      pr = existing ?? await createPullRequest({
        worktreePath: health.path,
        branch,
        base,
        title: card.title,
        body: [card.body.trim(), `Reeve #${card.number}`].filter(Boolean).join('\n\n'),
      });
    } catch (e) {
      return failed(502, 'could not open the pull request', reason(e));
    }

    const now = new Date();
    db.update(cardTable)
      .set({
        prUrl: pr.url,
        prNumber: pr.number,
        // A push to a pull request already on record is not a new opening.
        prOpenedAt: card.prUrl === pr.url && card.prOpenedAt ? card.prOpenedAt : now,
        updatedAt: now,
      })
      .where(eq(cardTable.id, card.id))
      .run();
    insertCardEvent(db, {
      cardId: card.id, actor: 'human', kind: 'pr_opened', stage: card.stage,
      meta: { url: pr.url, number: pr.number, branch, into: base, reused },
    });
    return { ok: true, url: pr.url, number: pr.number, reused };
  } catch (e) {
    return failed(502, 'could not open the pull request', reason(e));
  } finally {
    opening.delete(card.id);
  }
}

/**
 * The automatic attempt, for a card that has just entered Done. The routes
 * that move cards call this without awaiting it: a push and a `gh` call take
 * seconds, and a drag should not hang on them. The outcome lands on the card,
 * where the board's poll picks it up.
 *
 * A card that never had a worktree has nothing to push and is passed over in
 * silence — a Backlog idea dragged straight to Done is not a failure. And
 * nothing may escape: an unhandled rejection here would take the server down.
 */
export function maybeOpenPullRequest(db: Db, card: Card, project: Project | undefined): void {
  if (!project || !card.branchName || !card.worktreePath || !card.baseSha) return;
  openPullRequest(db, card, project).catch((e) => {
    console.error(`[reeve] pull request for #${card.number} failed without a record: ${reason(e)}`);
  });
}
