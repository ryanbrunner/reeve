import type { Stage } from './stages.js';
import type { CardActivity } from './activity.js';
import type { RunKind, RunStatus, StopReason } from './runs.js';

/**
 * Wire types. Deliberately plain interfaces rather than Drizzle's inferred row
 * types so this module stays free of server-only imports and the browser bundle
 * never pulls in the ORM. Timestamps are epoch milliseconds.
 */

export interface ApiProject {
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
  stopReason: StopReason | null;
  totalCostUsd: number | null;
  port: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  errorMessage: string | null;
}

export interface ApiCard {
  id: string;
  projectId: string | null;
  projectName: string | null;
  laneColor: string | null;
  title: string;
  body: string;
  stage: Stage;
  position: number;
  branchName: string | null;
  worktreePath: string | null;
  /** Sub-state within the column. Derived from `latestRun`, never stored. */
  activity: CardActivity;
  /**
   * The latest Claude run for the card's CURRENT stage — the same run `activity`
   * is derived from, so the tint and the chip can never disagree. Shell and
   * server runs are excluded on purpose: a dev server left running should not
   * make a card look like Claude is working on it.
   */
  latestRun: ApiRunSummary | null;
  createdAt: number;
  updatedAt: number;
}

export interface BoardResponse {
  projects: ApiProject[];
  cards: ApiCard[];
}

export interface CreateCardBody {
  title: string;
  body?: string;
  projectId?: string | null;
  stage?: Stage;
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
