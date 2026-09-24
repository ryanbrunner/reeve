import type {
  ApiCard,
  ApiCardEvent,
  ApiProject,
  ApiRunSummary,
  CardActivity,
  CardEventActor,
  CardEventKind,
  RunKind,
  RunStatus,
  Stage,
  StopReason,
} from '@reeve/shared';
import type { Card, CardEvent, Project, Run } from './db/schema.js';

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
    activity,
    latestRun: latestRun ? toApiRunSummary(latestRun) : null,
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
