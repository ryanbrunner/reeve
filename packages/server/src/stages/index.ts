import type { RunnableStage } from '@reeve/shared';
import { inProgressStage } from './in_progress.js';
import { planningStage } from './planning.js';
import { releaseStage } from './release.js';
import { testingStage } from './testing.js';
import type { StageDefinition } from './types.js';

/**
 * Stages are code, not database rows. Adding one means adding a module here.
 *
 * All three runnable stages are implemented now, but the type stays partial:
 * an unimplemented stage answers 501 and degrades to "nothing pending" on the
 * board, which is what let the machinery be built one stage at a time and is
 * still the right behaviour for the next one.
 */
export const STAGE_DEFINITIONS: Partial<Record<RunnableStage, StageDefinition<never>>> = {
  planning: planningStage as unknown as StageDefinition<never>,
  in_progress: inProgressStage as unknown as StageDefinition<never>,
  testing: testingStage as unknown as StageDefinition<never>,
  release: releaseStage as unknown as StageDefinition<never>,
};

export function stageDefinition(stage: RunnableStage): StageDefinition<never> | undefined {
  return STAGE_DEFINITIONS[stage];
}

export * from './types.js';
