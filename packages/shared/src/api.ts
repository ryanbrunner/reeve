import type { RunnableStage, Stage } from './stages.js';
import type { CardActivity } from './activity.js';
import type { EffortLevel, RunKind, RunStatus, StopReason } from './runs.js';

/**
 * Wire types. Deliberately plain interfaces rather than Drizzle's inferred row
 * types so this module stays free of server-only imports and the browser bundle
 * never pulls in the ORM. Timestamps are epoch milliseconds.
 */

export interface ApiRepo {
  id: string;
  name: string;
  repoPath: string;
  worktreeRoot: string;
  defaultBranch: string;
  setupCommand: string | null;
  testCommand: string | null;
  serverCommand: string | null;
  teardownCommand: string | null;
  finishCommand: string | null;
  laneColor: string | null;
  maxBudgetUsd: number | null;
}

export interface ApiRunSummary {
  id: string;
  kind: RunKind;
  stage: Stage;
  status: RunStatus;
  /**
   * Null for the stage's own attempt. Set for work done beside it — Suggest is
   * `suggest_criteria` — which never counts as the card's current run.
   */
  task: string | null;
  /** What the run was actually sent, after overrides and the model's own limits. Null is the CLI's default. */
  model: string | null;
  effort: EffortLevel | null;
  stopReason: StopReason | null;
  totalCostUsd: number | null;
  port: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  errorMessage: string | null;
}

export interface ApiCard {
  id: string;
  /** Per-repo and stable: the `#142` a person can say out loud. */
  number: number;
  repoId: string | null;
  repoName: string | null;
  laneColor: string | null;
  title: string;
  body: string;
  stage: Stage;
  position: number;
  branchName: string | null;
  worktreePath: string | null;
  /**
   * The squash commit on the default branch, once merged. Stored, unlike
   * everything else here: the branch that could have told us is gone. Only
   * cards from before pull requests replaced the merge have one.
   */
  mergedSha: string | null;
  /** Set for those, and for a card whose pull request has merged on GitHub. */
  mergedAt: number | null;
  /** The pull request the branch was opened as, once Done has pushed it. */
  prUrl: string | null;
  prNumber: number | null;
  prOpenedAt: number | null;
  /**
   * A push to GitHub is under way for this card right now. Read off the
   * server's memory rather than stored, so a restart mid-push cannot leave a
   * card looking busy forever.
   */
  openingPr: boolean;
  /**
   * This card's override for every stage run, above the Settings default for
   * the stage. Null falls through. Suggest ignores both.
   */
  model: string | null;
  effort: EffortLevel | null;
  /** Whether Planning draws its own mockups of the states this card changes. */
  generateMockups: boolean;
  /** Sub-state within the column. Derived from `latestRun`, never stored. */
  activity: CardActivity;
  /**
   * The latest Claude run for the card's CURRENT stage — the same run `activity`
   * is derived from, so the tint and the chip can never disagree. Shell and
   * server runs are excluded on purpose: a dev server left running should not
   * make a card look like Claude is working on it.
   */
  latestRun: ApiRunSummary | null;
  /** Set when the card has been taken off the board. Nothing is deleted; restoring clears it. */
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface BoardResponse {
  repos: ApiRepo[];
  cards: ApiCard[];
}

export interface CreateCardBody {
  title: string;
  body?: string;
  repoId?: string | null;
  stage?: Stage;
  /** Omitted is on. */
  generateMockups?: boolean;
}

/**
 * Adding a repo. `worktreeRoot` and `defaultBranch` are optional because the
 * server can read better answers off the repository itself than a person can
 * be bothered to type: the branch it is on, and a `.reeve-worktrees` beside it.
 */
export interface CreateRepoBody {
  name: string;
  repoPath: string;
  worktreeRoot?: string;
  defaultBranch?: string;
  setupCommand?: string | null;
  testCommand?: string | null;
  serverCommand?: string | null;
  teardownCommand?: string | null;
  finishCommand?: string | null;
  laneColor?: string | null;
  maxBudgetUsd?: number | null;
}

export type UpdateRepoBody = Partial<CreateRepoBody>;

/** A model and effort for one stage's runs. Null means "not set here": the next layer down decides. */
export interface StageRunDefault {
  model: string | null;
  effort: EffortLevel | null;
}

export type StageRunDefaults = Record<RunnableStage, StageRunDefault>;

/** Reeve's own settings, as opposed to a repo's. Every field is resolved: never null. */
export interface ApiSettings {
  /** Claude runs allowed at once, across every card and repo. */
  maxConcurrentRuns: number;
  /**
   * Every runnable stage is present, so the form can loop over them. A null in
   * one falls through to what the stage's own module asks for.
   */
  stageDefaults: StageRunDefaults;
}

/** A stage left out of `stageDefaults` is left as it was, so saving one row cannot wipe the others. */
export interface UpdateSettingsBody {
  maxConcurrentRuns?: number;
  stageDefaults?: Partial<StageRunDefaults>;
}

/**
 * One model the Claude CLI offers, as its `supportedModels()` reports it.
 * The capability flags are optional there and here: absent means the CLI did
 * not say, and is treated as "yes" so an unannotated model is not crippled.
 */
export interface ApiModel {
  /** What to send as `model`: an alias like `opus`, or a full id. */
  value: string;
  /** The full id the alias currently points at, when it is one. */
  resolvedModel: string | null;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: EffortLevel[];
  supportsAdaptiveThinking?: boolean;
}

export interface ModelsResponse {
  /** Empty when the CLI could not be asked — offline, or not logged in. */
  models: ApiModel[];
  /** What each stage asks for when nothing overrides it: the bottom layer, from the stage modules. */
  builtIn: StageRunDefaults;
}

/** Drag-and-drop target: the column, and the slot within it. */
export interface MoveCardBody {
  stage: Stage;
  index: number;
}

export interface ApiError {
  error: string;
  detail?: string;
}
