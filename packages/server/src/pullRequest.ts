import { and, eq, isNull } from 'drizzle-orm';
import { config } from './config.js';
import type { Db } from './db/client.js';
import { archiveCard, cardsAwaitingMerge, insertCardEvent, mergedCardsDueForArchive } from './db/queries.js';
import { card as cardTable, type Card, type Repo } from './db/schema.js';
import {
  createPullRequest,
  findPullRequest,
  mergePullRequest,
  pullRequestState,
  pushBranch,
  type PullRequestState,
} from './git/github.js';
import { GitError, checkWorktree, commitsSince, isDirty } from './git/worktree.js';
import { runRegistry } from './runs/registry.js';

/**
 * Cards with a push under way. Two quick drags into Done, or a retry pressed
 * while the automatic attempt is still talking to GitHub, would otherwise
 * both find no pull request and both create one.
 */
const opening = new Set<string>();

export const isOpeningPr = (cardId: string) => opening.has(cardId);

/**
 * Cards whose branch is mid-merge while its conflicts are resolved. Kept here
 * beside `opening` because each has to refuse the other: a push in the middle
 * of a resolution would send GitHub half a merge. See resolveConflicts.ts.
 */
const resolving = new Set<string>();

export const isResolvingConflicts = (cardId: string) => resolving.has(cardId);

/** Taken synchronously, so two presses close together cannot both have it. */
export function claimResolving(cardId: string): boolean {
  if (resolving.has(cardId)) return false;
  resolving.add(cardId);
  return true;
}

export const releaseResolving = (cardId: string) => void resolving.delete(cardId);

/**
 * The pull request GitHub last called conflicting, by card. In memory like
 * `opening`, because GitHub works it out again on every sync, and keyed to the
 * URL so a card that has since opened a new pull request does not inherit the
 * old one's verdict.
 */
const conflicting = new Map<string, string>();

export const isPrConflicting = (card: Pick<Card, 'id' | 'prUrl'>) =>
  card.prUrl !== null && conflicting.get(card.id) === card.prUrl;

/** After a push, GitHub's last verdict is about a branch that no longer exists. */
export const forgetConflict = (cardId: string) => void conflicting.delete(cardId);

/**
 * `UNKNOWN` changes nothing. GitHub says it for a while after every push, and
 * reading it as "fine" would take the button away from a conflict still there.
 */
function noteMergeable(cardId: string, url: string, pr: PullRequestState): void {
  if (pr.state === 'OPEN' && pr.mergeable === 'CONFLICTING') conflicting.set(cardId, url);
  else if (pr.state !== 'OPEN' || pr.mergeable === 'MERGEABLE') conflicting.delete(cardId);
}

export type PullRequestResult =
  | { ok: true; url: string; number: number; reused: boolean }
  | { ok: false; status: 400 | 409 | 502; error: string; detail: string };

const reason = (e: unknown) => (e instanceof GitError ? e.stderr || e.message : String(e));

/**
 * Push a Done card's branch to `origin` and open a pull request for it against
 * the repo's default branch — or, if one is already open, leave it to pick
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
export async function openPullRequest(db: Db, card: Card, repo: Repo): Promise<PullRequestResult> {
  if (card.stage !== 'done') {
    return { ok: false, status: 400, error: 'only a Done card gets a pull request', detail: card.stage };
  }
  // Its pull request is history, so a push would restore the branch GitHub
  // deleted on merge and open a second one for work already landed.
  if (card.mergedAt) {
    return { ok: false, status: 409, error: 'already merged', detail: card.prUrl ?? `#${card.number}` };
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
  // Not written as `pr_failed`: nothing failed, and the resolution pushes on
  // its own once it is done.
  if (resolving.has(card.id)) {
    return { ok: false, status: 409, error: 'conflicts are being resolved', detail: 'the branch is mid-merge; it is pushed once the merge is done' };
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
    const health = await checkWorktree(repo.repoPath, worktreePath);
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

    const base = repo.defaultBranch;
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
 * silence — a Backlog idea dragged straight to Done is not a failure, and
 * nor is a merged card dragged back there. And nothing may escape: an
 * unhandled rejection here would take the server down.
 */
export function maybeOpenPullRequest(db: Db, card: Card, repo: Repo | undefined): void {
  if (!repo || card.kind === 'project' || card.mergedAt || !card.branchName || !card.worktreePath || !card.baseSha) return;
  openPullRequest(db, card, repo).catch((e) => {
    console.error(`[reeve] pull request for #${card.number} failed without a record: ${reason(e)}`);
  });
}

/** Cards with a merge under way, so two sweeps cannot both ask `gh` to land one. */
const landing = new Set<string>();

export type LandResult = { ok: true } | { ok: false; error: string; detail: string };

