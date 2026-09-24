import { z } from 'zod';
import type { RunnableStage } from './stages.js';

/**
 * Claude-facing schemas.
 *
 * Constrained to the string/number/boolean/enum/array/object subset on purpose:
 * `z.toJSONSchema()` throws on `z.date()`, `z.bigint()` and `.transform()`, and a
 * schema that throws at conversion time would fail a run rather than the build.
 * `assertConvertible()` below converts every one at boot so a bad schema is a
 * startup failure instead.
 *
 * Claude returns DATA; the server writes the artifacts. That inversion is what
 * lets Planning run with no write tools at all.
 */

export const planningOutput = z.object({
  plan_markdown: z
    .string()
    .describe('The full implementation plan as markdown. This is the document the human reviews.'),
  summary: z.string().describe('One or two sentences describing the approach, for the card face.'),
  files_to_touch: z
    .array(z.string())
    .describe('Repo-relative paths you expect to create or modify.'),
  open_questions: z
    .array(z.string())
    .describe('Anything genuinely ambiguous that a human should settle before implementation. Empty if none.'),
  risk: z.enum(['low', 'medium', 'high']).describe('How likely this is to go wrong or need rework.'),
});

export const implementationOutput = z.object({
  summary: z.string().describe('What you actually built, in a few sentences.'),
  commits: z.array(z.string()).describe('Commit subjects you created, oldest first.'),
  files_changed: z.array(z.string()).describe('Repo-relative paths you created, modified or deleted.'),
  deviations_from_plan: z
    .array(z.string())
    .describe('Where you departed from the approved plan and why. Empty if you followed it exactly.'),
  follow_ups: z.array(z.string()).describe('Work you deliberately left undone. Empty if none.'),
});

export const testingOutput = z.object({
  passed: z.boolean().describe('True only if the suite ends green.'),
  summary: z.string().describe('What you ran and what happened.'),
  failures: z
    .array(
      z.object({
        test: z.string().describe('Test name or file.'),
        reason: z.string().describe('Why it failed, in one line.'),
        fixed: z.boolean().describe('Whether you fixed it in this run.'),
      }),
    )
    .describe('Failures encountered. Empty if the suite was green first time.'),
  fixes_applied: z.array(z.string()).describe('Changes you made to get to green. Empty if none.'),
});

export const triageOutput = z.object({
  ranked: z
    .array(
      z.object({
        card_id: z.string().describe('The id exactly as given to you.'),
        rank: z.number().int().describe('1 is highest priority.'),
        rationale: z.string().describe('One sentence on why it sits here.'),
        promote: z.boolean().describe('Whether this is ready to move to Ready for Planning.'),
      }),
    )
    .describe('Every backlog card you were given, ranked. Do not invent or omit cards.'),
  notes: z.string().describe('Anything about the backlog as a whole worth saying. May be empty.'),
});

export type PlanningOutput = z.infer<typeof planningOutput>;
export type ImplementationOutput = z.infer<typeof implementationOutput>;
export type TestingOutput = z.infer<typeof testingOutput>;
export type TriageOutput = z.infer<typeof triageOutput>;

export const STAGE_CONTRACTS = {
  planning: planningOutput,
  in_progress: implementationOutput,
  testing: testingOutput,
} as const satisfies Record<RunnableStage, z.ZodType>;

export type StageOutput = {
  planning: PlanningOutput;
  in_progress: ImplementationOutput;
  testing: TestingOutput;
};

/** JSON Schema as handed to the SDK's `outputFormat`. */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' }) as Record<string, unknown>;
}

/**
 * Convert every Claude-facing schema once at startup. A schema containing a type
 * JSON Schema can't express should crash the server on boot, not a run at 2am.
 */
export function assertContractsConvertible(): void {
  for (const [stage, schema] of Object.entries(STAGE_CONTRACTS)) {
    try {
      jsonSchemaFor(schema);
    } catch (cause) {
      throw new Error(`Stage contract "${stage}" cannot convert to JSON Schema`, { cause });
    }
  }
  jsonSchemaFor(triageOutput);
}
