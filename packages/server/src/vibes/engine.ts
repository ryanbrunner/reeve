import { canStartRun, isPlaceholderCard, isRunnable, nextStage, type Stage } from '@reeve/shared';
import { recordAnswer } from '../answers.js';
import { blockedMove } from '../blockers.js';
import { cardActivity, entryRefusal } from '../board.js';
import { isHeld } from '../cardHold.js';
import type { Db } from '../db/client.js';
import {
  boardCards,
  cardsInStage,
  getCard,
  getSettings,
  inVibes,
  listRepos,
  moveCard,
  questionsForRun,
  vibesCards,
} from '../db/queries.js';
import type { Card, Question, Repo, Run } from '../db/schema.js';
import { isOpeningPr, isPrConflicting, isResolvingConflicts, landPullRequest, maybeOpenPullRequest } from '../pullRequest.js';
import { resolveConflicts } from '../resolveConflicts.js';
import { approveStage } from '../review.js';
import type { EventWriter } from '../runs/events.js';
import { isStartingStage, maybeStartStage, startStage } from '../startStage.js';
import { thinkOfIdeas } from './ideas.js';

/**
 * VIBES MODE, doing the things a person would otherwise have to.
 *
 * A sweep rather than a set of hooks, and that is the whole design. Hanging
 * "approve when a run succeeds" and "start when a card lands" off the moments
 * they describe looks tidier and is wrong here: `maybeStartStage` gives up
 * quietly when the concurrency cap is full, and on the calm board that is
 * correct, because a person is watching and the Run button is right there. With
 * nobody watching, a card refused once would sit in its column for ever. A
 * periodic pass over every card, where each rule is a statement about a card's
 * CURRENT state rather than about an event, retries the cap, the worktree that
 * was not ready and the `gh` call that timed out without one line of code
 * knowing that is what it is doing.
 *
 * Exactly the eight things the arming overlay promises, and nothing else — the
 * last of them, deciding what to build once a repo runs dry, in `ideas.ts`.
 * Reeve's own human-in-the-loop gates come off; the stages' tool permissions, the
 * concurrency cap and the repository's branch protection do not, because none
 * of those is a human in the loop — they are limits on what a run may do, and
 * taking the person out of the loop is not a reason to widen them. Nor do a
 * card's dependencies, for the same reason: see `blockers.ts`.
 *
 * A card can also be put in VIBES MODE on its own, and so can a project, which
 * puts every task in its lane there with it. With the board's switch off the
 * sweep looks at those cards and no others, and does the same six things to
 * each — landing its pull request and resolving its conflicts included —
 * while the rest of the board waits for a person as usual. The project itself
 * is never swept: it is a lane, not a piece of work. With the board's switch
 * on, every card goes whatever its flag or its project's says.
 */

/** What the review gate is told, and what the card's history will say for ever. */
const APPROVAL = 'Approved by VIBES MODE. Nobody read this.';

/**
 * What a question gets when Claude asked one and there is no one to ask.
 *
 * Its own first suggestion where it made one — which is as close to "Claude
 * answered its own question" as this can honestly get — and otherwise an
 * instruction to decide and say what it decided, so the choice is at least on
 * the record.
 */
const NO_ONE_HOME =
  'There is nobody to ask — VIBES MODE is on and you are answering your own questions. ' +
  'Make the call yourself, take whichever option keeps the work moving, ' +
  'and say in your output what you chose and why.';

/** After a refused merge, how long before asking GitHub again. */
const RETRY_LAND_MS = 5 * 60_000;

const lastLandAttempt = new Map<string, number>();

/** After a resolution that still left the pull request conflicting, how long before trying again. */
const RETRY_RESOLVE_MS = 5 * 60_000;

const lastResolveAttempt = new Map<string, number>();

/**
 * Runs that tried and failed to resolve the same pull request's conflicts,
 * keyed by its URL. Cleared the moment nothing is conflicting on record,
 * whether that pull request never conflicted or a run just pushed a fix for
 * it — so a repo where conflicts are routine, from cards landing on each
 * other's heels, is not what this counts. What it stops is a card stuck on
 * one conflict no run resolves, which past this many tries is left in Done
 * for a person instead of spending another $5 run every five minutes.
 */
const MAX_RESOLVE_ATTEMPTS = 3;
const resolveAttempts = new Map<string, number>();

