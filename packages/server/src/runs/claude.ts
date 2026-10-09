import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type PermissionResult,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EffortLevel, MessageSource, StopReason, Thought, TranscriptMessage } from '@reeve/shared';
import { describeParsed, isRunnable, jsonSchemaFor, nextThought } from '@reeve/shared';
import { PASTED_IMAGE, absoluteAssetPath, assetSrc } from '../assets/store.js';
import type { Db } from '../db/client.js';
import {
  artifactsForCard,
  criteriaFor,
  getAsset,
  getCard,
  getRun,
  getSettings,
  insertCardEvent,
  insertRun,
  inVibes,
  setRunStatus,
  unreadNotesFor,
} from '../db/queries.js';
import { artifact as artifactTable, type Card, type CardEventActor, type CardStage, type Repo } from '../db/schema.js';
import { config } from '../config.js';
import type { ClaudeTask, PermissionMode, StageContext } from '../stages/types.js';
import { renderPrompt } from '../stages/template.js';
import { recordRateLimit } from '../usage.js';
import type { EventWriter } from './events.js';
import { capabilitiesFor } from './models.js';
import { askRegistry, type AskAnswer, type AskQuestion, type AskRequest } from './asks.js';
import { Inbox } from './inbox.js';
import { decideToolUse, denialRecorder, liveDatabaseGuard, mergeGuard, personDenial } from './permissions.js';
import { runRegistry } from './registry.js';

/** Thrown into the for-await loop by abortController.abort(). Verified by spike. */
const ABORT_MARKER = 'aborted by user';

export interface ClaudeRunParams {
  db: Db;
  writer: EventWriter;
  card: Card;
  repo: Repo;
  stage: ClaudeTask<never>;
  /**
   * Which column to record the run against. Defaults to the task's own id,
   * which for a stage is the same thing; a one-off task attaches to wherever
   * the card happens to be sitting.
   */
  runStage?: CardStage;
  worktreePath: string;
  /** Set for a follow-up: the prior run's session is forked, not continued. */
  resumeSessionId?: string | null;
  parentRunId?: string | null;
  /**
   * For a run that carries a conversation on: what Claude is sent, in place
   * of the stage's whole prompt, which the forked session already has. Built
   * by conversation.ts from what the person said.
   */
  followUp?: string | null;
  /** What the person said, as the conversation shows it: written as the run's first event. */
  userMessage?: UserMessage | null;
}

/** Who can put words into a stage's conversation, and how they got there. */
export type { MessageSource };

/** A `user_message` run event's payload. */
export interface UserMessage {
  text: string;
  actor: CardEventActor;
  source: MessageSource;
  /** Interjected into a live turn rather than starting one. */
  live?: boolean;
}

export interface ClaudeRunHandle {
  runId: string;
  sessionId: string;
  done: Promise<void>;
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
    // A tool's result comes back as a user message; so does the SDK echoing
    // a message we sent it. Only the first is a tool result, and telling them
    // apart here keeps the conversation from showing a person's words twice.
    case 'user': {
      const content = (m as { message?: { content?: unknown } }).message?.content;
      const toolResult = Array.isArray(content) && content.some((b: { type?: string }) => b.type === 'tool_result');
      return toolResult ? 'tool_result' : 'user_echo';
    }
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
  base: Pick<StageContext, 'card' | 'repo' | 'worktreePath' | 'reviewNotes' | 'answers'>,
  excludeStage?: CardStage,
): StageContext {
  return {
    ...base,
    brief: briefFor(db, base.card),
    // What earlier stages produced, newest first. In Progress reads the plan
    // this way; Planning has nothing before it and ignores the list.
    priorArtifacts: artifactsForCard(db, base.card.id)
      .filter((a) => a.stage !== excludeStage && a.supersededBy === null)
      .map((a) => ({ kind: a.kind, content: a.content })),
    criteria: criteriaFor(db, base.card.id).map((c) => c.text),
    notes: unreadNotesFor(db, base.card.id),
    suggestTasks: getSettings(db).suggestTasks,
  };
}

/**
 * The card's body as Claude reads it. A pasted image is linked by its route,
 * which means nothing to a run with no browser, so the brief is followed by
 * where each one's file is — the same absolute path In Progress is handed a
 * mockup by, and something Read can open.
 *
 * Listed after the body rather than swapped into it: a split copies a
 * project's brief into its tasks, and what it copies has to be the route, or
 * the board could no longer show the picture. Looked up by row for the same
 * reason, since those tasks are not the card whose folder holds the file.
 */
