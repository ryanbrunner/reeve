import type {
  ApiCard,
  ApiCardEvent,
  ApiCardRef,
  ApiAsset,
  ApiCriterion,
  ApiDifference,
  ApiProject,
  ApiQuestion,
  ApiRepo,
  ApiRunSummary,
  ApiTokenBreakdown,
  ApiToolDenial,
  CardActivity,
  CardKind,
  CardEventActor,
  CardEventKind,
  AssetKind,
  CardRefKind,
  CriterionVerdict,
  EffortLevel,
  RunKind,
  RunStatus,
  Stage,
  StopReason,
} from '@reeve/shared';
import { assetSrc } from './assets/store.js';
import type {
  AcceptanceCriterion,
  Asset,
  Card,
  CardEvent,
  CardRef,
  Difference,
  Question,
  Repo,
  Run,
} from './db/schema.js';

const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);

export function toApiRepo(p: Repo): ApiRepo {
  return {
    id: p.id,
    name: p.name,
    repoPath: p.repoPath,
    worktreeRoot: p.worktreeRoot,
    defaultBranch: p.defaultBranch,
    setupCommand: p.setupCommand,
    testCommand: p.testCommand,
    serverCommand: p.serverCommand,
    serverUrl: p.serverUrl,
    teardownCommand: p.teardownCommand,
    finishCommand: p.finishCommand,
    laneColor: p.laneColor,
    syncDefaultBranch: p.syncDefaultBranch,
  };
}

export function toApiRunSummary(r: Run): ApiRunSummary {
  const tokens = runTokens(r.modelUsageJson);
  return {
    id: r.id,
    kind: r.kind as RunKind,
    stage: r.stage as Stage,
    status: r.status as RunStatus,
    task: r.task,
    model: r.model,
    effort: (r.effort ?? null) as EffortLevel | null,
    stopReason: (r.stopReason ?? null) as StopReason | null,
    totalTokens: tokens?.total ?? null,
    tokenBreakdown: tokens?.breakdown ?? null,
    port: r.port,
    startedAt: ms(r.startedAt),
    finishedAt: ms(r.finishedAt),
    errorMessage: r.errorMessage,
    deniedToolUses: toApiToolDenials(r.permissionDenials),
  };
}

/**
 * A run's token count, off the SDK's `modelUsage` as stored, or null when the
 * run has none.
 *
 * `modelUsage` rather than `usage` because the SDK documents it as the one to
 * account from: it takes in subagents and compaction, and `usage` is only the
 * main thread. Worked out here rather than stored, so every run recorded
 * before anyone counted tokens gets a figure too. Read defensively for the
 * same reason as the denials below: it is the SDK's shape, keyed by model.
 */
export function runTokens(stored: unknown): { total: number; breakdown: ApiTokenBreakdown } | null {
  if (typeof stored !== 'object' || stored === null) return null;
  const models = Object.values(stored as Record<string, unknown>);
  if (models.length === 0) return null;
  const count = (m: unknown, key: string): number => {
    const n = typeof m === 'object' && m !== null ? (m as Record<string, unknown>)[key] : undefined;
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
  };
  const sum = (key: string) => models.reduce<number>((n, m) => n + count(m, key), 0);
  const breakdown: ApiTokenBreakdown = {
    input: sum('inputTokens'),
    // `thinkingTokens` is not added: the SDK already counts it inside these.
    output: sum('outputTokens'),
    cacheWrite: sum('cacheCreationInputTokens'),
    cacheRead: sum('cacheReadInputTokens'),
  };
  return { total: breakdown.input + breakdown.output + breakdown.cacheWrite, breakdown };
}

/**
 * The SDK's `permission_denials`, as stored. Read defensively: it is the SDK's
 * shape rather than ours, it has grown fields before, and a run whose denials
 * cannot be parsed should still render.
 */
function toApiToolDenials(stored: unknown): ApiToolDenial[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((raw) => {
    if (typeof raw !== 'object' || raw === null) return [];
    const d = raw as { tool_name?: unknown; tool_input?: Record<string, unknown> };
    const tool = typeof d.tool_name === 'string' ? d.tool_name : 'a tool';
    // A command for Bash, a path for the file tools. Both answer the only
    // question the human has here: which call was it?
    const detail = ['command', 'file_path', 'path', 'url', 'pattern']
      .map((k) => d.tool_input?.[k])
      .find((v) => typeof v === 'string' && v.trim());
    return [{ tool, detail: typeof detail === 'string' ? detail.replace(/\s+/g, ' ').trim() : null }];
  });
}

