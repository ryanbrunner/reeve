import type { z } from 'zod';
import type { RunnableStage } from '@reeve/shared';
import type { Db } from '../db/client.js';
import type { Card, Project } from '../db/schema.js';

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface StageContext {
  card: Card;
  project: Project;
  worktreePath: string;
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
}

export interface ArtifactDraft {
  kind: 'plan' | 'diff' | 'test_report' | 'summary';
  content: string;
  /** Relative to the worktree. The server writes it; Claude never does. */
  path?: string;
}

export interface StageDefinition<Output = unknown> {
  id: RunnableStage;
  schema: z.ZodType<Output>;
  buildPrompt(ctx: StageContext): string;
  permissionMode: PermissionMode;
  allowedTools: string[];
  maxBudgetUsd: number;
  maxTurns?: number;
  model?: string;
  effort?: EffortLevel;
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
   * Does this output leave a question for the human rather than finished work?
   * Drives the yellow card face. Omitted means "never asks" — a succeeded run
   * then reads as ready for review.
   */
  awaitsInput?(output: Output): boolean;
  /** One-line card summary from the output. */
  summarise(output: Output): string;
}
