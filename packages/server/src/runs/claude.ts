import { query, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EffortLevel, StopReason } from '@reeve/shared';
import { isRunnable, jsonSchemaFor } from '@reeve/shared';
import type { Db } from '../db/client.js';
import {
  artifactsForCard,
  criteriaFor,
  getSettings,
  insertCardEvent,
  insertRun,
  setRunStatus,
  unreadNotesFor,
} from '../db/queries.js';
import { artifact as artifactTable, type Card, type CardStage, type Project } from '../db/schema.js';
import type { ClaudeTask, StageContext } from '../stages/types.js';
import type { EventWriter } from './events.js';
import { capabilitiesFor } from './models.js';
import { runRegistry } from './registry.js';

/** Thrown into the for-await loop by abortController.abort(). Verified by spike. */
const ABORT_MARKER = 'aborted by user';

export interface ClaudeRunParams {
  db: Db;
  writer: EventWriter;
  card: Card;
  project: Project;
  stage: ClaudeTask<never>;
  /**
   * Which column to record the run against. Defaults to the task's own id,
   * which for a stage is the same thing; a one-off task attaches to wherever
   * the card happens to be sitting.
   */
  runStage?: CardStage;
  worktreePath: string;
  reviewNotes?: string | null;
  /** Answers to the questions the forked run asked. See StageContext.answers. */
  answers?: Array<{ question: string; answer: string }>;
  /** Set for a revision: the prior run's session is forked, not continued. */
  resumeSessionId?: string | null;
  parentRunId?: string | null;
}

export interface ClaudeRunHandle {
  runId: string;
  sessionId: string;
  done: Promise<void>;
}

/** interrupt() needs streaming input, and it is the precondition for any control request. */
async function* singleMessage(text: string): AsyncIterable<SDKUserMessage> {
  yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: text } };
}

/**
 * Narrow only the handful of message types we render. The SDKMessage union is
 * ~40 members and grows every release, so an unknown type is stored with its raw
 * payload and skipped for display — never thrown on.
 */
function classify(m: SDKMessage): string {
  switch (m.type) {
    case 'result':
      return 'result';
    case 'assistant':
      return 'assistant';
    case 'user':
      return 'tool_result';
    case 'system':
      return `system:${(m as { subtype?: string }).subtype ?? 'unknown'}`;
    default:
      return `unknown:${(m as { type?: string }).type ?? 'untyped'}`;
  }
}

function stopReasonForSubtype(subtype: string): StopReason {
  switch (subtype) {
    case 'error_max_budget_usd':
      return 'budget_exhausted';
    case 'error_max_turns':
      return 'max_turns';
    case 'error_max_structured_output_retries':
      return 'invalid_output';
    default:
      return 'sdk_error';
  }
}

/**
 * What Claude is told about a card: its brief, its criteria, what earlier
 * stages produced and what the human has said since. One function so that a
 * stage run and a handoff to the CLI cannot drift into telling it different
 * things.
 *
 * `excludeStage` drops that stage's own artifacts. A run leaves them out, since
 * it is about to replace them; a handoff keeps them, since the person taking
 * over wants the latest of everything.
 */
export function stageContextFor(
  db: Db,
  base: Pick<StageContext, 'card' | 'project' | 'worktreePath' | 'reviewNotes' | 'answers'>,
  excludeStage?: CardStage,
): StageContext {
  return {
    ...base,
    // What earlier stages produced, newest first. In Progress reads the plan
    // this way; Planning has nothing before it and ignores the list.
    priorArtifacts: artifactsForCard(db, base.card.id)
      .filter((a) => a.stage !== excludeStage && a.supersededBy === null)
      .map((a) => ({ kind: a.kind, content: a.content })),
    criteria: criteriaFor(db, base.card.id).map((c) => c.text),
    notes: unreadNotesFor(db, base.card.id),
  };
}

/**
 * The model and effort a run asks for: the card's override, then the Settings
 * default for the stage, then the stage module's own. Each is resolved on its
 * own, so a card that pins only a model still takes its effort from below.
 *
 * Out-of-band work keeps the task's values untouched. Suggest is not the
 * card's work, and a card pinned to Opus at max should not make it expensive.
 */
export function modelAndEffortFor(
  db: Db,
  card: Card,
  stage: Pick<ClaudeTask, 'model' | 'effort' | 'outOfBand'>,
  runStage: CardStage,
): { model: string | null; effort: EffortLevel | null } {
  if (stage.outOfBand) return { model: stage.model ?? null, effort: stage.effort ?? null };
  const defaults = isRunnable(runStage) ? getSettings(db).stageDefaults[runStage] : undefined;
  return {
    model: card.model ?? defaults?.model ?? stage.model ?? null,
    effort: card.effort ?? defaults?.effort ?? stage.effort ?? null,
  };
}

