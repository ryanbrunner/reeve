/**
 * The board's columns, left to right. A card's column IS its stage — there is no
 * second status field to drift out of sync.
 */
export const STAGES = [
  'backlog',
  'planning',
  'in_progress',
  'testing',
  'done',
] as const;

export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  backlog: 'Backlog',
  planning: 'Planning',
  in_progress: 'In Progress',
  testing: 'Testing',
  done: 'Done',
};

/**
 * A card is a piece of work, or a project: a brief that groups several of them.
 * A project is a card so that it gets everything a card already has — a brief
 * to edit, runs to cost and read back, a modal — rather than a second copy of
 * each. It sits in no column: the board shows it as a lane, and nothing runs a
 * stage on it.
 */
export const CARD_KINDS = ['task', 'project'] as const;
export type CardKind = (typeof CARD_KINDS)[number];

/**
 * Stages that run Claude. The others are holding areas the human moves cards
 * through, which is why `backlog` and `done` have no runnable work.
 */
export const RUNNABLE_STAGES = ['planning', 'in_progress', 'testing'] as const;
export type RunnableStage = (typeof RUNNABLE_STAGES)[number];

export function isRunnable(stage: Stage): stage is RunnableStage {
  return (RUNNABLE_STAGES as readonly string[]).includes(stage);
}

/**
 * The stage after this one, or null at the end of the board.
 *
 * The rule this exists to serve is human-in-the-loop, not never-advance. A run
 * finishing on its own must never carry a card forward — that shows up as a
 * change of `CardActivity` instead, see ./activity.ts — but a human saying the
 * work is good is exactly the signal to move on, so approving a stage advances
 * the card. Claude never moves a card; a human action does, whether that action
 * is a drag or an approval.
 */
export function nextStage(stage: Stage): Stage | null {
  return STAGES[STAGES.indexOf(stage) + 1] ?? null;
}

/** A card needs a worktree from Planning onward; Backlog doesn't. */
export function needsWorktree(stage: Stage): boolean {
  return STAGES.indexOf(stage) >= STAGES.indexOf('planning');
}
