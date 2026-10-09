import { and, eq, isNull } from 'drizzle-orm';
import { PASTED_IMAGE } from './assets/store.js';
import { config } from './config.js';
import type { Db } from './db/client.js';
import {
  archiveCard,
  archivedMergedWorktrees,
  cardsAwaitingMerge,
  insertCardEvent,
  listRepos,
  mergedCardsDueForArchive,
} from './db/queries.js';
import { card as cardTable, type Card, type Repo } from './db/schema.js';
import {
  createPullRequest,
  fetchBranch,
  findPullRequest,
  mergePullRequest,
  pullRequestState,
  pushBranch,
  type PullRequestState,
} from './git/github.js';
import { GitError, checkWorktree, commitsSince, fastForwardBranch, isDirty } from './git/worktree.js';
import type { EventWriter } from './runs/events.js';
import { runRegistry } from './runs/registry.js';
import { removeCardWorktree } from './startStage.js';

/**
 * Cards with a push under way. Two quick drags into Release, or a retry pressed
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
 * Cards whose pull request `gh` is merging right now: two presses of Merge, or
 * a press while VIBES MODE's sweep lands the same one. Refused by a push and a
 * resolution as well, since either would change the branch mid-merge.
 */
const landing = new Set<string>();

export const isMergingPr = (cardId: string) => landing.has(cardId);

/**
 * The pull request GitHub last called conflicting, by card. In memory like
 * `opening`, because GitHub works it out again on every sync, and keyed to the
 * URL so a card that has since opened a new pull request does not inherit the
 * old one's verdict.
 */
const conflicting = new Map<string, string>();

export const isPrConflicting = (card: Pick<Card, 'id' | 'prUrl'>) =>
  card.prUrl !== null && conflicting.get(card.id) === card.prUrl;

/**
 * The pull request GitHub last called mergeable, by card: the other half of
 * the same verdict, and what offers the Merge button. Kept apart from
 * `conflicting` rather than read as its absence, because `UNKNOWN` is neither
 * and a push leaves this one stale where it leaves a conflict standing.
 */
const mergeable = new Map<string, string>();

export const isPrMergeable = (card: Pick<Card, 'id' | 'prUrl'>) =>
  card.prUrl !== null && mergeable.get(card.id) === card.prUrl;

/** After a push, GitHub's last verdict is about a branch that no longer exists. */
export function forgetConflict(cardId: string): void {
  conflicting.delete(cardId);
  mergeable.delete(cardId);
}

/**
 * `UNKNOWN` leaves a conflict standing: GitHub says it for a while after every
 * push, and reading it as "fine" would take the button away from a conflict
 * still there. It does not leave a card mergeable, though; a merge offered on
 * a verdict GitHub has not reached is a merge that may not be clean.
 */
function noteMergeable(cardId: string, url: string, pr: PullRequestState): void {
  if (pr.state === 'OPEN' && pr.mergeable === 'CONFLICTING') conflicting.set(cardId, url);
  else if (pr.state !== 'OPEN' || pr.mergeable === 'MERGEABLE') conflicting.delete(cardId);
  if (pr.state === 'OPEN' && pr.mergeable === 'MERGEABLE') mergeable.set(cardId, url);
  else mergeable.delete(cardId);
}

export type PullRequestResult =
  | { ok: true; url: string; number: number; reused: boolean }
  | { ok: false; status: 400 | 409 | 502; error: string; detail: string };

const reason = (e: unknown) => (e instanceof GitError ? e.stderr || e.message : String(e));

/**
 * The card's body as a pull request description. A pasted image is linked by
 * its route on this server, which GitHub cannot reach and would show as a
 * broken picture, so each is left as its alt text instead: the reader learns
 * there was one, and the card still has it. Not uploaded, because `gh` has no
 * way to attach an image to a pull request, and not dropped, because a
 * sentence that says "like this:" should not then point at nothing.
 *
 * Parentheses rather than emphasis, since the alt may be a file name, and a
 * `_` or `*` in one would unbalance it.
 */
const prDescription = (body: string) =>
  body.trim().replace(PASTED_IMAGE, (_, alt: string) => (alt.trim() ? `(image: ${alt.trim()})` : '(image)'));

