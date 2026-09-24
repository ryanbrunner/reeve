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
