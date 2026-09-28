import type { ApiCard, ApiRepo, ApiRunSummary } from './api.js';
import type { Stage } from './stages.js';
import type { Thought } from './transcript.js';

/**
 * Wire types for the card detail modal.
 *
 * Kept out of ./api.ts, which is the board's contract and stays small: the
 * board asks for every card and needs each one cheap, this asks for one card
 * and needs it whole. Same rules as api.ts — plain interfaces, no server-only
 * imports, timestamps in epoch milliseconds.
 */

/**
 * Who did a thing, at the only resolution this tool has. There is no user
 * table yet; `actorId` is the seat kept warm for one, and the UI renders
 * `human` as "you" rather than that ever being stored.
 */
export type CardEventActor = 'human' | 'claude';

export type CardEventKind =
  | 'created'
  | 'moved'
  | 'run_started'
  | 'run_finished'
  | 'reviewed'
  | 'question_asked'
  | 'answered'
  | 'note'
  | 'merged'
  | 'pr_opened'
  | 'pr_failed'
  | 'archived'
  | 'restored'
  | 'handed_off'
  | 'crit_reviewed'
  | 'conflicts_resolved'
  | 'conflicts_failed'
  | 'merge_failed'
  | 'worktree_removed'
  | 'left_project'
  | 'suggestion_accepted';

export interface ApiCardEvent {
  id: string;
  actor: CardEventActor;
  actorId: string | null;
  kind: CardEventKind;
  stage: Stage | null;
  runId: string | null;
  fromStage: Stage | null;
  toStage: Stage | null;
  body: string | null;
  meta: Record<string, unknown> | null;
  createdAt: number;
}

/**
 * When the card entered each stage. Absent means never reached, which is what
 * lets the stage rail show a blank rather than a guess. Derived from the
 * `moved` events, never stored.
 */
export type StageHistory = Partial<Record<Stage, number>>;

export type CriterionVerdict = 'pass' | 'fail';

export interface ApiCriterion {
  id: string;
  position: number;
  text: string;
  /** Whether a person wrote this, or accepted Claude's suggestion of it. */
  source: CardEventActor;
  /** Null until a Testing run has judged it. */
  verdict: CriterionVerdict | null;
  evidence: string | null;
  verifiedRunId: string | null;
}

export type CardRefKind = 'file' | 'card' | 'url';

export interface ApiCardRef {
  id: string;
  kind: CardRefKind;
  value: string;
  label: string | null;
}

export interface ApiQuestion {
  id: string;
  /** The run that asked. A later attempt asks its own. */
  runId: string | null;
  /** 1-based, and the number a plan step means by "waits on question 2". */
  position: number;
  text: string;
  /** Concrete answers offered as buttons; a person may still write their own. */
  suggestions: string[];
  answer: string | null;
  answeredAt: number | null;
}

// --- Changes ----------------------------------------------------------------

export type DiffLineKind = 'context' | 'add' | 'del';
export type DiffStatus = 'added' | 'deleted' | 'renamed' | 'modified';

