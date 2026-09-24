import {
  implementationOutput,
  planningOutput,
  testingOutput,
  type ApiChecks,
  type ApiImplementation,
  type ApiPlan,
  type ApiWorktree,
  type CardDetail,
  type Stage,
} from '@reeve/shared';
import { toBoardCard } from './board.js';
import type { Db } from './db/client.js';
import {
  assetsFor,
  cardEventsFor,
  criteriaFor,
  differencesFor,
  latestClaudeRunForStage,
  refsFor,
  runsForCard,
  questionsForRun,
  stageHistory,
} from './db/queries.js';
import type { Card, Project, Run } from './db/schema.js';
import { behindBase, checkWorktree } from './git/worktree.js';
import {
  toApiAsset,
  toApiCardEvent,
  toApiCardRef,
  toApiCriterion,
  toApiDifference,
  toApiProject,
  toApiQuestion,
  toApiRunSummary,
} from './mappers.js';

/**
 * Assembling one card in full.
 *
 * Every structured reading here goes through `safeParse` and falls back to
 * null. A card carries runs from before a contract changed shape, and a plan
 * the current schema no longer recognises should render as "no plan" — not
 * take the whole modal down with it.
 */
export async function cardDetail(
  db: Db,
  card: Card,
  projectName: string | null,
  laneColor: string | null,
  project: Project | null,
): Promise<CardDetail> {
  const runs = runsForCard(db, card.id);
  const claudeRuns = runs.filter((r) => r.kind === 'claude');
  const current = latestClaudeRunForStage(db, card.id, card.stage);

  return {
    card: toBoardCard(db, card, projectName, laneColor),
    project: project ? toApiProject(project) : null,
    criteria: criteriaFor(db, card.id).map(toApiCriterion),
    refs: refsFor(db, card.id).map(toApiCardRef),
    questions: current ? questionsForRun(db, current.id).map(toApiQuestion) : [],
    plan: latestPlan(claudeRuns),
    implementation: latestImplementation(claudeRuns),
    checks: latestChecks(db, card.id, claudeRuns),
    runs: runs.map(toApiRunSummary),
    events: cardEventsFor(db, card.id).map(toApiCardEvent),
    stageHistory: stageHistory(db, card.id),
    worktree: await worktreeFacts(db, card, project, runs),
    assets: assetsFor(db, card.id).map(toApiAsset),
    differences: differencesFor(db, card.id).map(toApiDifference),
  };
}

/**
 * The newest succeeded run for a stage whose output the current schema can
 * still read, with which attempt it was.
 *
 * Newest-first is the order `runsForCard` already returns, so this filters
 * rather than re-sorting. Skipping past output that no longer parses is
 * deliberate: a card can carry runs from before a contract changed shape, and
 * showing the last plan we can actually read beats showing none because the
 * most recent one is unintelligible.
 */
function latestReadable<T>(
  runs: Run[],
  stage: Stage,
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
): { run: Run; output: T; version: number } | null {
  const attempts = runs.filter((r) => r.stage === stage && r.status === 'succeeded');
  for (const [i, run] of attempts.entries()) {
    const parsed = schema.safeParse(run.structuredOutput);
    // attempts is newest-first, so the head is the highest version number.
    if (parsed.success) return { run, output: parsed.data, version: attempts.length - i };
  }
  return null;
}

/** When a run finished, falling back to when it started. */
const at = (run: Run): number => run.finishedAt?.getTime() ?? run.createdAt?.getTime() ?? 0;

function latestPlan(runs: Run[]): ApiPlan | null {
  const found = latestReadable(runs, 'planning', planningOutput);
  if (!found) return null;
  const { run, output: p, version } = found;
  return {
    runId: run.id,
    // The "v2" beside the tab: how many plans this card has had, not how many
    // runs it took to get them.
    version,
    createdAt: at(run),
    summary: p.summary,
    risk: p.risk,
    details: p.details,
    steps: p.steps.map((s) => ({
      title: s.title,
      detail: s.detail,
      files: s.files,
      blockedOnQuestion: s.blocked_on_question,
    })),
    filesToTouch: p.files_to_touch,
  };
}

function latestImplementation(runs: Run[]): ApiImplementation | null {
  const found = latestReadable(runs, 'in_progress', implementationOutput);
  if (!found) return null;
  const { run, output: i } = found;
  return {
    runId: run.id,
    createdAt: at(run),
    summary: i.summary,
    commits: i.commits,
    filesChanged: i.files_changed,
    deviations: i.deviations_from_plan,
    followUps: i.follow_ups,
  };
}

function latestChecks(db: Db, cardId: string, runs: Run[]): ApiChecks | null {
  const found = latestReadable(runs, 'testing', testingOutput);
  if (!found) return null;
  const { run, output: t } = found;
  // Counted from the criteria rows rather than the output, so the rail agrees
  // with the checklist even if a verdict referenced a number that isn't there.
  const criteria = criteriaFor(db, cardId);
  return {
    runId: run.id,
    createdAt: at(run),
    passed: t.passed,
    summary: t.summary,
    criteriaVerified: criteria.filter((c) => c.verdict === 'pass').length,
    criteriaTotal: criteria.length,
    differenceCount: differencesFor(db, cardId).length,
    failures: t.failures,
    fixesApplied: t.fixes_applied,
  };
}

/**
 * The worktree as it actually is, not as the process remembers it.
 *
 * The dev server's state comes off the persisted run row: a restart empties the
 * in-memory registry and kills every child, and the boot reaper marks those
 * runs interrupted — so the row survives a restart and the registry does not.
 */
async function worktreeFacts(
  db: Db,
  card: Card,
  project: Project | null,
  runs: Run[],
): Promise<ApiWorktree> {
  const baseBranch = project?.defaultBranch ?? 'main';
  const health = card.worktreePath && project
    ? await checkWorktree(project.repoPath, card.worktreePath)
    : { state: 'none' as const };
  const exists = health.state === 'ok';

  const server = runs.find((r) => r.kind === 'server') ?? null;
  return {
    branch: card.branchName,
    path: card.worktreePath,
    base: card.baseSha,
    baseBranch,
    behind: exists && card.worktreePath ? await behindBase(card.worktreePath, baseBranch) : null,
    exists,
    server: server
      ? {
          runId: server.id,
          running: server.status === 'running' || server.status === 'queued',
          port: server.port,
          url: server.port ? `http://localhost:${server.port}` : null,
          since: server.startedAt?.getTime() ?? null,
          errorMessage: server.errorMessage,
        }
      : null,
  };
}
