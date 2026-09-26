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
  /** wait: Claude asked questions, and the run is waiting on answers. */
  needsInput: 3,
  /** wait: the stage's run failed or was interrupted. follow: the run did. */
  failed: 4,
  /**
   * wait: nothing is running and nothing is waiting on a verdict or an answer.
   * The card is in Backlog or Done, its run was stopped, or its start was
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
      // Approving moves a card into a column whose run is not there yet: it
      // reads idle for as long as its worktree takes to make.
      return card.startingStage ? null : EXIT.idle;
  }
}

/** How a run ended, in the same numbers. Null while it has not. */
export function runOutcome(status: RunStatus): ExitCode | null {
  if (!isTerminal(status)) return null;
  if (status === 'succeeded') return EXIT.ok;
  if (status === 'cancelled') return EXIT.idle;
  return EXIT.failed;
}
