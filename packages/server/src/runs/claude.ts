import {
  createSdkMcpServer,
  query,
  tool,
  type AgentDefinition,
  type HookInput,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { z } from 'zod';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EffortLevel, MessageSource, StopReason, Thought, TranscriptMessage } from '@reeve/shared';
import { costOf, describeParsed, isRunnable, jsonSchemaFor, nextThought, toolLabel, type ApiRunPulse, type TokenUsage } from '@reeve/shared';
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
import { allowances, askRegistry, type AskAnswer, type AskQuestion, type AskRequest } from './asks.js';
import { Inbox } from './inbox.js';
import { agentGuard, allowanceHook, decideToolUse, denialRecorder, liveDatabaseGuard, mergeGuard, personDenial, sessionScoped } from './permissions.js';
import { runRegistry } from './registry.js';
import { projectContextFor } from '../projectContext.js';
import { baseBranchFor, protectedBranches } from '../stacks.js';

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
    project: projectContextFor(db, base.card),
    baseBranch: baseBranchFor(db, base.card, base.repo),
    notes: unreadNotesFor(db, base.card.id),
    suggestTasks: getSettings(db).suggestTasks,
    promptOverride:
      excludeStage && isRunnable(excludeStage) ? (getSettings(db).stageDefaults[excludeStage].prompt ?? undefined) : undefined,
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
 * The budget and turn limit a run is sent: the card's own, then the Settings
 * row for its stage, then what the stage module asks for. The same layers as
 * the model and effort below, and a one-off task keeps its own for the same
 * reason they do.
 */