/**
 * Land the card's pull request on the default branch.
 *
 * Only SICKO MODE calls this. On the calm board a pull request is where Reeve
 * stops on purpose: the point of opening one is that a person reads it, and
 * merging it is their decision, taken on GitHub. SICKO MODE is the mode where
 * that is not true, so this exists there and nowhere else.
 *
 * It refuses exactly what opening one refuses, and it does not reach past the
 * repository's own rules: a branch that requires a review still requires one,
 * `gh` says no, and the card records why. Success is not written here either —
 * the existing merge sync is asked to look, so the card is marked from GitHub's
 * answer and by the same code path as a pull request somebody merged by hand.
 */
export async function landPullRequest(db: Db, card: Card, repo: Repo): Promise<LandResult> {
  if (card.mergedAt) return { ok: true };
  if (!card.prUrl) return { ok: false, error: 'nothing to merge', detail: 'the card has no pull request' };
  if (landing.has(card.id) || opening.has(card.id)) {
    return { ok: false, error: 'busy', detail: `#${card.number}` };
  }
  landing.add(card.id);
  try {
    await mergePullRequest(repo.repoPath, card.prUrl);
  } catch (e) {
    const detail = reason(e);
    insertCardEvent(db, {
      cardId: card.id, actor: 'claude', kind: 'pr_failed', stage: card.stage,
      body: `could not merge: ${detail}`, meta: { url: card.prUrl },
    });
    return { ok: false, error: 'could not merge the pull request', detail };
  } finally {
    landing.delete(card.id);
  }
  await syncMergedPullRequests(db);
  return { ok: true };
}

let syncing = false;

/**
 * Notice pull requests that were merged on GitHub, and mark their cards merged.
 *
 * Only `merged_at` is written. `merged_sha` means the card squash-landed and
 * its worktree is gone, and the Changes tab reads it from the local repo —
 * where GitHub's merge commit is not until someone fetches it. The sha goes on
 * the `merged` event instead. The worktree and branch are left alone: the
 * person may still be sitting in them.
 *
 * The same answer says whether GitHub could merge an open one as it stands,
 * which is what offers a Done card's conflicts for resolving.
 *
 * One card at a time, and one sync at a time, since each is a `gh` call and a
 * slow one must not stack up behind the next tick. A card that cannot be asked
 * about is skipped until the next sync rather than failing the rest.
 */
export async function syncMergedPullRequests(db: Db): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    for (const { card, repo } of cardsAwaitingMerge(db)) {
      // A push under way will write the card itself; the next sync can look.
      if (!card.prUrl || opening.has(card.id) || resolving.has(card.id)) continue;
      let pr: PullRequestState;
      try {
        pr = await pullRequestState(repo.repoPath, card.prUrl);
      } catch (e) {
        console.error(`[reeve] could not check pull request for #${card.number}: ${reason(e)}`);
        continue;
      }
      // Asked again: a push that started while `gh` answered makes the answer
      // about a branch that is about to change.
      if (!opening.has(card.id) && !resolving.has(card.id)) noteMergeable(card.id, card.prUrl, pr);
      if (pr.state !== 'MERGED') continue;

      const now = new Date();
      // Only if the card still points at the pull request that was asked
      // about: a push while `gh` answered may have opened a different one.
      const updated = db.update(cardTable)
        .set({ mergedAt: pr.mergedAt ?? now, updatedAt: now })
        .where(and(eq(cardTable.id, card.id), eq(cardTable.prUrl, card.prUrl), isNull(cardTable.mergedAt)))
        .run();
      if (updated.changes === 0) continue;
      insertCardEvent(db, {
        cardId: card.id, actor: 'human', kind: 'merged', stage: card.stage,
        meta: { url: card.prUrl, number: card.prNumber, sha: pr.mergeSha, into: pr.base || repo.defaultBranch },
      });
    }
  } finally {
    syncing = false;
  }
}

/**
 * Take cards off the board once they have been merged for a while. The
 * merge is the end of a card's life; the board is for what is still moving.
 *
 * A card with something still running is left for a later sweep, as the
 * archive route would refuse it: a Claude run or a dev server carrying on out
 * of sight. And a card is archived this way at most once, so one a person
 * restores from the Archive stays where they put it.
 */
export function archiveMergedCards(db: Db, now = new Date()): Card[] {
  const cutoff = new Date(now.getTime() - config.autoArchiveAfterMs);
  const running = new Set(runRegistry.all().map((r) => r.cardId));
  const archived: Card[] = [];
  for (const card of mergedCardsDueForArchive(db, cutoff)) {
    if (running.has(card.id)) continue;
    const done = archiveCard(db, card.id, { reason: 'merged' });
    if (done) archived.push(done);
  }
  return archived;
}
