import type {
  ApiCard,
  ApiCardEvent,
  ApiCardRef,
  ApiAsset,
  ApiCriterion,
  ApiDifference,
  ApiProject,
  ApiQuestion,
  ApiRunSummary,
  CardActivity,
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
import type {
  AcceptanceCriterion,
  Asset,
  Card,
  CardEvent,
  CardRef,
  Difference,
  Project,
  Question,
  Run,
} from './db/schema.js';

const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);

export function toApiProject(p: Project): ApiProject {
  return {
    id: p.id,
    name: p.name,
    repoPath: p.repoPath,
    worktreeRoot: p.worktreeRoot,
    defaultBranch: p.defaultBranch,
    setupCommand: p.setupCommand,
    testCommand: p.testCommand,
    serverCommand: p.serverCommand,
    teardownCommand: p.teardownCommand,
    finishCommand: p.finishCommand,
    laneColor: p.laneColor,
    maxBudgetUsd: p.maxBudgetUsd,
  };
}

export function toApiRunSummary(r: Run): ApiRunSummary {
  return {
    id: r.id,
    kind: r.kind as RunKind,
    stage: r.stage as Stage,
    status: r.status as RunStatus,
    task: r.task,
    model: r.model,
    effort: (r.effort ?? null) as EffortLevel | null,
    stopReason: (r.stopReason ?? null) as StopReason | null,
    totalCostUsd: r.totalCostUsd,
    port: r.port,
    startedAt: ms(r.startedAt),
    finishedAt: ms(r.finishedAt),
    errorMessage: r.errorMessage,
  };
}

/**
 * Pure on purpose: `latestRun` and `activity` are handed in already agreed with
 * each other (see ./board.ts), which keeps this module free of the stage
 * definitions and the database.
 */
export function toApiCard(
  c: Card,
  projectName: string | null,
  laneColor: string | null,
  latestRun: Run | null,
  activity: CardActivity,
  openingPr: boolean,
): ApiCard {
  return {
    id: c.id,
    number: c.number,
    projectId: c.projectId,
    projectName,
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
    openingPr,
    model: c.model,
    effort: c.effort,
    activity,
    latestRun: latestRun ? toApiRunSummary(latestRun) : null,
    archivedAt: ms(c.archivedAt),
    createdAt: ms(c.createdAt) ?? 0,
    updatedAt: ms(c.updatedAt) ?? 0,
  };
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
    src: `/api/assets/${a.id}`,
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
