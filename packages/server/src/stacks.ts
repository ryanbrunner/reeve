import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { dependenciesOf, getCard, hasImplementationRun, insertCardEvent, listRepos, liveStageRun, stillBlocking } from './db/queries.js';
import { card as cardTable, type Card, type Repo } from './db/schema.js';
import { fetchBranch, pushBranch, retargetPullRequest } from './git/github.js';
import { abortMerge, checkWorktree, isDirty, startMerge } from './git/worktree.js';
import { forgetMergeable, isMergingPr, isOpeningPr, isResolvingConflicts } from './pullRequest.js';
import { isStartingStage, setBaseSha } from './startStage.js';

/**
 * Stacked branches: a card that waits on another whose work has not merged
 * yet builds on that card's branch, rather than waiting for it to land.
 *
 * A project's tasks build on each other, and every one of them used to wait
 * for the one before it to be merged before it could even be planned. Now a
 * card whose one unfinished dependency has built work on a branch is cut from
 * that branch (its "stack parent") and works on top of it: Planning, In
 * Progress and Testing run as soon as the parent has been built. Its diff
 * counts from the parent's tip, so it shows only its own work, and a revision
 * of the parent is merged in at the card's next stage start.
 *
 * Landing keeps the order. The card may go to Release once the parent has a
 * pull request open, and its own pull request targets the parent's branch, so
 * it reads as its own change on GitHub. It may not merge until the parent
 * has. When the parent merges — squashed, as every pull request here is — the
 * merge sync brings the card onto the default branch (`restackChildren`):
 * merges `origin/<default>` into its branch, moves its base there, pushes, and
 * points its pull request at the default branch instead. A conflict there is
 * left for Resolve conflicts, against the default branch, like any other.
 *
 * Only one parent, in the same repo: a branch can be cut from one place. A
 * card waiting on two unmerged cards, or on one in another repo, waits as it
 * always did.
 */

/**
 * The dependency this card may build on now, or null: its only unfinished
 * one, a task in the same repo, built (an In Progress run succeeded) on a
 * branch that has not merged. `open` is the card's unfinished dependencies,
 * for a caller that has them already.
 */
export function stackParent(db: Db, card: Card, open = dependenciesOf(db, card.id).filter(stillBlocking)): Card | null {
  if (card.kind !== 'task' || open.length !== 1) return null;
  const parent = open[0]!;
  if (parent.kind !== 'task' || parent.repoId !== card.repoId || !parent.branchName || parent.mergedAt) return null;
  return hasImplementationRun(db, parent.id) ? parent : null;
}

/**
 * The card this one is stacked on and still building on: its parent, while
 * that has neither merged nor been taken off the board. Null once it has —
 * then the card is due to be moved onto the default branch.
 */
export function stackedOn(db: Db, card: Card): Card | null {
  if (!card.stackedOnId) return null;
  const parent = getCard(db, card.stackedOnId);
  if (!parent || parent.mergedAt || parent.archivedAt || !parent.branchName || parent.repoId !== card.repoId) return null;
  // Still a dependency: a person who removes the link has said this card no
  // longer waits on it, so it is moved onto the default branch like one
  // whose parent has landed, rather than left stacked on nothing.
  if (!dependenciesOf(db, card.id).some((d) => d.id === parent.id)) return null;
  return parent;
}

/**
 * Cards being moved onto the default branch right now. A stage start, a push,
 * a resolution and a merge all leave such a card alone until it is done:
 * each would otherwise work in the same tree mid-merge.
 */
const restacking = new Set<string>();
export const isRestacking = (cardId: string) => restacking.has(cardId);

/** The branch this card's work is based on and its pull request targets. */
export function baseBranchFor(db: Db, card: Card, repo: Repo): string {
  return stackedOn(db, card)?.branchName ?? repo.defaultBranch;
}

/** Branches a run on this card must never push to: the default, and the parent's. */
export function protectedBranches(db: Db, card: Card, repo: Repo): string[] {
  const parent = stackedOn(db, card);
  return parent?.branchName ? [repo.defaultBranch, parent.branchName] : [repo.defaultBranch];
}

export function setStackedOn(db: Db, card: Card, parentId: string | null): void {
  if (card.stackedOnId === parentId) return;
  db.update(cardTable).set({ stackedOnId: parentId, updatedAt: new Date() }).where(eq(cardTable.id, card.id)).run();
}

export type Unstack =
  | { state: 'moved'; baseSha: string }
  | { state: 'conflicted'; conflicts: string[] }
  | { state: 'waiting'; why: string };

/**
 * Move a stacked card whose parent has merged (or been taken off the board)
 * onto the default branch. `waiting` leaves it stacked to try again: a fetch
 * that failed, or uncommitted work a merge could tangle with. Anything else
 * ends the stack — the pull request points at the default branch from here on
 * — and a conflict is left in the branch's history for Resolve conflicts.
 */
export async function unstack(db: Db, card: Card, repo: Repo): Promise<Unstack> {
  if (restacking.has(card.id)) return { state: 'waiting', why: 'it is already being moved' };
  restacking.add(card.id);
  try {
    return await unstackLocked(db, card, repo);
  } finally {
    restacking.delete(card.id);
  }
}

