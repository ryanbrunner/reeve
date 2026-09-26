import type { CardKind, RunnableStage, Stage } from './stages.js';
import type { CardActivity } from './activity.js';
import type { EffortLevel, RunKind, RunStatus, StopReason } from './runs.js';

/**
 * Wire types. Deliberately plain interfaces rather than Drizzle's inferred row
 * types so this module stays free of server-only imports and the browser bundle
 * never pulls in the ORM. Timestamps are epoch milliseconds.
 */

/** Where the server listens when `REEVE_PORT` does not say, and so where the CLI looks for it. */
export const DEFAULT_PORT = 4317;

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

/**
 * A tool call the run asked for and did not get.
 *
 * Worth a wire type of its own because a denial is the one run fact that
 * explains an otherwise inexplicable result: a run that read the code instead
 * of testing it, or reported success having executed nothing, usually asked for
 * something first and was told no.
 */
export interface ApiToolDenial {
  tool: string;
  /** The command, or the path — whatever identifies which call it was. Null when the input said nothing useful. */
  detail: string | null;
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
  /** Empty for almost every run. Not empty is a thing the human should see. */
  deniedToolUses: ApiToolDenial[];
}

export interface ApiCard {
  id: string;
  /** A project is never on the board as a card: it is a lane, and it opens from there. */
  kind: CardKind;
  /** The project this card belongs to. Null is the No project lane. */
  projectId: string | null;
  /** Per-repo and stable: the `#142` a person can say out loud. Zero for a project, which has none. */
  number: number;
  /** For a project, its default repo: the one its split reads and its tasks fall back to. */
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
   * GitHub last said the pull request cannot merge for conflicts with its base.
   * Only ever set on a Done card with an open pull request, and only by
   * GitHub's own verdict, so it can lag a push by one sync.
   */
  prConflicting: boolean;
  /**
   * Reeve is merging the base branch into this card's branch right now: from
   * the fetch, through Claude's run, to the push. In memory like `openingPr`.
   */
  resolvingConflicts: boolean;
  /**
   * The card's stage run is being started: its worktree is being made, and
   * `latestRun` does not show the run yet. The card still reads `idle` for
   * those seconds, which to anything waiting on it looks exactly like a card
   * nothing will start. In memory like `openingPr`.
   */
  startingStage: boolean;
  /**
   * This card's override for every stage run, above the Settings default for
   * the stage. Null falls through. Suggest ignores both.
   */
  model: string | null;
  effort: EffortLevel | null;
  /** Whether Planning draws its own mockups of the states this card changes. */
  generateMockups: boolean;
  /**
   * SICKO MODE for this card alone: approved, answered, started and merged
   * without anyone asked, while the rest of the board stays calm. Beside the
   * board's own switch rather than under it — with that on, every card goes.
   */
  sicko: boolean;
  /**
   * The cards this one waits on, finished ones included, lowest number first.
   * Named rather than listed by id because the board draws a chip for each, and
   * a dependency that has gone from `cards` is almost always one that finished:
   * a merged card leaves the board ten minutes after it lands, and an id alone
   * would leave nothing to draw. Always empty for a project: only tasks take
   * part.
   */
  dependsOn: ApiCardLink[];
  /**
   * Live cards waiting on this one, by id. Ids rather than a count because the
   * board lights them up when this card is hovered; the face only shows how
   * many.
   */
  dependents: string[];
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

/** Another card, as much of it as a card face needs to name it. */
export interface ApiCardLink {
  id: string;
  number: number;
  /** `#142` is per repo, so a card in another repo needs this to say which #142. */
  repoName: string | null;
  title: string;
  /** It has stopped holding anything up: in Done, or merged. */
  done: boolean;
}

/**
 * A project as the board draws it: a lane. Its brief and its runs are on the
 * card behind it, which opens in the modal like any other.
 */
export interface ApiProject {
  id: string;
  title: string;
  /** The project's default repo, and where its lane colour comes from. */
  repoId: string | null;
  laneColor: string | null;
  /** Live tasks under it. */
  taskCount: number;
}

export interface BoardResponse {
  repos: ApiRepo[];
  /** Oldest first, which is the order the lanes run in. */
  projects: ApiProject[];
  /** Tasks only. A project is never one of these. */
  cards: ApiCard[];
  /** Null while SICKO MODE is off, which is nearly always. */
  sicko: SickoState | null;
  /** Null until a run has reported one, and always under API-key auth, which has no such limits. */
  usage: UsageState | null;
}

/**
 * SICKO MODE, as the board sees it: since when, and what has happened without
 * anybody being asked.
 *
 * Rides on the board response rather than an endpoint of its own because the
 * board already polls and every one of these numbers changes on the same beat
 * as the cards do. All five are counted from `since`, off the card's own event
 * log and its runs — nothing here is a counter that a reload could reset or
 * that could disagree with a card's history.
 */
export interface SickoState {
  /** When the switch was flipped. */
  since: number;
  /** Cards whose pull request landed on the default branch since then. */
  merged: number;
  /** Reviews a person reached a verdict on since then. The point is that it is zero. */
  humanApprovals: number;
  /** Reviews approved without one. */
  reviewsSkipped: number;
  /** Questions Claude was handed back to itself. */
  questionsSelfAnswered: number;
  /** What every run since then has cost, in dollars. */
  spendUsd: number;
  /** Cards Claude has moved a column on its own. */
  moves: number;
  /** The last handful of things it did, newest first, already in human words. */
  log: string[];
}

/** How close a limit is: fine, past the point the server warns at, or spent. */
export type UsageLevel = 'ok' | 'warning' | 'rejected';

export interface UsageWindow {
  /** A fraction, 0–1. The stream sends it that way; the experimental usage API's 0–100 is not used. */
  utilization: number;
  /** When the window rolls over, in epoch milliseconds. The stream sends seconds; converted on the server. */
  resetsAt: number;
  level: UsageLevel;
}

/**
 * The subscription's rate limits, as last reported by a Claude run.
 *
 * Read off the `rate_limit_event` messages every run streams, so it moves only
 * while Reeve is running something — and Claude used anywhere else draws on the
 * same limits. `asOf` is when it was reported, which is what keeps an old
 * reading honest. A window whose reset has passed comes back at 0 and `ok`
 * rather than at the number it was left on.
 */
export interface UsageState {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** The worse of the two. */
  level: UsageLevel;
  asOf: number;
}

/**
 * The title a card is born with, before anyone has typed one.
 *
 * A card is made and opened rather than asked for a title first, because
 * criteria and context can only hang off a card that exists — so for a moment
 * every new card is called this. SICKO MODE has to be able to tell that moment
 * apart from a card somebody meant, which is why the string is here rather than
 * spelled out twice.
 */
export const PLACEHOLDER_TITLE = 'Untitled';

export interface CreateCardBody {
  title: string;
  body?: string;
  repoId?: string | null;
  stage?: Stage;
  /** Omitted is off. */
  generateMockups?: boolean;
  /** Defaults to a task. */
  kind?: CardKind;
  /** The project a task is made under. A project cannot belong to another. */
  projectId?: string | null;
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

/**
 * Lane colours, as a fixed set rather than a colour input.
 *
 * These are the board's swim lane dots and the chips on every card face, so
 * they have to sit on a dark panel without shouting — a free picker produces a
 * neon lane on the first try. Muted, evenly spaced, and picked for you. Here
 * rather than in the web app because `reeve repos add` picks one too.
 */
export const LANE_COLORS = ['#6b7db3', '#7fa38a', '#b3866b', '#8f7fb3', '#b36b81', '#6ba3b3'] as const;

/** The first colour no repo has yet, or the first of them all once every one is taken. */
export function freeLaneColor(taken: readonly (string | null)[]): string {
  return LANE_COLORS.find((c) => !taken.includes(c)) ?? LANE_COLORS[0];
}

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
  /** When SICKO MODE was switched on; null while it is off. */
  sickoSince: number | null;
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
  /**
   * The SICKO MODE switch. A boolean rather than the timestamp it sets, because
   * "on" must not silently restart the clock — flipping it while it is already
   * on would otherwise wipe every number the HUD is showing.
   */
  sicko?: boolean;
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

/**
 * Drag-and-drop target: the column, and the slot within it. `projectId` is the
 * lane it was dropped in, when that is a different one: null is No project,
 * and absent leaves the card where it was.
 */
export interface MoveCardBody {
  stage: Stage;
  index: number;
  projectId?: string | null;
}

/** Make the card this is sent for depend on another task. */
export interface AddDependencyBody {
  dependsOnId: string;
}

export interface ApiError {
  error: string;
  detail?: string;
}
