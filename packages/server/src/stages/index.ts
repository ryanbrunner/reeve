import type { RunnableStage } from '@reeve/shared';
import { planningStage } from './planning.js';
import type { StageDefinition } from './types.js';

/**
 * Stages are code, not database rows. Adding one means adding a module here —
 * `in_progress` and `testing` land in later steps.
 */
export const STAGE_DEFINITIONS: Partial<Record<RunnableStage, StageDefinition<never>>> = {
  planning: planningStage as unknown as StageDefinition<never>,
};

export function stageDefinition(stage: RunnableStage): StageDefinition<never> | undefined {
  return STAGE_DEFINITIONS[stage];
}

export * from './types.js';
