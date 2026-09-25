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

/**
 * There is deliberately no `plan_markdown` here.
 *
 * A prose copy of the plan alongside a structured one is a second source of
 * truth, and the two drift: Claude writes steps in the paragraph that are not
 * in `steps`, and nothing catches it. The server composes `.reeve/plan.md` from
 * these fields instead, which is the same inversion the rest of this file runs
 * on — Claude returns data, the server writes the document.
 *
 * `details` is open rather than a fixed approach/risks pair, because the
 * sections a migration plan needs are not the ones a UI change needs, and a
 * required "Risks" field only teaches Claude to invent a risk.
 */
export const planningOutput = z.object({
  summary: z.string().describe('One or two sentences describing the approach, for the card face.'),
  details: z
    .array(
      z.object({
        heading: z.string().describe('A short title for this section, in Title Case.'),
        body: z
          .string()
          .describe(
            'A paragraph or two of prose, in Markdown: lists, `code` and emphasis render. No headings — `heading` is this section’s heading.',
          ),
      }),
    )
    .describe(
      'The parts of this plan worth saying in prose, as the sections THIS task needs — approach and risks are common, a migration might want a rollback section, a small fix might want one section only. Two to four is usual.',
    ),
  steps: z
    .array(
      z.object({
        title: z.string().describe('What this step does, in one line.'),
        detail: z.string().describe('One sentence on how, or on why it is shaped this way.'),
        files: z.array(z.string()).describe('Repo-relative paths this step creates or modifies.'),
        blocked_on_question: z
          .number()
          .int()
          .nullable()
          .describe(
            'The 1-based number of the open question this step cannot proceed without, counting into your own open_questions array. Null if nothing blocks it.',
          ),
      }),
    )
    .describe('The implementation, in the order you would do it.'),
  open_questions: z
    .array(
      z.object({
        question: z
          .string()
          .describe('Something genuinely ambiguous a human should settle. Ask only what you cannot decide yourself.'),
        suggestions: z
          .array(z.string())
          .describe(
            'Two to four concrete answers a human could pick without typing. Phrase each as the decision itself ("Keep them until removed"), never as another question. A free-text "Other" is always offered, so never include one.',
          ),
      }),
    )
    .describe('Empty if nothing is genuinely ambiguous.'),
  acceptance_criteria: z
    .array(z.string())
    .describe(
      'What must be true for this card to be done, each one independently checkable. These become the checklist Testing verifies, so write them as observations a person could make, not as tasks.',
    ),
  captures: z
    .array(
      z.object({
        label: z.string().describe('What this screenshot shows, e.g. "Cart with saved items".'),
        path: z.string().describe('The app path to visit, e.g. "/cart".'),
        viewport: z.number().int().describe('Viewport width in CSS pixels, e.g. 1280 or 390.'),
      }),
    )
    .describe(
      'States worth a screenshot when this is tested. Only states reachable by URL alone — the capturer navigates and shoots, it does not click through journeys. Empty if this change is not visual.',
    ),
  files_to_touch: z
    .array(z.string())
    .describe('Repo-relative paths you expect to create or modify.'),
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
  criteria: z
    .array(
      z.object({
        index: z.number().int().describe('The criterion\u2019s number, exactly as it was given to you, counting from 1.'),
        verdict: z.enum(['pass', 'fail']).describe('Whether this is true of the build right now.'),
        evidence: z
          .string()
          .describe('How you know: a test name, a screenshot label, a line of output. Not a restatement of the criterion.'),
      }),
    )
    .describe('A verdict on every acceptance criterion you were given. Do not invent or omit numbers.'),
  differences: z
    .array(
      z.object({
        capture_label: z.string().describe('The screenshot this is about, by its label.'),
        claim: z.string().describe('The difference itself, in one sentence a designer would recognise.'),
        note: z.string().describe('Why it is this way, or why it might be fine. One sentence.'),
      }),
    )
    .describe(
      'Where the build and the mockup differ, judged by looking at both images. Report what a person would notice — a control that became a link, spacing that changed the rhythm — not every pixel. Empty if there were no mockups, or if they match.',
    ),
});

export const triageOutput = z.object({
  ranked: z
    .array(
      z.object({
        card_id: z.string().describe('The id exactly as given to you.'),
        rank: z.number().int().describe('1 is highest priority.'),
        rationale: z.string().describe('One sentence on why it sits here.'),
        promote: z.boolean().describe('Whether this is ready to move to Planning.'),
      }),
    )
    .describe('Every backlog card you were given, ranked. Do not invent or omit cards.'),
  notes: z.string().describe('Anything about the backlog as a whole worth saying. May be empty.'),
});

/**
 * Not a stage — a one-shot Claude call behind the brief's Suggest button. It
 * still gets a real run, because it costs money and belongs in the card's
 * history like anything else Claude did.
 */
export const criteriaOutput = z.object({
  criteria: z
    .array(z.string())
    .describe(
      'What must be true for this card to be done, each independently checkable and written as something a person could observe rather than a task to perform.',
    ),
});

/**
 * Not a stage either — the project's split: its brief, broken into cards. Each
 * task names its repo because a project can span several, and the server
 * matches that name rather than trusting Claude with an id.
 */
export const projectSplitOutput = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string().describe('A short imperative title for the card, as it would read on the board.'),
        body: z
          .string()
          .describe('The card’s brief, in Markdown: what this piece of work is for and anything a person picking it up needs to know.'),
        repo: z
          .string()
          .nullable()
          .describe('The name of the repo this task belongs in, exactly as listed. Null for the project’s default repo.'),
        criteria: z
          .array(z.string())
          .describe('What must be true for this task to be done, each written as something a person could observe.'),
      }),
    )
    .describe('The work in the brief as separate cards, in the order it would sensibly be done. Leave out any already listed.'),
});

export type CriteriaOutput = z.infer<typeof criteriaOutput>;
export type ProjectSplitOutput = z.infer<typeof projectSplitOutput>;
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

/**
 * JSON Schema as handed to the SDK's `outputFormat`.
 *
 * The `$schema` key is stripped deliberately. Zod emits a meta-schema ref
 * (`https://json-schema.org/draft/2020-12/schema`) that Claude Code's validator
 * cannot resolve, and it rejects the whole schema with:
 *   `--json-schema is not a valid JSON Schema: no schema with key or ref ...`
 * The run then dies at spawn with exit code 1 before a single token is spent.
 */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' }) as Record<string, unknown>;
  const { $schema: _metaSchemaRef, ...rest } = generated;
  return rest;
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
  jsonSchemaFor(criteriaOutput);
  jsonSchemaFor(projectSplitOutput);
}
