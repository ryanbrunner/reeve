import { isTerminal, type ApiCard, type RunStatus } from '@reeve/shared';

/**
 * What `reeve` exits with. The contract a script or an agent drives Reeve
 * through, so each number means one thing across every command, and none of
 * them is ever renumbered: a script written against 3 meaning "answer the
 * questions" has no other way to find out it changed.
 *
 * `wait` is what this is for. 0 is the one a script can go straight on from —
 * the stage's work is done and waiting for a verdict — so `reeve card wait X
 * && reeve card approve X` reads the way it should. `run follow` borrows the
 * same numbers for how its run ended.
 */
export const EXIT = {
  /** wait: the run finished and awaits review. follow: the run succeeded. Anything else: it worked. */
  ok: 0,
  /** The command could not do what it was asked: Reeve unreachable, no such card, the server refused. */
  error: 1,
  /** The command line was wrong. The usage text is printed too. */
  usage: 2,
  /**
   * wait: Claude is waiting on a person — it asked questions, ended its turn
   * on something to reply to, or a live run is parked on a permission or a
   * question. `reeve card questions` says which; `reply`, `answer` and
   * `permit` are the ways back. follow: the run ended waiting on a reply.
   */
  needsInput: 3,
  /** wait: the stage's run failed or was interrupted. follow: the run did. */
  failed: 4,
  /**
   * wait: nothing is running and nothing is waiting on a verdict or an answer.
   * The card is in Backlog or Release, its run was stopped, or its start was
   * refused (the concurrency cap, say). A person has to move or start it.
   * follow: the run was stopped.
   */
  idle: 5,
  /** wait: `--timeout` ran out first. The card is still running. */
  timeout: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** The codes `wait` ends with when it ends normally. */
export type WaitExit = Exclude<ExitCode, typeof EXIT.error | typeof EXIT.usage>;

/**
 * Whether a card needs a person yet, and which way. Null while it does not:
 * a run is going, or one is about to be.
 */
export function waitOutcome(card: ApiCard): Exclude<WaitExit, typeof EXIT.timeout> | null {
  // Off the board, nothing will start it.
  if (card.archivedAt !== null) return EXIT.idle;
  // A run is about to be. Approving moves a card into a column whose run is
  // not there yet, and it reads idle while its worktree is made; a revision or
  // a resume waits on the tree's setup first, reading needs_review or
  // needs_input all the while for a verdict or answers already given.
  if (card.startingStage) return null;
  switch (card.activity) {
    case 'running':
      return null;
    case 'needs_review':
      return EXIT.ok;
    case 'needs_input':
      return EXIT.needsInput;
    case 'error':
      return EXIT.failed;
    case 'idle':
      return EXIT.idle;
  }
}

/** How a run ended, in the same numbers. Null while it has not. */
export function runOutcome(status: RunStatus): ExitCode | null {
  if (!isTerminal(status)) return null;
  if (status === 'succeeded') return EXIT.ok;
  if (status === 'cancelled') return EXIT.idle;
  // Ended its turn on something for the person, which is no failure.
  if (status === 'awaiting_reply') return EXIT.needsInput;
  return EXIT.failed;
}
