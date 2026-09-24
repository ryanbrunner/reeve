/**
 * The board's columns, left to right. A card's column IS its stage — there is no
 * second status field to drift out of sync.
 */
export const STAGES = [
  'backlog',
  'ready_for_planning',
  'planning',
  'in_progress',
  'testing',
  'done',
] as const;

export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  backlog: 'Backlog',
  ready_for_planning: 'Ready for Planning',
  planning: 'Planning',
  in_progress: 'In Progress',
  testing: 'Testing',
  done: 'Done',
};

/**
 * Stages that run Claude. The others are holding areas the human moves cards
 * through, which is why `backlog` and `ready_for_planning` have no runnable work.
 */
export const RUNNABLE_STAGES = ['planning', 'in_progress', 'testing'] as const;
export type RunnableStage = (typeof RUNNABLE_STAGES)[number];

export function isRunnable(stage: Stage): stage is RunnableStage {
  return (RUNNABLE_STAGES as readonly string[]).includes(stage);
}

export function nextStage(stage: Stage): Stage | null {
  const i = STAGES.indexOf(stage);
  return i < 0 || i === STAGES.length - 1 ? null : (STAGES[i + 1] as Stage);
}

/**
 * Approving a stage advances the card but never auto-starts the next stage —
 * the human kicks each one off.
 */
export function stageAfterApproval(stage: Stage): Stage | null {
  return nextStage(stage);
}

/** A card needs a worktree from Planning onward; Backlog and Ready don't. */
export function needsWorktree(stage: Stage): boolean {
  return STAGES.indexOf(stage) >= STAGES.indexOf('planning');
}