/**
 * Push a Release card's branch to `origin` and open a pull request for it against
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
  if (card.stage !== 'release') {
    return { ok: false, status: 400, error: 'only a Release card gets a pull request', detail: card.stage };
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
  if (landing.has(card.id)) {
    return { ok: false, status: 409, error: 'the pull request is being merged', detail: card.prUrl ?? `#${card.number}` };
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
    // Whatever went out may not merge as cleanly as what GitHub last saw, so
    // Merge waits for the next sync to say. A conflict is left standing: new
    // commits rarely settle one, and its button is how it gets settled.
    mergeable.delete(card.id);

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
        body: [prDescription(card.body), `Reeve #${card.number}`].filter(Boolean).join('\n\n'),
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
 * The automatic attempt, for a card that has just entered Release. The routes
 * that move cards call this without awaiting it: a push and a `gh` call take
 * seconds, and a drag should not hang on them. The outcome lands on the card,
 * where the board's poll picks it up.
 *
 * A card that never had a worktree has nothing to push and is passed over in
 * silence — a Backlog idea dragged straight to Release is not a failure, and
 * nor is a merged card dragged back there. And nothing may escape: an
 * unhandled rejection here would take the server down.
 */
export function maybeOpenPullRequest(db: Db, card: Card, repo: Repo | undefined): void {
  if (!repo || card.kind === 'project' || card.mergedAt || !card.branchName || !card.worktreePath || !card.baseSha) return;
  openPullRequest(db, card, repo).catch((e) => {
    console.error(`[reeve] pull request for #${card.number} failed without a record: ${reason(e)}`);
  });
}

/**
 * A card arriving in Release: its pull request opened, so the person has
 * something to read before they ask Claude for anything. It no longer starts
 * the Release conversation itself — nothing does, on arrival — so a card
 * dragged or approved into Release reads idle until a person runs it or
 * sends it a message, or VIBES MODE acts. The same attempt as
 * `maybeOpenPullRequest`, under the name the routes that move a card into
 * Release call it by.
 */
export const enterRelease = maybeOpenPullRequest;

/**
 * Whether the board offers to merge this card's pull request: a Release card's
 * open one, which GitHub has said merges cleanly. The Merge button is drawn
 * from this and the route refuses by it, so a page left open since the last
 * verdict cannot merge what the board has stopped offering.
 */
export const canMergePr = (card: Card) =>
  card.stage === 'release' && card.prUrl !== null && card.mergedAt === null && isPrMergeable(card);

export type LandResult =
  | { ok: true; merged: boolean }
  | { ok: false; status: 400 | 409 | 502; error: string; detail: string };

/**
 * Land the card's pull request on the default branch.
 *
 * Two callers. A person pressing Merge on a Release card, having read the pull
 * request or decided not to; and VIBES MODE, which is the mode where nobody
 * reads it. Either way the decision is a human's — made on the button, or made
 * once by switching VIBES MODE on — and never Claude's own.
 *
 * It refuses exactly what opening one refuses, and it does not reach past the
 * repository's own rules: a branch that requires a review still requires one,
 * `gh` says no, and the card records why as `merge_failed`. Success is not
 * written here either — GitHub is asked where the pull request has got to, so
 * the card is marked from its answer and by the same code path as a pull
 * request somebody merged on GitHub. `merged` is false if that answer did not
 * come; the next sync marks it.
 *
 * GitHub's mergeable verdict is the route's to check, not this: VIBES MODE
 * lands a pull request as soon as it has one, and lets `gh` refuse.
 */
