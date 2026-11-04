/**
 * What Continue says to a run that stopped before it finished, as the person's
 * own words in the conversation: a reply, so the stage's session carries on
 * with what the person said in it, where Retry starts a fresh session on the
 * same worktree.
 */

/** After a restart took the run away. Nothing was wrong with the session. */
export const CONTINUE_INTERRUPTED =
  'Reeve restarted while you were working, which stopped this run and any worker you had going. Carry on from where you ' +
  'left off: check the worktree first for anything you were half-way through, since the last step may not have finished.';

/** After the run failed. */
export const CONTINUE_FAILED =
  'Your run stopped with an error before you finished, along with any worker you had going. Carry on from where you left ' +
  'off: check the worktree first for anything half-done.';
