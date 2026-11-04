/**
 * The board's columns, left to right. A card's column IS its stage — there is no
 * second status field to drift out of sync.
 */
export const STAGES = [
  'backlog',
  'planning',
  'in_progress',
  'testing',
  'release',
] as const;

export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  backlog: 'Backlog',
  planning: 'Planning',
  in_progress: 'In Progress',
  testing: 'Testing',
  release: 'Release',
};

/**
 * The name a stage went by before, mapped to the one it has now, for whatever
 * still says it: a script running `reeve card move 142 done`, a URL, a person.
 * Done became Release when the last column became a conversation with Claude
 * about shipping the work rather than a place it waited.
 */
const FORMER: Record<string, Stage> = { done: 'release' };

/** A stage named by a person or a script, old names included; null if it is none. */
export function normaliseStage(name: string): Stage | null {
  const key = name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if ((STAGES as readonly string[]).includes(key)) return key as Stage;
  return FORMER[key] ?? null;
}

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
 * Stages that run Claude: every column but Backlog, which is where work waits
 * to be taken on. Release is the last of them — the conversation in which
 * Claude prepares the pull request and the person merges it.
 */
export const RUNNABLE_STAGES = ['planning', 'in_progress', 'testing', 'release'] as const;
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