export async function landPullRequest(db: Db, card: Card, repo: Repo, actor: 'human' | 'claude'): Promise<LandResult> {
  if (card.mergedAt) return { ok: true, merged: true };
  if (card.stage !== 'release') return { ok: false, status: 400, error: 'only a Release card’s pull request is merged', detail: card.stage };
  const url = card.prUrl;
  if (!url) return { ok: false, status: 400, error: 'nothing to merge', detail: 'the card has no pull request' };
  // Taken before the first await, like `opening`.
  if (landing.has(card.id)) return { ok: false, status: 409, error: 'already merging', detail: url };
  if (opening.has(card.id)) return { ok: false, status: 409, error: 'a push to the pull request is under way', detail: url };
  if (resolving.has(card.id)) return { ok: false, status: 409, error: 'conflicts are being resolved', detail: url };
  landing.add(card.id);
  try {
    await mergePullRequest(repo.repoPath, url);
  } catch (e) {
    const detail = reason(e);
    insertCardEvent(db, {
      cardId: card.id, actor, kind: 'merge_failed', stage: card.stage,
      body: detail, meta: { url, number: card.prNumber },
    });
    return { ok: false, status: 502, error: 'could not merge the pull request', detail };
  } finally {
    landing.delete(card.id);
  }
  // Merged, so GitHub's verdict is history, and the button goes with it.
  mergeable.delete(card.id);

  // This card alone, and now. The full sync would do it, but returns at once
  // if one is already under way — one that may have asked about this pull
  // request before it merged, leaving the card neither mergeable nor merged
  // until the next tick.
  let into: string | null = null;
  try {
    into = await syncPullRequest(db, card, repo, url);
  } catch (e) {
    console.error(`[reeve] could not check pull request for #${card.number} after merging it: ${reason(e)}`);
  }
  // Marked merged here, so the full sync below will not see this card land,
  // and would not fast-forward the default branch for it. That is done first,
  // so the two do not fetch and move the same branch at once; it logs rather
  // than throws.
  const first = keepsDefaultBranch(repo, into) ? syncDefaultBranch(repo) : Promise.resolve();
  // And the rest, for every card's count of how far behind the base it is,
  // which has just moved. Not awaited: a person pressed a button.
  first
    .then(() => syncMergedPullRequests(db))
    .catch((e) => console.error(`[reeve] merge sync failed: ${reason(e)}`));
  return { ok: true, merged: into !== null };
}

/** A push, a resolution or a merge will change the branch or the pull request. */
const busy = (cardId: string) => opening.has(cardId) || resolving.has(cardId) || landing.has(cardId);

/**
 * Ask GitHub about one card's pull request: note whether it can merge, and
 * mark the card merged if it has. Once the card is marked merged here, the
 * branch it landed on, so the caller can bring the repo's own copy of it up to
 * date; otherwise null.
 */
async function syncPullRequest(db: Db, card: Card, repo: Repo, url: string): Promise<string | null> {
  const pr = await pullRequestState(repo.repoPath, url);
  // Asked again: a push that started while `gh` answered makes the answer
  // about a branch that is about to change.
  if (!busy(card.id)) noteMergeable(card.id, url, pr);
  if (pr.state !== 'MERGED') return null;

  const now = new Date();
  // Only if the card still points at the pull request that was asked
  // about: a push while `gh` answered may have opened a different one.
  const updated = db.update(cardTable)
    .set({ mergedAt: pr.mergedAt ?? now, updatedAt: now })
    .where(and(eq(cardTable.id, card.id), eq(cardTable.prUrl, url), isNull(cardTable.mergedAt)))
    .run();
  if (updated.changes === 0) return null;
  const into = pr.base || repo.defaultBranch;
  insertCardEvent(db, {
    cardId: card.id, actor: 'human', kind: 'merged', stage: card.stage,
    meta: { url, number: card.prNumber, sha: pr.mergeSha, into },
  });
  return into;
}

/**
 * Whether a card that just landed on `into` should fast-forward its repo's
 * default branch: the repo asked for it, and the pull request was not
 * retargeted at another branch, which would not have landed on this one.
 */
const keepsDefaultBranch = (repo: Repo, into: string | null) =>
  repo.syncDefaultBranch && into !== null && into === repo.defaultBranch;

let syncing = false;

/**
 * Notice pull requests that were merged on GitHub, and mark their cards merged.
 *
 * Only `merged_at` is written. `merged_sha` means the card squash-landed and
 * its worktree is gone, and the Changes tab reads it from the local repo —
 * where GitHub's merge commit is not until someone fetches it. The sha goes on
 * the `merged` event instead. The worktree is left alone, since the person
 * may still be sitting in it: it goes once the card is archived, by
 * `cleanUpArchivedWorktrees`, and the branch stays for good.
 *
 * The same answer says whether GitHub could merge an open one as it stands,
 * which is what offers a Release card's conflicts for resolving, or its Merge
 * button.
 *
 * One card at a time, and one sync at a time, since each is a `gh` call and a
 * slow one must not stack up behind the next tick. A card that cannot be asked
 * about is skipped until the next sync rather than failing the rest.
 *
 * First, each repo's base is fetched, so every card's "main · N behind" counts
 * against what has landed — including merges made outside Reeve, which no card
 * here is waiting on. A repo that cannot be fetched is skipped the same way.
 *
 * Last, a repo that asked for it has its own default branch brought up to
 * date, if one of its cards landed on it in this sync.
 */
