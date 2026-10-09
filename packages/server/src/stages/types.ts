import type { z } from 'zod';
import type { EffortLevel, RunnableStage } from '@reeve/shared';
import type { Db } from '../db/client.js';
import type { EventWriter } from '../runs/events.js';
import type { Card, Repo } from '../db/schema.js';

/** What a run's row records it was sent. Always `auto` for new runs; older rows say otherwise. */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
export type { EffortLevel };

export interface StageContext {
  card: Card;
  repo: Repo;
  worktreePath: string;
  /**
   * The card's body as the prompt should carry it: pasted images pointed at
   * their files, and a line saying so when there is nothing. What every stage
   * puts where the brief goes, rather than `card.body`.
   */
  brief: string;
  /** Present when the human rejected the previous attempt with notes. */
  reviewNotes?: string | null;
  /**
   * Answers to the questions the previous attempt asked. The sibling of
   * `reviewNotes`: both are the human talking back, and both reach Claude
   * through the prompt of a forked run rather than a new channel.
   */
  answers?: Array<{ question: string; answer: string }>;
  /** Prior stage output this stage should build on, e.g. the approved plan. */
  priorArtifacts?: Array<{ kind: string; content: string }>;
  /** The card's acceptance criteria, in order. Testing is handed these to check. */
  criteria?: string[];
  /**
   * Notes a person left on the card since the last run. The third thing the
   * human can say to Claude, beside a rejection and an answer, and it reaches
   * the run the same way all three do: as prompt.
   */
  notes?: string[];
  /**
   * Whether Settings allows this run to suggest cards of its own. Undefined
   * means on, the same reading `getSettings` gives a board with no row yet, so
   * a hand-built context (a spike) that never sets it behaves as it always did.
   */
  suggestTasks?: boolean;
}

export interface ArtifactDraft {
  kind: 'plan' | 'diff' | 'test_report' | 'summary' | 'release';
  content: string;
  /** Relative to the worktree. The server writes it; Claude never does. */
  path?: string;
}

/**
 * One thing Claude can be asked to do, with everything the runner needs to ask
 * it: a schema, a prompt, a budget, and what to do with the answer.
 *
 * Split out from `StageDefinition` because not everything Claude does is a
 * stage. The brief's Suggest button is a real run — it costs money and belongs
 * in the card's history — but it is not a column on the board, and it can
 * happen to a card sitting in Backlog.
 */
export interface ClaudeTask<Output = unknown> {
  /** Names the task. For a stage this is the stage it runs. */
  id: string;
  schema: z.ZodType<Output>;
  buildPrompt(ctx: StageContext, prepared?: Record<string, string>): string;
  // No permission mode and no tool list: every task asks to run in auto mode
  // (runs/claude.ts), and what a task should and should not do is its prompt's
  // to say.
  maxBudgetUsd: number;
  maxTurns?: number;
  model?: string;
  effort?: EffortLevel;
  /**
   * Work done beside the card's stage rather than as it. The run is tagged with
   * the task's id, so it stays in the card's history and cost but never becomes
   * the card's current run: it does not tint the board, answer the review gate,
   * or hold the card's run lock. Said explicitly rather than inferred from the
   * id differing from the column, so a stage can never drop out by accident.
   */
  outOfBand?: boolean;
  /**
   * Directories beyond the one the run is in that Claude may read. A project's
   * split reads every repo, since its tasks can land in any of them.
   */
  directories?(db: Db): string[];
  /**
   * Work the server does before the prompt is built, when the prompt needs
   * something that does not exist yet — Testing photographs the build here, so
   * `buildPrompt` can hand Claude the file paths of the pictures.
   *
   * Runs inside the run's own async body, after the run row exists, so a slow
   * preparation shows on the board as a card already working rather than a
   * request that hangs. Whatever it returns is merged into the template vars.
   */
  prepare?(db: Db, writer: EventWriter, ctx: StageContext, runId: string): Promise<Record<string, string>>;
  /** Turn validated output into artifacts. The server materialises them. */
  onComplete(ctx: StageContext, output: Output): ArtifactDraft[];
  /**
   * Turn validated output into rows: questions, criteria, verdicts.
   *
   * The sibling of `onComplete` — that one writes files, this one writes the
   * database — and the reason `claude.ts` has no switch on stage. Runs after
   * the run row is final, so `runId` is safe to reference.
   */
  onPersist?(db: Db, ctx: StageContext, output: Output, runId: string): void;
  /**
   * The slow half of `onPersist`, for work that has to wait on something —
   * Planning renders its mockups here. Awaited after `onPersist` and before
   * the run is marked succeeded, so nothing reads a finished run whose files
   * are still coming. A throw is written to the run's events and the run
   * succeeds anyway: the output it is persisting is already valid.
   */
  onPersistAsync?(db: Db, writer: EventWriter, ctx: StageContext, output: Output, runId: string): Promise<void>;
  /**
   * Does this output leave a question for the human rather than finished work?
   * Drives the yellow card face. Omitted means "never asks" — a succeeded run
   * then reads as ready for review.
   */
  awaitsInput?(output: Output): boolean;
  /** One-line card summary from the output. */
  summarise(output: Output): string;
  /**
   * Present on a task held as a conversation — the stages. Its output is
   * delivered by Claude calling a `submit_<id>` tool, whose input is `schema`,
   * when it decides the work is done, rather than demanded as structured
   * output at the end of every turn: a turn may instead end in a question or
   * a reply, and the person answers. Absent, the task keeps `outputFormat`
   * and is one turn, as the one-off tasks are.
   */
  submit?: {
    /** What the tool is for, in the words Claude reads beside its name. */
    description: string;
  };
}

/** A task that is also a column on the board, and so can be reviewed and moved on from. */
export interface StageDefinition<Output = unknown> extends ClaudeTask<Output> {
  id: RunnableStage;
}
