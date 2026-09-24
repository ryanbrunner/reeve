import type { z } from 'zod';
import type { RunnableStage } from '@reeve/shared';
import type { Card, Project } from '../db/schema.js';

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface StageContext {
  card: Card;
  project: Project;
  worktreePath: string;
  /** Present when the human rejected the previous attempt with notes. */
  reviewNotes?: string | null;
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
  /** One-line card summary from the output. */
  summarise(output: Output): string;
}
