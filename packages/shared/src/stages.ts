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

/**
 * What VIBES MODE leaves out, and whether it lands what it builds. Settings'
 * VIBES MODE options, the same for the board's switch as for a card or a
 * project put in VIBES MODE on its own.
 *
 * Only Planning and Testing can be skipped. In Progress is the work and
 * Release is where it becomes a pull request, so there is no field for either
 * and nothing can turn them off.
 */
export interface VibesOptions {
  /** Sweep a card from Backlog over Planning straight into In Progress. On by default. */
  skipPlanning: boolean;
  /** Approve In Progress straight into Release, over Testing. Off by default. */
  skipTesting: boolean;
  /**
   * Land the pull request once Release has written it. Off leaves a VIBES card
   * in Release with its pull request open and mergeable, for a person's Merge.
   * On by default.
   */
  autoMerge: boolean;
}

/** What every board did before these were options, and still does until someone changes one. */
export const DEFAULT_VIBES_OPTIONS: VibesOptions = { skipPlanning: true, skipTesting: false, autoMerge: true };

/** Whether VIBES MODE steps over this column rather than stopping in it. */
export function vibesSkips(stage: Stage, options: VibesOptions): boolean {
  return (stage === 'planning' && options.skipPlanning) || (stage === 'testing' && options.skipTesting);
}

/**
 * The column VIBES MODE moves a card into after this one: `nextStage`, with
 * every column the options skip stepped over. Never skips past Release, which
 * no option can skip.
 *
 * Beside `nextStage` rather than in it, because the calm board, the review
 * gate and a card's own buttons all advance through every column, and VIBES
 * MODE is a layer over that product rather than a fork of it.
 */
export function vibesNextStage(stage: Stage, options: VibesOptions): Stage | null {
  let to = nextStage(stage);
  while (to && vibesSkips(to, options)) to = nextStage(to);
  return to;
}