async function unstackLocked(db: Db, card: Card, repo: Repo): Promise<Unstack> {
  const parent = card.stackedOnId ? getCard(db, card.stackedOnId) : undefined;
  const base = repo.defaultBranch;
  const who = parent ? `#${parent.number}` : 'the card it was built on';
  const why = parent?.mergedAt ? `${who} has merged`
    : parent?.archivedAt ? `${who} was taken off the board without merging`
    : `this card no longer waits on ${who}`;

  const health = card.worktreePath ? await checkWorktree(repo.repoPath, card.worktreePath) : null;
  if (health?.state !== 'ok') {
    // No tree to merge in: the next one is cut from the default branch. The
    // stack ends only once its pull request, if any, points there too.
    const retargeted = await retarget(db, card, repo, base);
    if (retargeted !== true) return { state: 'waiting', why: retargeted };
    setStackedOn(db, card, null);
    return { state: 'moved', baseSha: card.baseSha ?? '' };
  }
  if (await isDirty(health.path, { ignore: ['.reeve'] })) return { state: 'waiting', why: 'the worktree has uncommitted changes' };

  let fetched: string;
  try {
    fetched = await fetchBranch(repo.repoPath, base);
  } catch (e) {
    return { state: 'waiting', why: `fetching origin/${base} failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  let merge: Awaited<ReturnType<typeof startMerge>>;
  try {
    merge = await startMerge(health.path, `origin/${base}`);
  } catch (e) {
    return { state: 'waiting', why: `merging origin/${base} failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!merge.clean) {
    try {
      await abortMerge(health.path);
    } catch (e) {
      return { state: 'waiting', why: `merging origin/${base} conflicted, and the merge could not be aborted: ${e instanceof Error ? e.message : String(e)}` };
    }
    // Pointed at the default branch even so, where Resolve conflicts takes
    // it up; until that has happened the card stays stacked, and unmergeable.
    const retargeted = await retarget(db, card, repo, base);
    if (retargeted !== true) return { state: 'waiting', why: retargeted };
    setStackedOn(db, card, null);
    forgetMergeable(card.id);
    insertCardEvent(db, {
      cardId: card.id, actor: 'human', kind: 'note', stage: card.stage,
      body: `${why}, so this card now builds on ${base}, but merging origin/${base} into its branch conflicted in ` +
        `${merge.conflicts.join(', ')}. They are left for Resolve conflicts once it is in Release.` +
        (parent?.mergedAt ? '' : ` Its branch still carries ${who}'s commits, which go out in this card's pull request.`),
    });
    return { state: 'conflicted', conflicts: merge.conflicts };
  }

  setBaseSha(db, card, fetched);
  // Pushed and pointed at the default branch before the stack ends: until
  // then the card stays unmergeable, since its pull request would still land
  // on the parent's branch. Either failing leaves it to the next sync, which
  // finds main already merged in and only has these two to do again.
  if (card.prUrl) {
    try {
      await pushBranch(health.path, card.branchName!);
    } catch (e) {
      return { state: 'waiting', why: `pushing its branch failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const retargeted = await retarget(db, card, repo, base);
  if (retargeted !== true) return { state: 'waiting', why: retargeted };
  setStackedOn(db, card, null);
  // GitHub's last word was about merging into the parent's branch.
  forgetMergeable(card.id);
  insertCardEvent(db, {
    cardId: card.id, actor: 'human', kind: 'note', stage: card.stage,
    body: `${why}, so this card now builds on ${base}: merged origin/${base} (${fetched.slice(0, 7)}) into its branch` +
      `${card.prUrl ? ` and pointed its pull request at ${base}` : ''}.` +
      (parent?.mergedAt ? '' : ` Its branch still carries ${who}'s commits, which go out in this card's pull request.`),
  });
  return { state: 'moved', baseSha: fetched };
}

/** Its pull request at `base`, if it has one: true, or why it could not be. */
async function retarget(db: Db, card: Card, repo: Repo, base: string): Promise<true | string> {
  const fresh = getCard(db, card.id);
  if (!fresh?.prUrl || fresh.mergedAt) return true;
  try {
    await retargetPullRequest(repo.repoPath, fresh.prUrl, base);
    return true;
  } catch (e) {
    return `pointing its pull request at ${base} failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Cards that waited until now, and why, so a `waiting` is said once rather than every sync. */
const told = new Map<string, string>();

/**
 * Every stacked card whose parent has landed (or left), moved onto the default
 * branch: run by the merge sync, after it has noticed merges. A card with a
 * run, a start, a push, a resolution or a merge under way is left for the
 * next sync, which is a minute away.
 */
export async function restackChildren(db: Db): Promise<void> {
  const stacked = db.select().from(cardTable).where(and(isNotNull(cardTable.stackedOnId), isNull(cardTable.archivedAt))).all();
  for (const card of stacked) {
    if (stackedOn(db, card)) continue;
    if (liveStageRun(db, card.id) || isStartingStage(card.id)) continue;
    if (isOpeningPr(card.id) || isResolvingConflicts(card.id) || isMergingPr(card.id)) continue;
    const repo = listRepos(db).find((r) => r.id === card.repoId);
    if (!repo) continue;
    try {
      const result = await unstack(db, card, repo);
      if (result.state === 'waiting') {
        if (told.get(card.id) !== result.why) {
          told.set(card.id, result.why);
          insertCardEvent(db, {
            cardId: card.id, actor: 'human', kind: 'note', stage: card.stage,
            body: `The card this one builds on has landed, but it stays on that card's branch for now, because ${result.why}. It moves onto ${repo.defaultBranch} once that is cleared.`,
          });
        }
      } else {
        told.delete(card.id);
      }
    } catch (e) {
      console.error(`[reeve] could not move #${card.number} onto ${repo.defaultBranch}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
