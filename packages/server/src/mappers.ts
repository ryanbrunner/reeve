import type { ApiCard, ApiProject, ApiRunSummary, RunKind, RunStatus, Stage, StopReason } from '@reeve/shared';
import type { Card, Project, Run } from './db/schema.js';

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

export function toApiCard(
  c: Card,
  projectName: string | null,
  laneColor: string | null,
  latestRun: Run | null,
): ApiCard {
  return {
    id: c.id,
    projectId: c.projectId,
    projectName,
    laneColor,
    title: c.title,
    body: c.body,
    stage: c.stage as Stage,
    position: c.position,
    branchName: c.branchName,
    worktreePath: c.worktreePath,
    latestRun: latestRun ? toApiRunSummary(latestRun) : null,
    createdAt: ms(c.createdAt) ?? 0,
    updatedAt: ms(c.updatedAt) ?? 0,
  };
}