export function limitsFor(
  db: Db,
  card: Card,
  stage: Pick<ClaudeTask, 'maxBudgetUsd' | 'maxTurns' | 'outOfBand'>,
  runStage: CardStage,
): { budgetUsd: number; maxTurns: number | null } {
  if (stage.outOfBand) return { budgetUsd: stage.maxBudgetUsd, maxTurns: stage.maxTurns ?? null };
  const defaults = isRunnable(runStage) ? getSettings(db).stageDefaults[runStage] : undefined;
  return {
    budgetUsd: card.maxBudgetUsd ?? defaults?.maxBudgetUsd ?? stage.maxBudgetUsd,
    maxTurns: card.maxTurns ?? defaults?.maxTurns ?? stage.maxTurns ?? null,
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
 * Whether a run may call the advisor: the Settings row for its stage, then the
 * stage module's own (off for Testing and Release). The advisor is Claude
 * Code's, switched on by `advisorModel` in the person's own settings, which
 * every run loads; nothing here turns it on where they have not.
 *
 * It costs a stage more than it costs a Claude Code session. Each call sends
 * the whole session to the advisor uncached, and a stage is just what its
 * instructions say to consult it on: a large task, ended by declaring it done
 * with `submit_<stage>`. On the board's first 714 runs it was a quarter of all
 * spend, and a card going through three stages called it four times at the
 * median, where one Claude Code session of the same length calls it about as
 * often as one stage does.
 *
 * Out-of-band work keeps the task's own, as with the model and limits.
 */
export function advisorFor(db: Db, stage: Pick<ClaudeTask, 'advisor' | 'outOfBand'>, runStage: CardStage): boolean {
  if (stage.outOfBand) return stage.advisor ?? true;
  const own = isRunnable(runStage) ? getSettings(db).stageDefaults[runStage].advisor : null;
  return own ?? stage.advisor ?? true;
}

/**
 * Claude Code tools a stage run is never given. Each is for a person at a
 * terminal, or for a session that manages its own place to work, and Reeve is
 * both of those for the run already: it owns the worktree, the mode, the
 * schedule and the person's attention. None was called in any of the board's
 * first 714 runs, except ScheduleWakeup, which failed in three of its 14 and
 * means nothing in a run that ends when its turn does, and ListAgents, which
 * is how two sessions on one worktree found each other and one swept the
 * other's work into its commit. Leaving them out also takes tokens off the
 * start of every session, which is written to the cache each time one starts:
 * about 3k off a lead's opening prompt, 1.4k off a worker's.
 *
 * Narrower, never wider: this takes tools away and grants nothing, so it does
 * not touch what auto mode allows of the tools that are left. TaskStop,
 * Monitor and SendMessage stay — the lead stops its worker and talks to it
 * with them — and so does NotebookEdit, which a repo of notebooks needs.
 */
const UNUSED_TOOLS = [
  'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger', 'PushNotification',
  'EnterWorktree', 'ExitWorktree', 'EnterPlanMode', 'ExitPlanMode', 'DesignSync', 'ListAgents',
];

/**
 * The permission mode every run asks for. The classifier decides what a run
 * may do, as it does in Claude Code's auto mode, and each stage's prompt says
 * what it should do; see runs/permissions.ts for what is left for us to
 * answer. Not every pinned model takes it — see `fitToModel`, below, for the
 * one that is left to run without it instead.
 */
const PERMISSION_MODE = 'auto' satisfies PermissionMode;

/**
 * The name a stage's worker is launched by: `subagent_type` on the lead's
 * Agent call, and the label its asks and progress carry on the card.
 */
const WORKER_TYPE = 'worker';

/**
 * The worker a stage with one hands the lead: the stage's own brief as its
 * system prompt, inside prompts/worker.md, and nothing that is the lead's to
 * do. The reeve server goes — submitting is the lead's, after it has checked
 * the work — and so do Agent, since a worker launching workers is a tree
 * nobody is reading, and AskUserQuestion, since only the lead talks to the
 * person.
 *
 * The brief is kept in the worktree beside the stage's documents, because a
 * follow-up forks the session without building the prompt again — Testing's
 * screenshots are taken once, for the run that started the conversation —
 * and its worker still needs the brief it was started with. In `.reeve/`, so
 * it is never committed.
 */
function workerDefinition(
  stage: ClaudeTask<never>,
  worktreePath: string,
  brief: string | null,
  submitName: string,
  effort: EffortLevel | null,
  maxTurns: number | null,
): AgentDefinition {
  const path = join(worktreePath, '.reeve', `${stage.id}-brief.md`);
  if (brief !== null) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, brief);
  }
  const kept = brief ?? (existsSync(path) ? readFileSync(path, 'utf8') : null);
  return {
    description: stage.worker!.description,
    prompt: renderPrompt('worker', {
      worktreePath,
      submitTool: submitName,
      brief: kept ?? '_The brief this stage started with is gone. The lead\'s message is your whole brief._',
    }),
    disallowedTools: ['mcp__reeve', 'Agent', 'Task', 'AskUserQuestion'],
    model: 'inherit',
    background: true,
    ...(maxTurns ? { maxTurns } : {}),
    ...(effort ? { effort } : {}),
  };
}

/**
 * Keeps the run's picture of its worker in step with the stream: launched
 * (by `agentGuard`, before the call runs), given a task id, and ended — by
 * its notification, by dropping out of the background list, or by an Agent
 * call that failed and so never started one. `setAgents` hears the agents
 * in each new background list, and nothing else in it: shells are left out.
 */
function trackWorkers(message: SDKMessage, workers: Map<string, string | null>, setAgents: (tasks: Set<string>) => void): void {
  const m = message as {
    type?: string; subtype?: string; tool_use_id?: string; task_id?: string;
    tasks?: Array<{ task_id?: string; task_type?: string }>;
  };
  if (m.type === 'system' && m.subtype === 'task_started' && m.tool_use_id && workers.has(m.tool_use_id)) {
    workers.set(m.tool_use_id, m.task_id ?? null);
  } else if (m.type === 'system' && m.subtype === 'task_notification' && m.tool_use_id) {
    workers.delete(m.tool_use_id);
  } else if (m.type === 'system' && m.subtype === 'background_tasks_changed') {
    const listed = new Set((m.tasks ?? []).map((t) => t.task_id).filter((id): id is string => Boolean(id)));
    for (const [toolUseId, taskId] of workers) if (taskId && !listed.has(taskId)) workers.delete(toolUseId);
    // `local_agent` today; matched loosely so a remote one counts too.
    setAgents(new Set((m.tasks ?? []).filter((t) => t.task_id && /agent/i.test(t.task_type ?? '')).map((t) => t.task_id!)));
  } else if (m.type === 'user' && !(message as { parent_tool_use_id?: string | null }).parent_tool_use_id) {
    const content = (message as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<{ type?: string; tool_use_id?: string; is_error?: boolean }>) {
      if (block.type === 'tool_result' && block.is_error && block.tool_use_id) workers.delete(block.tool_use_id);
    }
  }
}