let sweeping = false;

/**
 * One pass over the board. Every card gets at most one action, so the board
 * advances at a readable pace rather than a card crossing four columns between
 * two polls.
 *
 * Idempotent and safe to call on a timer: each rule reads the card as it is now.
 */
export async function vibesSweep(db: Db, writer: EventWriter): Promise<void> {
  if (sweeping) return;
  // The whole board with the switch on; otherwise only the cards flagged on
  // their own or through their project, and nothing at all when there are none.
  // An empty board with the switch on is still swept, since that is exactly
  // when it needs ideas.
  const board = getSettings(db).vibesSince !== null;
  const cards = board ? boardCards(db) : vibesCards(db);
  if (cards.length === 0 && !board) return;
  sweeping = true;
  try {
    const repos = new Map(listRepos(db).map((r) => [r.id, r]));
    for (const { card: listed } of cards) {
      // Re-read per card, every switch: any of them going off mid-sweep has to
      // stop it here, not one approval or merge later off a stale list. That
      // includes the project's, and a card moved out of its lane since.
      const card = getCard(db, listed.id);
      if (!card || card.archivedAt) continue;
      if (getSettings(db).vibesSince === null && !inVibes(db, card)) continue;
      const repo = card.repoId ? repos.get(card.repoId) : undefined;
      // A card with no repo has no worktree, so no stage of it can run and
      // there is nothing to automate. It waits, as it would anyway.
      if (!repo) continue;
      await advance(db, writer, card, repo);
    }
    // After the cards, so a repo whose last card just reached Done is asked
    // what comes next on the same pass. It reads the switch for itself.
    await thinkOfIdeas(db, writer);
  } finally {
    sweeping = false;
  }
}

/** The one thing this card needs next. */
async function advance(db: Db, writer: EventWriter, card: Card, repo: Repo): Promise<void> {
  const stage = card.stage as Stage;

  // Done: open the pull request, resolve whatever it conflicts on, then land
  // it. Entering Done already tries to open one on its own; this is what makes
  // it keep trying, what takes the Resolve conflicts button's place, and what
  // merges it.
  if (stage === 'done') {
    if (card.mergedAt || isOpeningPr(card.id)) return;
    if (!card.prUrl) {
      maybeOpenPullRequest(db, card, repo);
      return;
    }
    if (isResolvingConflicts(card.id)) return;
    if (isPrConflicting(card)) {
      const prUrl = card.prUrl;
      if ((resolveAttempts.get(prUrl) ?? 0) >= MAX_RESOLVE_ATTEMPTS) return;
      const lastResolve = lastResolveAttempt.get(card.id) ?? 0;
      if (Date.now() - lastResolve < RETRY_RESOLVE_MS) return;
      const result = await resolveConflicts(db, writer, card, repo, undefined, 'claude');
      // A refusal before a run even started — the cap was full, `gh` failed,
      // the tree was dirty — spent nothing and is not this conflict's fault,
      // so it is only throttled, never counted against the cap. A 429 is not
      // even throttled: the cap is meant to be retried on the very next sweep.
      if (!result.ok && result.status === 429) return;
      lastResolveAttempt.set(card.id, Date.now());
      if (result.ok && result.runId) resolveAttempts.set(prUrl, (resolveAttempts.get(prUrl) ?? 0) + 1);
      return;
    }
    // Nothing conflicting on record for this pull request: never was, or a
    // pushed resolution just forgot it. Either way the count of runs that
    // failed to resolve it does not carry into whatever conflicts it next.
    resolveAttempts.delete(card.prUrl);
    // A repository that requires a review refuses every time, and each refusal
    // is written to the card. Without this the log would be nothing else.
    const last = lastLandAttempt.get(card.id) ?? 0;
    if (Date.now() - last < RETRY_LAND_MS) return;
    lastLandAttempt.set(card.id, Date.now());
    await landPullRequest(db, card, repo, 'claude');
    return;
  }

  // Backlog. Nobody is going to drag this, so it goes — over Planning, straight
  // into In Progress — and then starts the way a card dragged there starts.
  if (!isRunnable(stage)) {
    // Except a card nobody has said anything about yet. A card is made with a
    // placeholder title and an empty brief and opened for the details to be
    // typed in, and planning THAT is guaranteed waste: a stage run on "Untitled"
    // with nothing to go on can only produce a plan for nothing. It is also the
    // difference between the switch being fun and the switch being a trap —
    // otherwise the card is taken away mid-sentence, two seconds after the Add
    // button. Say what it is and it goes.
    //
    // A placeholder title is not the only way a card is still being said,
    // though: the moment its title is typed over it stops being one, even
    // while the brief underneath is still blank. `isHeld` is what catches
    // that second — the card's own modal, open since the Add button, has not
    // closed yet — so a title alone is never read as the whole card.
    if (isPlaceholderCard(card) || isHeld(card.id)) return;
    // A card waiting on another is held in `moveOn`, which every move this
    // sweep makes goes through.
    moveOn(db, writer, card, repo);
    return;
  }

  const { activity, run } = cardActivity(db, card);
  switch (activity) {
    // The gate, waived. `approveStage` records the verdict, moves the card on
    // and starts its next stage — the same three things the button does. Not
    // the rule under the gate: a Testing card that was never built is left for
    // a person, as the button would refuse it, rather than pushed empty to Done.
    // Nor the order the work has to happen in: a card waiting on another stays,
    // reviewed or not, until what it waits on has cleared. Nor a card a person
    // has just rejected, whose revision is waiting on the tree's setup and
    // reads as needing review until it starts.
    case 'needs_review': {
      const to = nextStage(stage) ?? stage;
      if (run && !isStartingStage(card.id) && !blockedMove(db, card, to) && !entryRefusal(db, card, to)) {
        approveStage(db, writer, card, repo, run, { actor: 'claude', notes: APPROVAL });
      }
      return;
    }

    case 'needs_input':
      if (run) await answerEverything(db, writer, card, run);
      return;

    // Started, restarted, or picked up after the cap refused it last time.
    // Except in Planning, where nothing is ever started in here: a card that
    // was sitting there when the switch went on, with no plan in flight, is
    // moved on without one. A plan already written or already asking is left to
    // finish through the two cases above, because it is paid for.
    case 'idle':
    case 'error':
      if (stage === 'planning') {
        moveOn(db, writer, card, repo);
        return;
      }
      if (canStartRun({ stage, activity })) await startStage(db, writer, card, repo);
      return;

    case 'running':
      return;
  }
}

