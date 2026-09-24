import { sql } from 'drizzle-orm';
import type { RunKind, RunStatus, Stage, StopReason } from '@reeve/shared';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Stage/kind/status vocabularies live in @reeve/shared so the board, the API and
 * the database cannot drift apart. They already had: this file said `killed`
 * where shared said `cancelled`.
 */
export type CardStage = Stage;
export type { RunKind, RunStatus, StopReason };

export const REVIEW_DECISIONS = ['approved', 'rejected'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const ARTIFACT_KINDS = ['plan', 'diff', 'test_report', 'summary'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' });

export const project = sqliteTable('project', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  repoPath: text('repo_path').notNull(),
  worktreeRoot: text('worktree_root').notNull(),
  defaultBranch: text('default_branch').notNull().default('main'),
  // Any of the four lifecycle commands may be blank.
  setupCommand: text('setup_command'),
  testCommand: text('test_command'),
  serverCommand: text('server_command'),
  teardownCommand: text('teardown_command'),
  finishCommand: text('finish_command'),
  allowedTools: text('allowed_tools', { mode: 'json' }).$type<string[]>(),
  laneColor: text('lane_color'),
  maxBudgetUsd: real('max_budget_usd'),
  archivedAt: timestamp('archived_at'),
  createdAt: timestamp('created_at').notNull().default(sql`(unixepoch() * 1000)`),
});

export const card = sqliteTable(
  'card',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => project.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    stage: text('stage').$type<CardStage>().notNull().default('backlog'),
    // Fractional index: reordering averages neighbours instead of rewriting the column.
    position: real('position').notNull(),
    priorityRank: integer('priority_rank'),
    priorityRationale: text('priority_rationale'),
    branchName: text('branch_name'),
    worktreePath: text('worktree_path'),
    // Captured once at worktree creation; the diff is `git diff <base_sha>` with no second ref.
    baseSha: text('base_sha'),
    activeRunId: text('active_run_id'),
    archivedAt: timestamp('archived_at'),
    createdAt: timestamp('created_at').notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: timestamp('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('card_board').on(t.stage, t.position),
    index('card_project').on(t.projectId, t.stage, t.position),
  ],
);

export const run = sqliteTable(
  'run',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => card.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<RunKind>().notNull(),
    stage: text('stage').$type<CardStage>().notNull(),
    status: text('status').$type<RunStatus>().notNull().default('queued'),

    // --- claude runs ---
    // Written BEFORE the subprocess exists, which is what makes the boot reaper useful.
    sessionId: text('session_id'),
    parentRunId: text('parent_run_id'),
    forkedFromSessionId: text('forked_from_session_id'),
    model: text('model'),
    effort: text('effort'),
    permissionMode: text('permission_mode'),
    maxBudgetUsd: real('max_budget_usd'),
    totalCostUsd: real('total_cost_usd'),
    usageJson: text('usage_json', { mode: 'json' }).$type<Record<string, unknown>>(),
    modelUsageJson: text('model_usage_json', { mode: 'json' }).$type<Record<string, unknown>>(),
    numTurns: integer('num_turns'),
    // What the SDK reported. Untrustworthy for cancellation: an aborted run was
    // measured reporting terminal_reason=completed.
    sdkStopReason: text('sdk_stop_reason'),
    sdkTerminalReason: text('sdk_terminal_reason'),
    // What the harness knows happened. This is the authoritative one.
    stopReason: text('stop_reason').$type<StopReason>(),
    resultText: text('result_text'),
    structuredOutput: text('structured_output', { mode: 'json' }).$type<unknown>(),
    permissionDenials: text('permission_denials', { mode: 'json' }).$type<unknown[]>(),

    // --- shell + server runs ---
    command: text('command'),
    pid: integer('pid'),
    port: integer('port'),
    exitCode: integer('exit_code'),

    // --- all runs ---
    prompt: text('prompt'),
    cwd: text('cwd').notNull(),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    createdAt: timestamp('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('run_card').on(t.cardId, t.createdAt),
    index('run_active').on(t.status),
    // Stops two runs claiming the same Claude session.
    uniqueIndex('run_session').on(t.sessionId),
  ],
);

export const runEvent = sqliteTable(
  'run_event',
  {
    runId: text('run_id')
      .notNull()
      .references(() => run.id, { onDelete: 'cascade' }),
    // Per-run monotonic. This IS the SSE event id.
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    sdkUuid: text('sdk_uuid'),
    // Raw SDKMessage JSON, verbatim, always — unknown message types are stored, never dropped.
    payload: text('payload').notNull(),
    at: timestamp('at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

export const artifact = sqliteTable(
  'artifact',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => card.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => run.id, { onDelete: 'set null' }),
    stage: text('stage').$type<CardStage>().notNull(),
    kind: text('kind').$type<ArtifactKind>().notNull(),
    path: text('path'),
    content: text('content').notNull(),
    supersededBy: text('superseded_by'),
    createdAt: timestamp('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index('artifact_card').on(t.cardId, t.stage, t.createdAt)],
);

export const review = sqliteTable(
  'review',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => card.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => run.id, { onDelete: 'set null' }),
    artifactId: text('artifact_id').references(() => artifact.id),
    stage: text('stage').$type<CardStage>().notNull(),
    decision: text('decision').$type<ReviewDecision>().notNull(),
    // On reject this becomes the next (forked) run's prompt.
    notes: text('notes'),
    fromStage: text('from_stage').$type<CardStage>().notNull(),
    toStage: text('to_stage').$type<CardStage>().notNull(),
    createdAt: timestamp('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index('review_card').on(t.cardId, t.createdAt)],
);

export type Project = typeof project.$inferSelect;
export type NewProject = typeof project.$inferInsert;
export type Card = typeof card.$inferSelect;
export type NewCard = typeof card.$inferInsert;
export type Run = typeof run.$inferSelect;
export type NewRun = typeof run.$inferInsert;
export type RunEvent = typeof runEvent.$inferSelect;
export type NewRunEvent = typeof runEvent.$inferInsert;
export type Artifact = typeof artifact.$inferSelect;
export type Review = typeof review.$inferSelect;