/**
 * A live run's signs of life, folded from its stream: see ApiRunPulse.
 *
 * Cost is the SDK's own figure as of the last turn's end, less what a forked
 * session inherited, plus the tokens priced since (shared/pricing.ts). An
 * assistant message arrives once per content block, each repeating the
 * message's usage, so usage is kept per message id rather than summed.
 *
 * Priced tokens alone come in well under the real figure: auto mode's
 * classifier and the SDK's own small calls cost money and never appear as
 * assistant messages (an Opus classifier was a fifth of one Testing run's
 * spend; spikes/pulse-replay-check.ts). So each exact figure calibrates the
 * next estimate: real spend over priced tokens so far, applied to what has
 * been priced since. Until a run's first turn ends, CALIBRATION is assumed.
 */
/** Real spend over priced tokens, assumed before a run has an exact figure of its own. */
const CALIBRATION = 1.4;

export class Pulse {
  private lastEventAt = Date.now();
  // By tool_use id, with the loop each call belongs to (the Agent call that
  // launched it, or null for the lead's), so a loop's calls can be dropped
  // when it ends: a stopped worker's never get their results.
  private readonly inFlight = new Map<string, ApiRunPulse['inFlight'][number] & { loop: string | null }>();
  // Shells left running in the background — a test suite, a dev server —
  // by task id. Their Bash call returned at once, so without these a run
  // waiting on its tests would read as silent.
  private readonly shells = new Map<string, ApiRunPulse['inFlight'][number]>();
  private exact: number | null = null;
  /** Each message's priced cost, by id; their sum; and the sum when the last exact figure came. */
  private readonly priced = new Map<string, number>();
  private pricedTotal = 0;
  private pricedAtExact = 0;
  private factor = CALIBRATION;
  private unpriced = false;
  // API calls per loop toward maxTurns, which the SDK counts per loop: the
  // lead's current turn (null), and each subagent's whole run, by the Agent
  // call that launched it.
  private readonly calls = new Map<string | null, Set<string>>();

  constructor(
    private readonly maxTurns: number | null,
    private readonly inherited: number,
    private readonly workerCalls: ReadonlySet<string>,
  ) {}