function briefFor(db: Db, card: Card): string {
  const body = card.body.trim();
  if (!body) return '_No further detail was given._';
  const files = new Map<string, string>();
  for (const [, , id] of body.matchAll(PASTED_IMAGE)) {
    const row = id ? getAsset(db, id) : undefined;
    if (row) files.set(assetSrc(row.id), absoluteAssetPath(row.path));
  }
  if (!files.size) return body;
  const list = [...files].map(([src, path]) => `- \`${src}\` is \`${path}\``).join('\n');
  return `${body}\n\nThe images in this brief are files on this machine, which Read can open:\n\n${list}`;
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
 * The permission mode every run asks for. The classifier decides what a run
 * may do, as it does in Claude Code's auto mode, and each stage's prompt says
 * what it should do; see runs/permissions.ts for what is left for us to
 * answer. Not every pinned model takes it — see `fitToModel`, below, for the
 * one that is left to run without it instead.
 */
const PERMISSION_MODE = 'auto' satisfies PermissionMode;

/**
 * Thrown when a session's own init message reports a mode other than the one
 * actually asked for.
 *
 * Refused rather than carried on, because that mismatch means something
 * outside this run's control — an account setting, `disableAutoMode` — turned
 * auto mode off after we asked for it: not the expected fallback for a model
 * that never claimed to support it. The message is what the card shows.
 */
class AutoModeUnavailable extends Error {}

/**
 * Trims what was asked for to what the model takes, so a setting it rejects
 * never reaches it. Only a pinned model the CLI listed is checked: no model is
 * the CLI's default, which takes everything the stages ask for, and a model the
 * CLI did not list is sent as asked. A capability the CLI did not report is
 * assumed — the same reading the pickers give it — for every field except
 * `supportsAutoMode`.
 *
 * That one field is read the other way around: only an explicit `true` keeps
 * `permissionMode: 'auto'` in the request. Haiku is why — the CLI lists it
 * with no `supportsAutoMode` at all, the same as its other capability fields,
 * and a session asked to run it in auto mode reports back `default` in its
 * own `init` message; "not reported" means "doesn't take it" for this model,
 * not "take everything" the way an unreported effort level does. Checked by
 * spike, since it is exactly the gap between what the CLI lists and what a
 * session actually does that this function exists to close.
 *
 * Auto mode is trimmed the same way as effort and adaptive thinking once that
 * is decided: a model that doesn't take it runs anyway, just without
 * `permissionMode` sent to it, so it starts in its own default mode instead of
 * the run being refused.
 */
// Exported, and the lookup injectable, only so a spike can hand it a model the
// CLI itself does not list with a working `supportsAutoMode` today — nothing
// in production calls it with a second argument.
export async function fitToModel(
  model: string | null,
  effort: EffortLevel | null,
  lookup: typeof capabilitiesFor = capabilitiesFor,
): Promise<{ effort: EffortLevel | null; adaptiveThinking: boolean; autoMode: boolean }> {
  const caps = model ? await lookup(model) : undefined;
  if (!caps) return { effort, adaptiveThinking: true, autoMode: true };
  const takesEffort =
    effort !== null && caps.supportsEffort !== false && (caps.supportedEffortLevels?.includes(effort) ?? true);
  return {
    effort: takesEffort ? effort : null,
    adaptiveThinking: caps.supportsAdaptiveThinking !== false,
    autoMode: caps.supportsAutoMode === true,
  };
}

export function startClaudeRun(params: ClaudeRunParams): ClaudeRunHandle {
  const { db, writer, card, repo, stage, worktreePath, resumeSessionId, parentRunId } = params;
  const runStage = params.runStage ?? (stage.id as CardStage);
  const { model, effort } = modelAndEffortFor(db, card, stage, runStage);
  const followUp = params.followUp?.trim() ? params.followUp : null;

  // Read before `run_started` is written: that event is where unread notes end,
  // so gathering after it would hand this run none of them.
  const ctx = stageContextFor(db, {
    card, repo, worktreePath,
    reviewNotes: null,
    answers: [],
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
    // so the row always says what was actually sent. permissionMode is filled in
    // the same way, once fitToModel says whether this model takes auto mode.
    effort,
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
    meta: { revision: Boolean(resumeSessionId), followUp: Boolean(followUp) },
  });
  // The person's words open the run they started, so the conversation reads
  // in order without joining anything.
  if (params.userMessage) writer.append(runId, 'user_message', { ...params.userMessage, at: Date.now() });

  const abortController = new AbortController();
  let cancelled = false;
  // Denials are written to the row as they happen rather than only at the end,
  // so a killed run still says what it was refused — and so the card can show
  // it while the run is still going.
  const denials = denialRecorder();
  // Recorded where it is decided. A denial we make ourselves, in the callback
  // or the hook, never reaches the stream as an event, so this is the only
  // place it can be caught.
  const refuse = (toolName: string, input: Record<string, unknown>, toolUseId: string) => {
    const refused = denials.refused(toolName, input, toolUseId);
    if (refused) setRunStatus(db, runId, { permissionDenials: refused });
  };

  // Settled by fitToModel before the session starts, and read by canUseTool:
  // only an auto-mode session asks a person about an escalation. One in its
  // own default mode would ask about every edit.
  let autoMode = false;

  /**
   * Hold the turn on a person: the run reads `asking` until they answer, the
   * request times out, or the run is stopped. The request and its answer go
   * into the run's events, which is where the conversation shows them.
   */
  const askPerson = async (request: AskRequest, toolUseId: string): Promise<AskAnswer> => {
    const { ask, answer } = askRegistry.wait(runId, card.id, request, config.askTimeoutMs);
    writer.append(runId, 'ask', { ...ask, toolUseId });
    writer.flush();
    setRunStatus(db, runId, { status: 'asking' });
    const settled = await answer;
    writer.append(runId, 'ask_answered', { askId: ask.id, ...settled, at: Date.now() });
    if (!cancelled) setRunStatus(db, runId, { status: 'running' });
    return settled;
  };

  /** Nobody near the board to ask: the board's switch, or this card's own. */
  const unwatched = () => {
    const fresh = getCard(db, card.id);
    return getSettings(db).vibesSince !== null || (fresh ? inVibes(db, fresh) : false);
  };

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
    toolUseID: string,
  ): Promise<PermissionResult> => {
    // A question, not a permission: answered, by a person or for them, and
    // never refused just for being asked.
    if (toolName === 'AskUserQuestion') {
      const questions = questionsIn(input);
      if (unwatched()) {
        // Its own first option, as VIBES MODE answers a plan's questions.
        const answers = Object.fromEntries(questions.map((q) => [q.question, q.options[0]?.label ?? 'Your call.']));
        writer.append(runId, 'ask_answered', { kind: 'question', answers, actor: 'claude', at: Date.now(), vibes: true });
        return { behavior: 'allow', updatedInput: { ...input, answers } };
      }
      const settled = await askPerson({ kind: 'question', questions }, toolUseID);
      if (settled.kind === 'question') return { behavior: 'allow', updatedInput: { ...input, answers: settled.answers } };
      return {
        behavior: 'deny',
        message:
          'Nobody answered that in time. Do what does not depend on it; if the rest does, ask it in plain text ' +
          'at the end of your turn instead, and the person will reply when they are back.',
      };
    }

    if (!autoMode || unwatched()) {
      refuse(toolName, input, toolUseID);
      return decideToolUse({ toolName, input });
    }
    const settled = await askPerson({ kind: 'permission', toolName, input }, toolUseID);
    if (settled.kind === 'permission' && settled.allow) return { behavior: 'allow', updatedInput: input };
    refuse(toolName, input, toolUseID);
    if (settled.kind === 'permission') return personDenial({ toolName, input }, settled.reason);
    return decideToolUse({ toolName, input }, 'unanswered');
  };

  // The stage's work arrives through this tool's handler rather than the
  // result message. Valid output is kept for after the turn; anything else is
  // handed back to Claude, in the same turn, to fix and submit again.
  // Typed through `as`: assigned in the handler, which TS's narrowing cannot see.
  let submitted = null as { output: unknown } | null;
  const submitName = `submit_${stage.id}`;

  const options: Omit<Options, 'prompt'> = {
    cwd: worktreePath,
    abortController,
    // sessionId cannot combine with resume unless forkSession is also set, so a
    // revision forks: the prior transcript stays immutable and the card's
    // history reads as a list of attempts rather than one mutating session.
    ...(resumeSessionId ? { resume: resumeSessionId, forkSession: true } : {}),
    sessionId,
    // The turn boundary. Without this the SDK never says a turn is over, and
    // a run holding its input open for the person would wait for ever: see
    // spikes/conversation-check.ts.
    env: { ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
    // No `allowedTools`: a list is exactly what this replaced. See PERMISSION_MODE.
    // permissionMode itself is filled in below, once fitToModel says whether this
    // model takes it.
    ...(stage.directories ? { additionalDirectories: stage.directories(db) } : {}),
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [liveDatabaseGuard(worktreePath, refuse), mergeGuard(repo.defaultBranch, refuse)],
      }],
    },
    // Escalations and questions: see canUseTool above, and runs/permissions.ts
    // for the refusals it sends.
    canUseTool: (toolName, input, { toolUseID }) => canUseTool(toolName, input, toolUseID),
    maxBudgetUsd: stage.maxBudgetUsd,
    ...(stage.maxTurns ? { maxTurns: stage.maxTurns } : {}),
    ...(model ? { model } : {}),
  };

  if (stage.submit) {
    const shape = (stage.schema as unknown as z.ZodObject<z.ZodRawShape>).shape;
    const submit = tool(
      submitName,
      stage.submit.description,
      shape,
      async (args) => {
        const parsed = stage.schema.safeParse(args);
        if (!parsed.success) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: `Not recorded — the submission did not match: ${parsed.error.message.slice(0, 1500)}. Fix it and call ${submitName} again.`,
            }],
          };
        }
        submitted = { output: parsed.data };
        return { content: [{ type: 'text', text: 'Recorded. Reeve writes the documents from this.' }] };
      },
      // Found through ToolSearch otherwise, which costs a turn every stage.
      { alwaysLoad: true },
    );
    // Ends the turn once it succeeds. tool() has no parameter for it.
    submit._meta = { 'claude/endTurn': true };
    options.mcpServers = { reeve: createSdkMcpServer({ name: 'reeve', version: '1.0.0', tools: [submit] }) };
  } else {
    options.outputFormat = { type: 'json_schema', schema: jsonSchemaFor(stage.schema) };
  }

  const done = (async () => {
    let result: Extract<SDKMessage, { type: 'result' }> | null = null;
    let inbox: Inbox | null = null;
    // A safety net under the idle event: should a release stop sending it,
    // a result with nothing queued behind it still ends the run, a little late.
    let idleFallback: NodeJS.Timeout | undefined;
    try {
      const fitted = await fitToModel(model, effort);
      if (fitted.effort !== effort) setRunStatus(db, runId, { effort: fitted.effort });
      if (fitted.effort) options.effort = fitted.effort;
      // A model without auto mode is left to start in its own default mode:
      // options.permissionMode stays unset, the SDK's own default, rather than
      // sending a mode it does not take. The row is corrected again once the
      // session's init message says what it actually started in.
      if (fitted.autoMode) {
        options.permissionMode = PERMISSION_MODE;
        setRunStatus(db, runId, { permissionMode: PERMISSION_MODE });
      }
      autoMode = fitted.autoMode;
      // The card modal shows what Claude is reasoning about. Left to default,
      // adaptive thinking omits the text and stores an empty block with only a
      // signature. A model without adaptive thinking is left to its own default
      // rather than sent a mode it would refuse.
      if (fitted.adaptiveThinking) options.thinking = { type: 'adaptive', display: 'summarized' };

      // Anything the prompt needs that does not exist yet. A stage without a
      // `prepare` contributes nothing and this is one await of undefined. A
      // follow-up skips it: Testing's pictures were taken for the run that
      // started the conversation, not for every reply in it.
      const prepared = followUp ? {} : ((await stage.prepare?.(db, writer, ctx, runId)) ?? {});
      // A stage's opening prompt closes with how to talk to the person and how
      // to deliver: see prompts/conversation.md.
      const promptText = followUp ?? (stage.submit
        ? stage.buildPrompt(ctx, prepared) + renderPrompt('conversation', { submitTool: submitName })
        : stage.buildPrompt(ctx, prepared));
      setRunStatus(db, runId, { prompt: promptText });

      // Held open for the person: see runs/inbox.ts. A one-off task has no
      // conversation and gets nothing more than its prompt.
      inbox = new Inbox(promptText);
      if (!stage.submit) inbox.close();
      const input = inbox;
      const q = query({ prompt: input, options });
      runRegistry.register({
        runId,
        cardId: card.id,
        kind: 'claude',
        outOfBand: stage.outOfBand ?? false,
        send: stage.submit ? (text) => input.push(text) : undefined,
        stop: async () => {
          cancelled = true;
          setRunStatus(db, runId, { status: 'stopping' });
          askRegistry.stopRun(runId);
          input.close();
          // abort() is the mechanism. interrupt() rejected on every spike
          // attempt with "Query closed before response received", so it is a
          // best-effort nicety only and must never be awaited bare.
          void q.interrupt?.().catch(() => {});
          abortController.abort();
          await done;
        },
      });

      let thought: Thought = { activity: null, thinking: null };
      for await (const message of q) {
        writer.append(runId, classify(message), message, (message as { uuid?: string }).uuid ?? null);
        if (message.type === 'result') {
          result = message;
          // Only a fallback; see idleFallback above.
          clearTimeout(idleFallback);
          if (!(message as { queued_turn_count?: number }).queued_turn_count) {
            idleFallback = setTimeout(() => {
              if (input.pending === 0) input.close();
            }, 15_000);
          }
        }
        if (message.type === 'assistant') clearTimeout(idleFallback);
        // The turn is over. With nothing the person has sent still waiting,
        // the run is done: either Claude submitted the stage's work, or it is
        // the person's turn, which a reply picks up in a forked session rather
        // than a process held open for however long they take.
        if (
          message.type === 'system' &&
          (message as { subtype?: string }).subtype === 'session_state_changed' &&
          (message as { state?: string }).state === 'idle' &&
          input.pending === 0
        ) {
          clearTimeout(idleFallback);
          input.close();
        }
        // Stored above like any other message; this only moves the board's readout.
        if (message.type === 'rate_limit_event') recordRateLimit(message, Date.now());
        // What `fitToModel` could not see: an account or a setting that turns
        // auto mode off, when auto mode was actually asked for. A model that
        // never asked for it — fitted.autoMode false — is expected to report
        // something else and is corrected below instead, not refused. The
        // session says which mode it really started in, and it says so before
        // Claude has taken a turn. Thrown out of the loop, which closes the
        // query, into the catch below that fails the run.
        if (message.type === 'system' && message.subtype === 'init') {
          if (fitted.autoMode && message.permissionMode !== PERMISSION_MODE) {
            abortController.abort();
            throw new AutoModeUnavailable(
              `Auto mode is unavailable to this session, which started in ${message.permissionMode} mode, so Reeve ` +
                'stopped it before Claude began: check the account Claude Code signs in with, and any `disableAutoMode` setting.',
            );
          }
          if (!fitted.autoMode) setRunStatus(db, runId, { permissionMode: message.permissionMode });
        }

        // The refusals nobody asked us about: auto mode's classifier turning a
        // call down on its own.
        const refused = denials.observe(message);
        if (refused) setRunStatus(db, runId, { permissionDenials: refused });

        // Kept on the row whether or not anyone is watching, so the modal opens
        // on what Claude is doing now. Written only on a change: thinking_tokens
        // arrives many times a turn saying the same thing, and this write is
        // synchronous on the message path.
        const line = describeParsed(message as TranscriptMessage);
        if (line === null) continue;
        const next = nextThought(thought, line);
        if (next.activity === thought.activity && next.thinking === thought.thinking) continue;
        thought = next;
        setRunStatus(db, runId, { lastActivity: thought.activity, lastThinking: thought.thinking });
      }
    } catch (err) {
      // Checked first: the init check aborts on its way out, and that is a
      // refusal to report, not a person pressing Stop.
      if (err instanceof AutoModeUnavailable) {
        writer.append(runId, 'error', { message: err.message });
        finish(db, writer, runId, 'failed', 'sdk_error', err.message, result);
        return;
      }
      const text = String(err);
      if (cancelled || text.includes(ABORT_MARKER)) {
        finish(db, writer, runId, 'cancelled', 'cancelled_by_user', null, result);
        return;
      }
      writer.append(runId, 'error', { message: text });
      finish(db, writer, runId, 'failed', 'sdk_error', text.slice(0, 500), result);
      return;
    } finally {
      clearTimeout(idleFallback);
      inbox?.close();
      askRegistry.stopRun(runId);
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

    // A conversation's run that ended without the stage's work: Claude asked
    // something, or answered something, and it is the person's turn.
    if (stage.submit && !submitted) {
      finish(db, writer, runId, 'awaiting_reply', 'completed', null, result);
      return;
    }

    const raw = stage.submit ? submitted?.output : (result as { structured_output?: unknown }).structured_output;
    const parsed = stage.schema.safeParse(raw);
    if (!parsed.success) {
      // Keep the raw output regardless — a malformed run is still evidence.
      finish(db, writer, runId, 'failed', 'invalid_output', parsed.error.message.slice(0, 500), result);
      return;
    }
    if (stage.submit) writer.append(runId, 'submitted', { tool: submitName, summary: stage.summarise(parsed.data as never) });

    // Re-read rather than trusted from when the run started: a switch flipped
    // mid-run must still be the one `onComplete` sees, the same as the
    // guarantee `recordSuggestions` makes for itself in `onPersist` below —
    // otherwise `.reeve/implementation.md` could list suggestions that
    // `recordSuggestions` then declines to turn into cards.
    ctx.suggestTasks = getSettings(db).suggestTasks;
    materialiseArtifacts(db, card, worktreePath, runId, stage, ctx, parsed.data, runStage);
    // Files first, then rows, then the run is marked done — so nothing can read
    // a succeeded run whose plan or questions have not landed yet.
    stage.onPersist?.(db, ctx, parsed.data, runId);
    try {
      await stage.onPersistAsync?.(db, writer, ctx, parsed.data, runId);
    } catch (err) {
      // Before `finish`, which closes the writer.
      writer.append(runId, 'error', { message: `after the run: ${String(err)}` });
    }
    finish(db, writer, runId, 'succeeded', 'completed', null, result, parsed.data);
  })();

  return { runId, sessionId, done };
}