/**
 * Trims what was asked for to what the model takes, so a setting it rejects
 * never reaches it. Only a pinned model the CLI listed is checked: no model is
 * the CLI's default, which takes everything the stages ask for, and a model the
 * CLI did not list is sent as asked. A capability the CLI did not report is
 * assumed — the same reading the pickers give it.
 */
async function fitToModel(
  model: string | null,
  effort: EffortLevel | null,
): Promise<{ effort: EffortLevel | null; adaptiveThinking: boolean }> {
  const caps = model ? await capabilitiesFor(model) : undefined;
  if (!caps) return { effort, adaptiveThinking: true };
  const takesEffort =
    effort !== null && caps.supportsEffort !== false && (caps.supportedEffortLevels?.includes(effort) ?? true);
  return { effort: takesEffort ? effort : null, adaptiveThinking: caps.supportsAdaptiveThinking !== false };
}

export function startClaudeRun(params: ClaudeRunParams): ClaudeRunHandle {
  const { db, writer, card, project, stage, worktreePath, reviewNotes, answers, resumeSessionId, parentRunId } = params;
  const runStage = params.runStage ?? (stage.id as CardStage);
  const { model, effort } = modelAndEffortFor(db, card, stage, runStage);

  // Read before `run_started` is written: that event is where unread notes end,
  // so gathering after it would hand this run none of them.
  const ctx = stageContextFor(db, {
    card, project, worktreePath,
    reviewNotes: reviewNotes ?? null,
    answers: answers ?? [],
  }, runStage);
  // Generated here and stored BEFORE the subprocess exists, so an orphaned run
  // is still resumable after a restart.
  const sessionId = crypto.randomUUID();

  const run = insertRun(db, {
    id: crypto.randomUUID(),
    cardId: card.id,
    kind: 'claude',
    stage: runStage,
    status: 'running',
    task: stage.outOfBand ? stage.id : null,
    sessionId,
    parentRunId: parentRunId ?? null,
    forkedFromSessionId: resumeSessionId ?? null,
    model,
    // What was asked for. Corrected below if the model turns out not to take it,
    // so the row always says what was actually sent.
    effort,
    permissionMode: stage.permissionMode,
    maxBudgetUsd: stage.maxBudgetUsd,
    // Filled in once the prompt exists. A stage that has to prepare something
    // first — Testing takes its screenshots — writes the prompt after that, so
    // the row is briefly a run with no prompt, exactly as it is briefly a run
    // with no process.
    prompt: null,
    cwd: worktreePath,
    startedAt: new Date(),
  });
  const runId = run.id;
  insertCardEvent(db, {
    cardId: card.id,
    actor: 'claude',
    kind: 'run_started',
    stage: runStage,
    runId,
    // A revision is a second attempt at the same thing, and reads differently.
    meta: { revision: Boolean(resumeSessionId) },
  });

  const abortController = new AbortController();
  let cancelled = false;

  const options: Omit<Options, 'prompt'> = {
    cwd: worktreePath,
    abortController,
    // sessionId cannot combine with resume unless forkSession is also set, so a
    // revision forks: the prior transcript stays immutable and the card's
    // history reads as a list of attempts rather than one mutating session.
    ...(resumeSessionId ? { resume: resumeSessionId, forkSession: true } : {}),
    sessionId,
    permissionMode: stage.permissionMode,
    // Nobody is watching to approve anything. Without this the run parks forever
    // on the first tool call that isn't pre-approved.
    permissionPrompts: 'none',
    allowedTools: stage.allowedTools,
    maxBudgetUsd: stage.maxBudgetUsd,
    ...(stage.maxTurns ? { maxTurns: stage.maxTurns } : {}),
    ...(model ? { model } : {}),
    outputFormat: { type: 'json_schema', schema: jsonSchemaFor(stage.schema) },
  };

  const done = (async () => {
    let result: Extract<SDKMessage, { type: 'result' }> | null = null;
    try {
      const fitted = await fitToModel(model, effort);
      if (fitted.effort !== effort) setRunStatus(db, runId, { effort: fitted.effort });
      if (fitted.effort) options.effort = fitted.effort;
      // The card modal shows what Claude is reasoning about. Left to default,
      // adaptive thinking omits the text and stores an empty block with only a
      // signature. A model without adaptive thinking is left to its own default
      // rather than sent a mode it would refuse.
      if (fitted.adaptiveThinking) options.thinking = { type: 'adaptive', display: 'summarized' };

      // Anything the prompt needs that does not exist yet. A stage without a
      // `prepare` contributes nothing and this is one await of undefined.
      const prepared = (await stage.prepare?.(db, writer, ctx, runId)) ?? {};
      const promptText = stage.buildPrompt(ctx, prepared);
      setRunStatus(db, runId, { prompt: promptText });

      const q = query({ prompt: singleMessage(promptText), options });
      runRegistry.register({
        runId,
        cardId: card.id,
        kind: 'claude',
        outOfBand: stage.outOfBand ?? false,
        stop: async () => {
          cancelled = true;
          setRunStatus(db, runId, { status: 'stopping' });
          // abort() is the mechanism. interrupt() rejected on every spike
          // attempt with "Query closed before response received", so it is a
          // best-effort nicety only and must never be awaited bare.
          void q.interrupt?.().catch(() => {});
          abortController.abort();
          await done;
        },
      });

      for await (const message of q) {
        writer.append(runId, classify(message), message, (message as { uuid?: string }).uuid ?? null);
        if (message.type === 'result') result = message;
      }
    } catch (err) {
      const text = String(err);
      if (cancelled || text.includes(ABORT_MARKER)) {
        finish(db, writer, runId, 'cancelled', 'cancelled_by_user', null, result);
        return;
      }
      writer.append(runId, 'error', { message: text });
      finish(db, writer, runId, 'failed', 'sdk_error', text.slice(0, 500), result);
      return;
    } finally {
      runRegistry.unregister(runId);
    }

    // Cancellation is decided by harness state, never by the result message: an
    // aborted run was measured reporting subtype=success, terminal_reason=completed.
    if (cancelled) {
      finish(db, writer, runId, 'cancelled', 'cancelled_by_user', null, result);
      return;
    }
    if (!result) {
      finish(db, writer, runId, 'failed', 'sdk_error', 'stream ended with no result message', null);
      return;
    }
    if (result.subtype !== 'success') {
      const reason = stopReasonForSubtype(result.subtype);
      finish(db, writer, runId, 'failed', reason, `run ended: ${result.subtype}`, result);
      return;
    }

    const parsed = stage.schema.safeParse((result as { structured_output?: unknown }).structured_output);
    if (!parsed.success) {
      // Keep the raw output regardless — a malformed run is still evidence.
      finish(db, writer, runId, 'failed', 'invalid_output', parsed.error.message.slice(0, 500), result);
      return;
    }

    materialiseArtifacts(db, card, worktreePath, runId, stage, ctx, parsed.data, runStage);
    // Files first, then rows, then the run is marked done — so nothing can read
    // a succeeded run whose plan or questions have not landed yet.
    stage.onPersist?.(db, ctx, parsed.data, runId);
    finish(db, writer, runId, 'succeeded', 'completed', null, result);
  })();

  return { runId, sessionId, done };
}