export async function syncMergedPullRequests(db: Db): Promise<void> {
  if (syncing) return;
  syncing = true;
  // By id, so three cards landing in one sync fast-forward their repo once.
  const landedOnDefault = new Map<string, Repo>();
  try {
    for (const repo of listRepos(db)) {
      try {
        await fetchBranch(repo.repoPath, repo.defaultBranch);
      } catch (e) {
        console.error(`[reeve] could not fetch ${repo.defaultBranch} for ${repo.name}: ${reason(e)}`);
      }
    }
    for (const { card, repo } of cardsAwaitingMerge(db)) {
      // A push or a merge under way will write the card itself; the next sync can look.
      if (!card.prUrl || busy(card.id)) continue;
      let into: string | null = null;
      try {
        into = await syncPullRequest(db, card, repo, card.prUrl);
      } catch (e) {
        console.error(`[reeve] could not check pull request for #${card.number}: ${reason(e)}`);
      }
      if (keepsDefaultBranch(repo, into)) landedOnDefault.set(repo.id, repo);
    }
    for (const repo of landedOnDefault.values()) await syncDefaultBranch(repo);
  } finally {
    syncing = false;
  }
}

/**
 * Fast-forward the repo's own default branch to what `origin` has now, for a
 * repo that asked to be kept up to date when its cards merge.
 *
 * Fetched again first: the fetch at the top of the sync can predate the merge
 * that was just noticed. A branch with commits of the person's own that
 * `origin` lacks is theirs to reconcile, and is left as it is. Failures go to
 * the log like a failed fetch, rather than onto a card: the checkout is the
 * repo's, not any one card's, and the next merge tries again.
 */
async function syncDefaultBranch(repo: Repo): Promise<void> {
  const branch = repo.defaultBranch;
  try {
    await fetchBranch(repo.repoPath, branch);
    if ((await fastForwardBranch(repo.repoPath, branch)) === 'diverged') {
      console.error(`[reeve] left ${branch} alone in ${repo.name}: it has commits origin does not`);
    }
  } catch (e) {
    console.error(`[reeve] could not bring ${branch} up to date in ${repo.name}: ${reason(e)}`);
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

let cleaning = false;
/** Asked for while a pass was under way, which may have read the cards too early. */
let cleanAgain = false;

/**
 * Delete the worktrees of merged cards once they are archived, by hand or by
 * the sweep above. Merged is when the work has landed; archived is when a
 * person, or ten quiet minutes, says nobody is sitting in the tree any more.
 * Until both, every checkout stayed on disk for good, `node_modules` and all.
 *
 * Always forced, so anything left uncommitted goes with it. The event says so
 * when it happens, and the branch is kept, so every commit is still there and
 * the Diff tab reads from it.
 *
 * One card and one pass at a time, since a teardown command can take a while.
 * A call made during a pass runs another once it is done rather than being
 * dropped, so a hand archive is not left waiting a whole tick. A card with
 * anything running, or whose conflicts are being resolved, is left for a later
 * pass, although an archived card should have neither. So is one whose removal
 * failed, and nothing that goes wrong with one card stops the rest.
 */
export async function cleanUpArchivedWorktrees(db: Db, writer: EventWriter): Promise<void> {
  if (cleaning) {
    cleanAgain = true;
    return;
  }
  cleaning = true;
  const inUse = (cardId: string) => busy(cardId) || runRegistry.all().some((r) => r.cardId === cardId);
  try {
    do {
      cleanAgain = false;
      for (const { card, repo } of archivedMergedWorktrees(db)) {
        if (inUse(card.id)) continue;
        try {
          await removeCardWorktree(db, writer, card, repo, {
            reason: 'archived',
            // A person may have restored it while its teardown ran.
            stillWanted: (fresh) => fresh.archivedAt !== null && !inUse(fresh.id),
          });
        } catch (e) {
          console.error(`[reeve] could not remove the worktree of #${card.number}: ${reason(e)}`);
        }
      }
    } while (cleanAgain);
  } finally {
    cleaning = false;
  }
}