export interface ApiDiffLine {
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface ApiDiffHunk {
  header: string;
  lines: ApiDiffLine[];
}

export interface ApiDiffFile {
  path: string;
  oldPath: string | null;
  status: DiffStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: ApiDiffHunk[];
}

export interface ApiDiff {
  /** The sha the worktree started from; everything here is measured against it. */
  base: string;
  baseBranch: string;
  files: ApiDiffFile[];
  additions: number;
  deletions: number;
}

export interface ApiCommit {
  sha: string;
  subject: string;
}

// --- Pictures ---------------------------------------------------------------

/** `pasted` is an image in the brief, shown where the body links it and nowhere else. */
export type AssetKind = 'mockup' | 'screenshot' | 'pasted';

export interface ApiAsset {
  id: string;
  kind: AssetKind;
  label: string;
  /** The app path this shows, e.g. `/cart`. */
  url: string | null;
  viewport: number | null;
  /** Where to fetch the bytes. Ready to put in a `src`. */
  src: string;
  width: number | null;
  height: number | null;
  /**
   * The run that captured it, or the planning run that drew a mockup. Null on
   * a mockup a person attached.
   */
  runId: string | null;
  createdAt: number;
}

/** Where the build and the mockup disagree, in Claude's words rather than pixels. */
export interface ApiDifference {
  id: string;
  position: number;
  claim: string;
  note: string | null;
  mockupAssetId: string | null;
  screenshotAssetId: string | null;
}

// --- The plan, the build, the checks ---------------------------------------

export interface ApiPlanStep {
  title: string;
  detail: string;
  files: string[];
  /** The 1-based question number this waits on, matching ApiQuestion.position. */
  blockedOnQuestion: number | null;
}

export interface ApiPlan {
  runId: string;
  /** Which attempt this is — the "v2" beside the tab. */
  version: number;
  createdAt: number;
  summary: string;
  risk: 'low' | 'medium' | 'high';
  /** Sections Claude chose and titled. Render in order, however many there are. */
  details: Array<{ heading: string; body: string }>;
  steps: ApiPlanStep[];
  filesToTouch: string[];
}

export interface ApiImplementation {
  runId: string;
  createdAt: number;
  summary: string;
  commits: string[];
  filesChanged: string[];
  deviations: string[];
  /**
   * Titles of what the run suggested as cards of their own, work it left
   * undone included. The cards are linked from the rail; these are what the
   * run said, which a card since renamed or archived no longer is.
   */
  suggestedTasks: string[];
}

export interface ApiCheckFailure {
  test: string;
  reason: string;
  fixed: boolean;
}

/** What the last Testing run found. Null until one has run. */
export interface ApiChecks {
  runId: string;
  createdAt: number;
  passed: boolean;
  summary: string;
  criteriaVerified: number;
  criteriaTotal: number;
  differenceCount: number;
  failures: ApiCheckFailure[];
  fixesApplied: string[];
}

// --- The worktree -----------------------------------------------------------

/**
 * How Reeve knows where a dev server is, in the order it asks: the repo's URL
 * template, a `{{port}}` the server command was given, or the first local
 * address the server printed. There is no guess after those. A server that
 * ignores `PORT` is not at the port Reeve offered, so offering one proves
 * nothing.
 */
export const DEV_SERVER_URL_SOURCES = ['repo', 'command', 'announced'] as const;
export type DevServerUrlSource = (typeof DEV_SERVER_URL_SOURCES)[number];

/**
 * Read from the persisted run row, never from the in-memory registry.
 *
 * A restart empties the registry and kills every child process, but the boot
 * reaper marks those runs interrupted — so the row is right across a restart
 * and the registry is only right while the process lives. The registry is for
 * acting on a server; this is for describing one.
 */
export interface ApiDevServer {
  runId: string;
  /** `running` only while the row says so; anything terminal reads as stopped. */
  running: boolean;
  /** The port Reeve offered in `PORT`. Not where the server is unless it listened. */
  port: number | null;
  /** Where it can be reached, once something has said. Null means nobody has. */
  url: string | null;
  urlSource: DevServerUrlSource | null;
  since: number | null;
  /** Set when it stopped badly, e.g. a port already in use. */
  errorMessage: string | null;
}

export interface ApiWorktree {
  branch: string | null;
  path: string | null;
  /** The sha everything is measured against, captured once at creation. */
  base: string | null;
  baseBranch: string;
  /** Commits the base branch has gained since; null if it could not be counted. */
  behind: number | null;
  /** False once the directory has been removed from under us. */
  exists: boolean;
  server: ApiDevServer | null;
}

/**
 * What `POST /cards/:id/handoff` answers with: where the context file landed,
 * and the one line to paste into a terminal to start Claude Code on it.
 */
export interface HandoffResponse {
  path: string;
  command: string;
}

/**
 * What `POST /cards/:id/crit` answers with: the shell run holding the review
 * open, and where Crit is serving it. `url` is null when Crit had not said so
 * by the time the request gave up waiting; it opens the browser itself anyway.
 */
export interface CritReviewResponse {
  runId: string;
  url: string | null;
  /** A review was already open for this plan, and this is it. */
  reused: boolean;
}

/**
 * What `POST /cards/:id/resolve-conflicts` answers with. A run id means Claude
 * is resolving and the push follows it; none means the base merged cleanly
 * and `pushed` says it has already gone to the pull request.
 */
export interface ResolveConflictsResponse {
  runId: string | null;
  pushed: boolean;
}

/**
 * What `POST /cards/:id/merge` answers with once `gh` has merged the pull
 * request. `merged` says the card is marked merged already; false means GitHub
 * could not be asked straight after, and the next sync marks it.
 */
export interface MergePullRequestResponse {
  merged: boolean;
}

// --- The whole card ---------------------------------------------------------

/**
 * Everything the detail view renders, in one response.
 *
 * One payload and so one query key and one poll: a modal whose header, tabs
 * and rail each fetched separately would show a card mid-transition, with the
 * stage in the header disagreeing with the stage in the rail. The diff and the
 * commit list are the deliberate exceptions — they shell out to git, and so
 * are fetched once when the modal opens rather than on every poll.
 */
export interface CardDetail {
  card: ApiCard;
  repo: ApiRepo | null;
  criteria: ApiCriterion[];
  refs: ApiCardRef[];
  /**
   * The cards behind `card.dependsOn` and `card.dependents`, in full. Here
   * rather than looked up on the board, which has no archived cards on it.
   */
  dependencies: { dependsOn: ApiCard[]; dependents: ApiCard[] };
  /**
   * The cards behind `card.suggestedBy` and `card.suggestions`, in full, for
   * the same reason. Archived suggestions are included here, unlike on the
   * board: they were made, and the rail says what became of them.
   */
  suggestions: { suggestedBy: ApiCard | null; suggested: ApiCard[] };
  /** The questions the card's current run asked. Empty when it asked none. */
  questions: ApiQuestion[];
  plan: ApiPlan | null;
  implementation: ApiImplementation | null;
  checks: ApiChecks | null;
  /** Newest first, every kind. The header's "4 runs · $0.184" is counted here. */
  runs: ApiRunSummary[];
  /**
   * What the card's latest run was last doing and thinking, as stored on its
   * row. The live stream only carries what happens after the modal opens, so
   * this is what the band shows until it does. Kept off ApiRunSummary because
   * the board carries one of those per card and never shows a summary.
   */
  thought: Thought | null;
  /** Newest first: the activity tab reads top-down, and so does a person. */
  events: ApiCardEvent[];
  stageHistory: StageHistory;
  worktree: ApiWorktree;
  assets: ApiAsset[];
  differences: ApiDifference[];
  /**
   * A project's tasks that were archived after finishing, by the same rule as
   * `ApiProject.archivedDoneCount`. Here for an archived project too, which is
   * no lane on the board and so has no count there: the Tasks tab reads this
   * once the lane is gone, or a project whose work had all merged would open on
   * nothing. The Done tasks archived with the project are among them; its open
   * tasks went to No project and are not. Always 0 for a task.
   */
  archivedDoneCount: number;
}