function materialiseArtifacts(
  db: Db,
  card: Card,
  worktreePath: string,
  runId: string,
  stage: ClaudeTask<never>,
  ctx: StageContext,
  output: never,
  runStage: CardStage,
): void {
  for (const draft of stage.onComplete(ctx, output)) {
    // The server writes the file. Claude only returned data, which is what lets
    // the Planning stage hold no write tools at all.
    if (draft.path) {
      const full = join(worktreePath, draft.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, draft.content, 'utf8');
    }
    db.insert(artifactTable)
      .values({
        id: crypto.randomUUID(),
        cardId: card.id,
        runId,
        stage: runStage,
        kind: draft.kind,
        path: draft.path ?? null,
        content: draft.content,
      })
      .run();
  }
}

function finish(
  db: Db,
  writer: EventWriter,
  runId: string,
  status: 'succeeded' | 'failed' | 'cancelled',
  stopReason: StopReason,
  errorMessage: string | null,
  result: Extract<SDKMessage, { type: 'result' }> | null,
): void {
  writer.finish(runId);
  const r = result as null | {
    total_cost_usd?: number; num_turns?: number; usage?: unknown; modelUsage?: unknown;
    result?: string; structured_output?: unknown; permission_denials?: unknown;
    stop_reason?: string | null; terminal_reason?: string;
  };
  const finished = setRunStatus(db, runId, {
    status,
    stopReason,
    errorMessage,
    finishedAt: new Date(),
    totalCostUsd: r?.total_cost_usd ?? null,
    numTurns: r?.num_turns ?? null,
    usageJson: (r?.usage as Record<string, unknown>) ?? null,
    modelUsageJson: (r?.modelUsage as Record<string, unknown>) ?? null,
    resultText: r?.result ?? null,
    structuredOutput: r?.structured_output ?? null,
    permissionDenials: (r?.permission_denials as unknown[]) ?? null,
    sdkStopReason: r?.stop_reason ?? null,
    sdkTerminalReason: r?.terminal_reason ?? null,
  });
  // Every exit path lands here, so the timeline gets its closing entry from one
  // place and cannot end up with a start that never finished.
  if (finished) {
    insertCardEvent(db, {
      cardId: finished.cardId,
      actor: 'claude',
      kind: 'run_finished',
      stage: finished.stage,
      runId,
      body: errorMessage,
      meta: {
        status,
        stopReason,
        costUsd: finished.totalCostUsd,
        durationMs:
          finished.startedAt && finished.finishedAt
            ? finished.finishedAt.getTime() - finished.startedAt.getTime()
            : null,
      },
    });
  }
}
