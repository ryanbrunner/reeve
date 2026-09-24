import type { Stage } from './stages.js';

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
  | 'note';

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
