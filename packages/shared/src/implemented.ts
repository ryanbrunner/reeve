import type { RunKind, RunStatus } from './runs.js';
import { STAGES, STAGE_LABELS, type Stage } from './stages.js';

/**
 * Whether a card has been implemented: whether any of its runs is this one.
 *
 * A finished In Progress run, and not "the branch has commits ahead of base",
 * which would be the truer answer and costs a git call per card on a board that
 * polls every second in SICKO MODE — and has no answer at all for a card whose
 * worktree has gone. The price is that a run which succeeded and changed
 * nothing still counts.
 *
 * `task === null` for the same reason `latestClaudeRunForStage` filters on it:
 * a Suggest or a conflict resolution is not the stage's own attempt. In Progress
 * has no `awaitsInput`, so a succeeded run there never stopped to ask.
 *
 * The server asks the database the same question as `hasImplementationRun`,
 * because loading every run a card has to feed this would be wasteful on the
 * board. The two must agree.
 */
export function isImplementationRun(run: {
  kind: RunKind;
  stage: Stage;
  status: RunStatus;
  task: string | null;
}): boolean {
  return run.kind === 'claude' && run.stage === 'in_progress' && run.status === 'succeeded' && run.task === null;
}

/** Testing tests the branch and Done pushes it; with nothing on it, both are waste. */
const NEEDS_IMPLEMENTATION: readonly Stage[] = ['testing', 'done'];

/**
 * Why a card may not move from `from` to `to`, as a sentence to show a person,
 * or null if it may.
 *
 * Only forward moves into Testing or Done are refused. A reorder within the
 * column and a move backwards both pass, so a card that reached Testing or Done
 * before this rule existed can still be tidied or sent back. The same sentence
 * is the server's 409 and the card detail's tooltip, so the two cannot disagree.
 */
export function stageEntryRefusal(from: Stage, to: Stage, implemented: boolean): string | null {
  if (implemented || !NEEDS_IMPLEMENTATION.includes(to)) return null;
  if (STAGES.indexOf(to) <= STAGES.indexOf(from)) return null;
  return `${STAGE_LABELS[to]} needs the card implemented first: it has no finished In Progress run yet.`;
}