/** AskUserQuestion's input, read defensively: it is the model's, and only typed by the SDK. */
function questionsIn(input: Record<string, unknown>): AskQuestion[] {
  const list = Array.isArray(input['questions']) ? input['questions'] : [];
  return list
    .filter((q): q is Record<string, unknown> => typeof q === 'object' && q !== null)
    .map((q) => ({
      question: String(q['question'] ?? ''),
      header: typeof q['header'] === 'string' ? q['header'] : undefined,
      multiSelect: q['multiSelect'] === true,
      options: (Array.isArray(q['options']) ? q['options'] : [])
        .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
        .map((o) => ({ label: String(o['label'] ?? ''), description: typeof o['description'] === 'string' ? o['description'] : undefined })),
    }));
}

/**
 * What the sessions this one was forked from had already spent. A forked
 * session's first result counts from its parent's total, so a run's own cost
 * is its total less this. Each run stores its own share, so the parent's own
 * total is the sum along the chain.
 */
function inheritedCostUsd(db: Db, parentRunId: string | null): number {
  let total = 0;
  const seen = new Set<string>();
  for (let id = parentRunId; id && !seen.has(id); ) {
    seen.add(id);
    const parent = getRun(db, id);
    if (!parent) break;
    total += parent.totalCostUsd ?? 0;
    id = parent.parentRunId;
  }
  return total;
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
    // The server writes the file. Claude only returned data, which is why the
    // Planning stage can be told to change nothing at all.
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

/** The result message's own denial list, when it has a non-empty one. */
function denialsIn(r: { permission_denials?: unknown } | null): unknown[] | null {
  const list = r?.permission_denials;
  return Array.isArray(list) && list.length > 0 ? list : null;
}

function finish(
  db: Db,
  writer: EventWriter,
  runId: string,
  status: 'succeeded' | 'failed' | 'cancelled' | 'awaiting_reply',
  stopReason: StopReason,
  errorMessage: string | null,
  result: Extract<SDKMessage, { type: 'result' }> | null,
  // The stage's output when it came through the submit tool, which leaves
  // the result's own `structured_output` empty.
  output?: unknown,
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
    // This run's own share: see inheritedCostUsd.
    totalCostUsd: r?.total_cost_usd != null
      ? Math.max(0, r.total_cost_usd - inheritedCostUsd(db, getRun(db, runId)?.parentRunId ?? null))
      : null,
    numTurns: r?.num_turns ?? null,
    usageJson: (r?.usage as Record<string, unknown>) ?? null,
    modelUsageJson: (r?.modelUsage as Record<string, unknown>) ?? null,
    resultText: r?.result ?? null,
    structuredOutput: output ?? r?.structured_output ?? null,
    // Overwritten only when the result carries them, since that list is the
    // authoritative one. A run that ended without a result message keeps what
    // the stream recorded; null here would erase it.
    ...(denialsIn(r) ? { permissionDenials: denialsIn(r) } : {}),
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
