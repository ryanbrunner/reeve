import { canStartRun, isPlaceholderCard, isRunnable, nextStage, type Stage } from '@reeve/shared';
import { recordAnswer } from '../answers.js';
import { cardActivity } from '../board.js';
import type { Db } from '../db/client.js';
import {
  boardCards,
  cardsInStage,
  getSettings,
  listRepos,
  moveCard,
  questionsForRun,
} from '../db/queries.js';
import type { Card, Question, Repo, Run } from '../db/schema.js';
import { isOpeningPr, landPullRequest, maybeOpenPullRequest } from '../pullRequest.js';
import { approveStage } from '../review.js';
import type { EventWriter } from '../runs/events.js';
import { maybeStartStage, startStage } from '../startStage.js';

/**
 * SICKO MODE, doing the things a person would otherwise have to.
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
 * Exactly the six things the arming overlay promises, and nothing else. Reeve's
 * own human-in-the-loop gates come off; the stages' tool permissions, the
 * concurrency cap and the repository's branch protection do not, because none
 * of those is a human in the loop — they are limits on what a run may do, and
 * taking the person out of the loop is not a reason to widen them.
 */

/** What the review gate is told, and what the card's history will say for ever. */
const APPROVAL = 'Approved by SICKO MODE. Nobody read this.';

/**
 * What a question gets when Claude asked one and there is no one to ask.
 *
 * Its own first suggestion where it made one — which is as close to "Claude
 * answered its own question" as this can honestly get — and otherwise an
 * instruction to decide and say what it decided, so the choice is at least on
 * the record.
 */
const NO_ONE_HOME =
  'There is nobody to ask — SICKO MODE is on and you are answering your own questions. ' +
  'Make the call yourself, take whichever option keeps the work moving, ' +
  'and say in your output what you chose and why.';

/** After a refused merge, how long before asking GitHub again. */
const RETRY_LAND_MS = 5 * 60_000;

const lastLandAttempt = new Map<string, number>();

let sweeping = false;

/**
 * One pass over the board. Every card gets at most one action, so the board
 * advances at a readable pace rather than a card crossing four columns between
 * two polls.
 *
 * Idempotent and safe to call on a timer: each rule reads the card as it is now.
 */
export async function sickoSweep(db: Db, writer: EventWriter): Promise<void> {
  if (sweeping || getSettings(db).sickoSince === null) return;
  sweeping = true;
  try {
    const repos = new Map(listRepos(db).map((r) => [r.id, r]));
    for (const { card } of boardCards(db)) {
      // Re-read per card: the switch going off mid-sweep has to stop it here,
      // not after it has walked the rest of the board.
      if (getSettings(db).sickoSince === null) return;
      const repo = card.repoId ? repos.get(card.repoId) : undefined;
      // A card with no repo has no worktree, so no stage of it can run and
      // there is nothing to automate. It waits, as it would anyway.
      if (!repo) continue;
      await advance(db, writer, card, repo);
    }
  } finally {
    sweeping = false;
  }
}

/** The one thing this card needs next. */
async function advance(db: Db, writer: EventWriter, card: Card, repo: Repo): Promise<void> {
  const stage = card.stage as Stage;

  // Done: open the pull request, then land it. Entering Done already tries to
  // open one on its own; this is what makes it keep trying, and what merges it.
  if (stage === 'done') {
    if (card.mergedAt || isOpeningPr(card.id)) return;
    if (!card.prUrl) {
      maybeOpenPullRequest(db, card, repo);
      return;
    }
    // A repository that requires a review refuses every time, and each refusal
    // is written to the card. Without this the log would be nothing else.
    const last = lastLandAttempt.get(card.id) ?? 0;
    if (Date.now() - last < RETRY_LAND_MS) return;
    lastLandAttempt.set(card.id, Date.now());
    await landPullRequest(db, card, repo);
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
    if (isPlaceholderCard(card)) return;
    moveOn(db, writer, card, repo);
    return;
  }

  const { activity, run } = cardActivity(db, card);
  switch (activity) {
    // The gate, waived. `approveStage` records the verdict, moves the card on
    // and starts its next stage — the same three things the button does.
    case 'needs_review':
      if (run) approveStage(db, writer, card, repo, run, { actor: 'claude', notes: APPROVAL });
      return;

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
 * card's own buttons all advance through Planning, and SICKO MODE is a layer
 * over that product rather than a fork of it. Nothing after it needs a plan:
 * In Progress works from the card itself when none was recorded.
 */
function sickoNext(stage: Stage): Stage | null {
  const to = nextStage(stage);
  return to === 'planning' ? nextStage(to) : to;
}

/** Into the next column as Claude, and started there, as a drag would have. */
function moveOn(db: Db, writer: EventWriter, card: Card, repo: Repo): void {
  const to = sickoNext(card.stage as Stage);
  if (!to) return;
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