/**
 * Pure on purpose: `latestRun` and `activity` are handed in already agreed with
 * each other (see ./board.ts), and so is everything else that is read rather
 * than stored, which keeps this module free of the stage definitions and the
 * database.
 */
export function toApiCard(
  c: Card,
  repoName: string | null,
  laneColor: string | null,
  latestRun: Run | null,
  activity: CardActivity,
  derived: Pick<
    ApiCard,
    'openingPr' | 'prConflicting' | 'prMergeable' | 'resolvingConflicts' | 'mergingPr' | 'startingStage' | 'implemented'
  >,
  links: Pick<ApiCard, 'dependsOn' | 'dependents' | 'suggestedBy' | 'suggestions'>,
): ApiCard {
  return {
    id: c.id,
    kind: c.kind as CardKind,
    projectId: c.projectId,
    number: c.number,
    repoId: c.repoId,
    repoName,
    laneColor,
    title: c.title,
    body: c.body,
    stage: c.stage as Stage,
    position: c.position,
    branchName: c.branchName,
    worktreePath: c.worktreePath,
    mergedSha: c.mergedSha,
    mergedAt: ms(c.mergedAt),
    prUrl: c.prUrl,
    prNumber: c.prNumber,
    prOpenedAt: ms(c.prOpenedAt),
    ...derived,
    model: c.model,
    effort: c.effort,
    generateMockups: c.generateMockups,
    vibes: c.vibes,
    ...links,
    activity,
    latestRun: latestRun ? toApiRunSummary(latestRun) : null,
    archivedAt: ms(c.archivedAt),
    createdAt: ms(c.createdAt) ?? 0,
    updatedAt: ms(c.updatedAt) ?? 0,
  };
}

export function toApiProject(
  c: Card,
  laneColor: string | null,
  taskCount: number,
  archivedDoneCount: number,
): ApiProject {
  return { id: c.id, title: c.title, repoId: c.repoId, laneColor, taskCount, archivedDoneCount, vibes: c.vibes };
}

export function toApiCardEvent(e: CardEvent): ApiCardEvent {
  return {
    id: e.id,
    actor: e.actor as CardEventActor,
    actorId: e.actorId,
    kind: e.kind as CardEventKind,
    stage: (e.stage ?? null) as Stage | null,
    runId: e.runId,
    fromStage: (e.fromStage ?? null) as Stage | null,
    toStage: (e.toStage ?? null) as Stage | null,
    body: e.body,
    meta: e.meta ?? null,
    createdAt: ms(e.createdAt) ?? 0,
  };
}

export function toApiCriterion(c: AcceptanceCriterion): ApiCriterion {
  return {
    id: c.id,
    position: c.position,
    text: c.text,
    source: c.source as CardEventActor,
    verdict: (c.verdict ?? null) as CriterionVerdict | null,
    evidence: c.evidence,
    verifiedRunId: c.verifiedRunId,
  };
}

export function toApiCardRef(r: CardRef): ApiCardRef {
  return { id: r.id, kind: r.kind as CardRefKind, value: r.value, label: r.label };
}

export function toApiQuestion(q: Question): ApiQuestion {
  return {
    id: q.id,
    runId: q.runId,
    position: q.position,
    text: q.text,
    suggestions: q.suggestions ?? [],
    answer: q.answer,
    answeredAt: ms(q.answeredAt),
  };
}

export function toApiAsset(a: Asset): ApiAsset {
  return {
    id: a.id,
    kind: a.kind as AssetKind,
    label: a.label,
    url: a.url,
    viewport: a.viewport,
    // The on-disk path never leaves the server; the client gets a route.
    src: assetSrc(a.id),
    width: a.width,
    height: a.height,
    runId: a.runId,
    createdAt: ms(a.createdAt) ?? 0,
  };
}

export function toApiDifference(d: Difference): ApiDifference {
  return {
    id: d.id,
    position: d.position,
    claim: d.claim,
    note: d.note,
    mockupAssetId: d.mockupAssetId,
    screenshotAssetId: d.screenshotAssetId,
  };
}