  observe(message: SDKMessage): void {
    this.lastEventAt = Date.now();
    const parent = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
    if (message.type === 'assistant') {
      const m = (message as { message?: { id?: string; model?: string; usage?: TokenUsage; content?: unknown } }).message;
      if (m?.id && m.usage) {
        const cost = costOf(m.model, m.usage);
        if (cost === null) this.unpriced = true;
        this.pricedTotal += (cost ?? 0) - (this.priced.get(m.id) ?? 0);
        this.priced.set(m.id, cost ?? 0);
      }
      if (m?.id) {
        const loop = this.calls.get(parent) ?? new Set<string>();
        loop.add(m.id);
        this.calls.set(parent, loop);
      }
      for (const block of (Array.isArray(m?.content) ? m.content : []) as Array<{ type?: string; id?: string; name?: string; input?: Record<string, unknown> }>) {
        if (block.type !== 'tool_use' || !block.id || !block.name) continue;
        const { verb, target } = toolLabel(block.name, block.input ?? {});
        this.inFlight.set(block.id, {
          verb, target: target.slice(0, 160), since: Date.now(),
          worker: parent !== null && this.workerCalls.has(parent), background: false, loop: parent,
        });
      }
    } else if (message.type === 'user') {
      const content = (message as { message?: { content?: unknown } }).message?.content;
      for (const block of (Array.isArray(content) ? content : []) as Array<{ type?: string; tool_use_id?: string }>) {
        if (block.type === 'tool_result' && block.tool_use_id) this.inFlight.delete(block.tool_use_id);
      }
    } else if (message.type === 'result') {
      const r = message as { total_cost_usd?: number };
      if (typeof r.total_cost_usd === 'number') {
        this.exact = Math.max(0, r.total_cost_usd - this.inherited);
        // Only from a figure big enough to say something.
        if (this.pricedTotal > 0.02 && this.exact > 0) this.factor = Math.min(4, Math.max(1, this.exact / this.pricedTotal));
        this.pricedAtExact = this.pricedTotal;
      }
      this.calls.delete(null);
      // The lead's turn is over, and with it any call of its own.
      for (const [id, call] of this.inFlight) if (call.loop === null) this.inFlight.delete(id);
    } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const id = (message as { tool_use_id?: string }).tool_use_id;
      if (id) {
        this.calls.delete(id);
        for (const [call, entry] of this.inFlight) if (entry.loop === id) this.inFlight.delete(call);
      }
    } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'background_tasks_changed') {
      const tasks = (message as { tasks?: Array<{ task_id?: string; task_type?: string; description?: string }> }).tasks ?? [];
      const listed = new Set<string>();
      for (const t of tasks) {
        if (!t.task_id || /agent/i.test(t.task_type ?? '')) continue;
        listed.add(t.task_id);
        if (!this.shells.has(t.task_id)) {
          this.shells.set(t.task_id, { verb: 'Background', target: (t.description ?? 'a command').slice(0, 160), since: Date.now(), worker: false, background: true });
        }
      }
      for (const id of this.shells.keys()) if (!listed.has(id)) this.shells.delete(id);
    } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_started') {
      // Arrives just after the list that first names the shell, and says whose it is.
      const t = message as { task_id?: string; owned_by_subagent?: boolean };
      const shell = t.task_id ? this.shells.get(t.task_id) : undefined;
      if (shell && t.owned_by_subagent) shell.worker = true;
    }
  }

  read(budgetUsd: number | null): ApiRunPulse {
    const since = (this.pricedTotal - this.pricedAtExact) * this.factor;
    const estimated = this.pricedTotal > this.pricedAtExact;
    return {
      lastEventAt: this.lastEventAt,
      inFlight: [...[...this.inFlight.values()].map(({ loop: _loop, ...call }) => call), ...this.shells.values()].sort((a, b) => a.since - b.since),
      // Nothing to say for a model with no price until its first turn ends.
      costUsd: this.exact === null && (this.unpriced || !estimated) ? null : (this.exact ?? 0) + since,
      costExact: !estimated,
      budgetUsd,
      turns: Math.max(0, ...[...this.calls.values()].map((c) => c.size)),
      maxTurns: this.maxTurns,
    };
  }
}

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
  const limits = limitsFor(db, card, stage, runStage);
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
    maxBudgetUsd: limits.budgetUsd,
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
  // a session in its own default mode is asked about every edit, so only it
  // is offered Allow for this session.
  let autoMode = false;

  // The stage's background worker, when it has one: see `worker` in
  // stages/types.ts. Each worker is keyed by the Agent call that launched it,
  // which is what its end — a task_notification — names; its task id comes
  // later, with task_started, and is what background_tasks_changed lists.
  // `agents` is the agents in that list, whole each time it changes, and
  // starts empty with the process, as the SDK says it must.
  const workerType = stage.submit && stage.worker ? WORKER_TYPE : null;
  const workers = new Map<string, string | null>();
  let agents = new Set<string>();
  // An agent still working behind the lead's back. While one is, a turn that
  // ends is not the run ending: the input stays open for the person, and
  // closing it would leave the worker finishing with nobody able to talk.
  // Agents only: a background shell — a dev server, a long `sleep` — is still
  // listed when the SDK says idle, and holding the run open for one would
  // hold it for ever (spikes/background-agent-check.ts, E).
  const busy = () => workers.size > 0 || agents.size > 0;
  // Which calls are the worker's, so an ask or a refusal is put down to it
  // and to nothing else: a subagent the lead sends off in Planning is part of
  // the lead's own turn, and is treated as the lead was before workers. The
  // Agent calls that launched a worker, ever, for its messages; the agent ids
  // its own calls carry, for canUseTool, learnt from the hook that sees each
  // call first.
  const workerCalls = new Set<string>();
  const workerAgents = new Set<string>();
  const fromWorker = (agentID: string | undefined) => agentID !== undefined && workerAgents.has(agentID);

  // The run's pulse (ApiRunPulse): what tells a long run from a stuck one.
  // Kept here, in memory, and read through the registry on every poll.
  const pulse = new Pulse(limits.maxTurns, inheritedCostUsd(db, parentRunId ?? null), workerCalls);

  /**
   * Hold the turn on a person: the run reads `asking` until they answer, the
   * request times out, or the run is stopped. The request and its answer go
   * into the run's events, which is where the conversation shows them.
   */
  const askPerson = async (request: AskRequest, toolUseId: string, signal?: AbortSignal, agent?: 'worker'): Promise<AskAnswer> => {
    const { ask, answer } = askRegistry.wait(runId, card.id, request, config.askTimeoutMs, agent);
    // The SDK gives a local prompt no deadline of its own, but it can abandon
    // the call — an interrupt, the session ending — and then nothing is
    // waiting on the answer, so the buttons must not stay up as if it were.
    signal?.addEventListener('abort', () => askRegistry.settle(ask.id, { kind: 'unanswered', why: 'stopped' }), { once: true });
    writer.append(runId, 'ask', { ...ask, toolUseId });
    writer.flush();
    setRunStatus(db, runId, { status: 'asking' });
    const settled = await answer;
    writer.append(runId, 'ask_answered', { askId: ask.id, ...settled, at: Date.now() });
    // Still asking while the other of lead and worker waits on its own.
    if (!cancelled && !askRegistry.forRun(runId)) setRunStatus(db, runId, { status: 'running' });
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
    signal?: AbortSignal,
    agentID?: string,
    suggestions?: PermissionUpdate[],
  ): Promise<PermissionResult> => {
    // A one-off task — Suggest, a split, resolving conflicts — has no
    // conversation anyone is reading, so nothing in it can be asked: refused
    // at once, as every escalation always was.
    if (!stage.submit) {
      refuse(toolName, input, toolUseID);
      if (toolName === 'AskUserQuestion') {
        return {
          behavior: 'deny',
          message: 'Nobody can answer questions during this task. Make the call yourself, and say in your output what you chose and why.',
        };
      }
      return decideToolUse({ toolName, input });
    }
    // A subagent cannot put a question to the person: its chips would sit
    // under the lead's conversation with nothing to say whose they were, and
    // the worker is told to decide and report instead. Refused, not parked.
    if (toolName === 'AskUserQuestion' && fromWorker(agentID)) {
      return {
        behavior: 'deny',
        message:
          'Only the lead talks to the person. Make the call yourself, carry on, and say in your report what you ' +
          'chose and why; the lead will pass on anything the person wants changed.',
      };
    }
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
      const settled = await askPerson({ kind: 'question', questions }, toolUseID, signal);
      if (settled.kind === 'question') return { behavior: 'allow', updatedInput: { ...input, answers: settled.answers } };
      return {
        behavior: 'deny',
        message:
          'Nobody answered that in time. Do what does not depend on it; if the rest does, ask it in plain text ' +
          'at the end of your turn instead, and the person will reply when they are back.',
      };
    }

    if (unwatched()) {
      refuse(toolName, input, toolUseID);
      return decideToolUse({ toolName, input });
    }
    // Without auto mode this is Claude Code's default-mode prompt, `npm test`
    // and every edit included, so it gets Claude Code's answers to it: once,
    // or for the rest of the session. Auto mode's escalations stay once only.
    const session = autoMode ? null : sessionScoped(suggestions);
    const settled = await askPerson(
      { kind: 'permission', toolName, input, ...(session ? { session: session.label } : {}) },
      toolUseID, signal, fromWorker(agentID) ? 'worker' : undefined,
    );
    if (settled.kind === 'permission' && settled.allow) {
      return { behavior: 'allow', updatedInput: input, ...(settled.session && session ? { updatedPermissions: session.updates } : {}) };
    }
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
    disallowedTools: UNUSED_TOOLS,
    // No `allowedTools`: a list is exactly what this replaced. See PERMISSION_MODE.
    // permissionMode itself is filled in below, once fitToModel says whether this
    // model takes it.
    ...(stage.directories ? { additionalDirectories: stage.directories(db) } : {}),
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [liveDatabaseGuard(worktreePath, refuse), mergeGuard(protectedBranches(db, card, repo), refuse)],
        },
        // No matcher: agentGuard checks the tool's name itself, rather than
        // trusting an alternation to match the way a Claude Code setting does.
        {
          hooks: [agentGuard({
            workerType,
            workerRunning: () => workers.size > 0,
            onLaunch: (toolUseId) => {
              workers.set(toolUseId, null);
              workerCalls.add(toolUseId);
            },
            onDenied: refuse,
          })],
        },
        // Every tool: what a person allowed once after auto mode refused it.
        // Only a conversation's run has anyone to allow anything.
        ...(stage.submit ? [{ hooks: [allowanceHook(card.id, worktreePath, protectedBranches(db, card, repo), (c, t, i) => allowances.take(c, t, i))] }] : []),
        // Every tool: learns the worker's agent id from its first call, which
        // reaches this hook before it can reach canUseTool. Decides nothing.
        ...(workerType ? [{
          hooks: [(hook: HookInput) => {
            const h = hook as { agent_id?: string; agent_type?: string };
            if (h.agent_id && h.agent_type === workerType) workerAgents.add(h.agent_id);
            return Promise.resolve({});
          }],
        }] : []),
      ],
    },
    // Escalations and questions: see canUseTool above, and runs/permissions.ts
    // for the refusals it sends.
    canUseTool: (toolName, input, { toolUseID, signal, agentID, suggestions }) => canUseTool(toolName, input, toolUseID, signal, agentID, suggestions),
    maxBudgetUsd: limits.budgetUsd,
    ...(limits.maxTurns ? { maxTurns: limits.maxTurns } : {}),
    ...(model ? { model } : {}),
    // An empty advisorModel is how Claude Code itself switches the advisor off,
    // and flag settings sit above the person's own, for this session only.
    ...(advisorFor(db, stage, runStage) ? {} : { settings: { advisorModel: '' } }),
  };

  if (stage.submit) {
    const shape = submitShape(stage.schema);
    const submit = tool(
      submitName,
      stage.submit.description,
      shape,
      async (args) => {
        // The lead submits what its worker built, so not before the worker
        // is done: the run would end, and the worker with it, mid-edit.
        // Any agent still in the background counts, worker or not: work the
        // lead started some other way is unfinished all the same.
        if (workerType && busy()) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: `Not recorded — your worker, or another agent you launched, is still running in the background. ` +
                `Wait for it to report, check what it did, then call ${submitName}. If it should stop early, tell it to wrap up with SendMessage.`,
            }],
          };
        }
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
    // Ends the turn once it succeeds. tool() has no parameter for it, and
    // keeps its own alwaysLoad in the same field, so it is added to, never
    // replaced — replacing it sent every stage through ToolSearch first.
    submit._meta = { ...submit._meta, 'claude/endTurn': true };
    options.mcpServers = { reeve: createSdkMcpServer({ name: 'reeve', version: '1.0.0', tools: [submit], alwaysLoad: true }) };
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
      const brief = followUp ? null : stage.buildPrompt(ctx, prepared);
      // A stage's opening prompt closes with how to talk to the person and how
      // to deliver: see prompts/conversation.md. With a worker, the brief is
      // the worker's, and the lead reads it inside its own: prompts/lead.md.
      const promptText = followUp ?? (stage.submit
        ? (workerType ? renderPrompt('lead', { brief: brief!, workerType, submitTool: submitName }) : brief!) +
          renderPrompt('conversation', { submitTool: submitName })
        : brief!);
      setRunStatus(db, runId, { prompt: promptText });
      if (workerType && stage.worker) {
        options.agents = { [workerType]: workerDefinition(stage, worktreePath, brief, submitName, fitted.effort, limits.maxTurns) };
        // The worker's progress, as a line the card can show without opening
        // its calls: a summary every half minute or so.
        options.agentProgressSummaries = true;
        // Its own words as well as its calls, which the card nests under the
        // Agent call that launched it.
        options.forwardSubagentText = true;
      }

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
        pulse: () => pulse.read(options.maxBudgetUsd ?? null),
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
      // This run's tool calls, in full, by id: what a refusal names but does not carry.
      const calls = new Map<string, { toolName: string; input: Record<string, unknown>; agent?: 'worker' }>();
      for await (const message of q) {
        writer.append(runId, classify(message), message, (message as { uuid?: string }).uuid ?? null);
        trackWorkers(message, workers, (next) => { agents = next; });
        pulse.observe(message);
        if (message.type === 'result') {
          result = message;
          // Only a fallback; see idleFallback above. Never while a worker
          // runs: each turn the lead takes meanwhile ends in a result with no
          // idle after it, and closing then would cut the person off.
          clearTimeout(idleFallback);
          if (!(message as { queued_turn_count?: number }).queued_turn_count) {
            idleFallback = setTimeout(() => {
              if (input.pending === 0 && !busy()) input.close();
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
          // Not gated on `busy()`: the SDK already holds idle back until its
          // background agents are done (spikes/background-agent-check.ts),
          // and a worker this run lost track of must never hold it open for
          // ever. Closed early, the input would only cut the person off; the
          // worker still finishes.
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
        if (message.type === 'assistant') {
          const parent = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id;
          const agent = parent && workerCalls.has(parent) ? 'worker' as const : undefined;
          for (const block of ((message as { message?: { content?: unknown } }).message?.content as Array<{ type?: string; id?: string; name?: string; input?: Record<string, unknown> }> | undefined) ?? []) {
            if (block.type === 'tool_use' && block.id && block.name) calls.set(block.id, { toolName: block.name, input: block.input ?? {}, ...(agent ? { agent } : {}) });
          }
          // A refusal names a call from the turn it lands in; a long run's
          // older ones, a Write's whole content among them, are not kept.
          while (calls.size > 64) calls.delete(calls.keys().next().value!);
        }
        const refused = denials.observe(message);
        if (refused) setRunStatus(db, runId, { permissionDenials: refused });
        // Shown in the conversation, where a person can allow it once — but
        // only where there is a person: an auto-mode stage, nobody in VIBES.
        const denied = message as { type?: string; subtype?: string; tool_use_id?: string };
        if (refused && denied.type === 'system' && denied.subtype === 'permission_denied' && stage.submit && autoMode && !unwatched()) {
          const call = denied.tool_use_id ? calls.get(denied.tool_use_id) : undefined;
          if (call) writer.append(runId, 'refused', { toolUseId: denied.tool_use_id, ...call, at: Date.now() });
        }

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

/**
 * The submit tool's input shape: the contract's, with a defaulted field made
 * optional. The MCP layer checks a call against the shape before the handler
 * sees it, and reads `.default([])` as required — the first real submission
 * was refused for leaving out `suggested_tasks`. The handler parses with the
 * contract itself, which fills the default in.
 */
function submitShape(schema: z.ZodType): z.ZodRawShape {
  const shape = (schema as unknown as z.ZodObject<z.ZodRawShape>).shape;
  return Object.fromEntries(
    Object.entries(shape).map(([key, field]) => {
      const outer = field as unknown as z.ZodType;
      const def = (outer as { def?: { type?: string; innerType?: z.ZodType } }).def;
      return [key, def?.type === 'default' && def.innerType ? def.innerType.optional().describe(outer.description ?? '') : field];
    }),
  );
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
  setRunStatus(db, runId, {
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
  const finished = getRun(db, runId);
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