/**
 * The column after this one, with Planning stepped over.
 *
 * Here and not in `nextStage`, because the calm board, the review gate and the
 * card's own buttons all advance through Planning, and VIBES MODE is a layer
 * over that product rather than a fork of it. Nothing after it needs a plan:
 * In Progress works from the card itself when none was recorded.
 */
function vibesNext(stage: Stage): Stage | null {
  const to = nextStage(stage);
  return to === 'planning' ? nextStage(to) : to;
}

/** Into the next column as Claude, and started there, as a drag would have. */
function moveOn(db: Db, writer: EventWriter, card: Card, repo: Repo): void {
  const to = vibesNext(card.stage as Stage);
  if (!to) return;
  // Except a card waiting on another that has not cleared. That is not one of
  // Reeve's human gates but the order the work has to happen in, and taking
  // the person out of the loop does not change it. It goes on the first sweep
  // after its dependency's pull request merges — or after it reaches Done, if
  // it has none. Here rather than beside each caller, so a Planning card left
  // with no plan in flight is held the same as one in Backlog.
  if (blockedMove(db, card, to)) return;
  const moved = moveCard(db, card.id, to, cardsInStage(db, to).length, 'claude');
  if (moved) maybeStartStage(db, writer, moved, repo);
}

/**
 * Answer every question the run left open, which resumes it.
 *
 * In order and one at a time, because answering the last one is what forks the
 * resumed run: `recordAnswer` decides that by looking at whether any are still
 * unanswered, and answering them in parallel would let two calls both believe
 * they were last.
 */
async function answerEverything(db: Db, writer: EventWriter, card: Card, run: Run): Promise<void> {
  for (const q of questionsForRun(db, run.id)) {
    if (q.answer !== null) continue;
    await recordAnswer(db, writer, card, q, answerTo(q), 'claude');
  }
}

function answerTo(q: Question): string {
  const own = q.suggestions?.find((s) => s.trim());
  return own ?? NO_ONE_HOME;
}
