import { sql } from 'drizzle-orm';
import type { CardKind, DevServerUrlSource, EffortLevel, RunKind, RunStatus, Stage, StageRunDefaults, StopReason } from '@reeve/shared';
import {
  index,
  integer,
  type AnySQLiteColumn,
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
export type { CardKind, RunKind, RunStatus, StopReason };

export const REVIEW_DECISIONS = ['approved', 'rejected'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const ARTIFACT_KINDS = ['plan', 'diff', 'test_report', 'summary'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * Who did a thing, at the only resolution this tool has: a person, or Claude.
 * `card_event.actorId` is the seat kept warm for a real user table.
 */
export const CARD_EVENT_ACTORS = ['human', 'claude'] as const;
export type CardEventActor = (typeof CARD_EVENT_ACTORS)[number];

export const CRITERION_VERDICTS = ['pass', 'fail'] as const;
export type CriterionVerdict = (typeof CRITERION_VERDICTS)[number];

/** A picture of the work: one drawn beforehand, or one taken of the build. */
export const ASSET_KINDS = ['mockup', 'screenshot'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** What a piece of context points at: a path in the repo, another card, a link. */
export const CARD_REF_KINDS = ['file', 'card', 'url'] as const;
export type CardRefKind = (typeof CARD_REF_KINDS)[number];

export const CARD_EVENT_KINDS = [
  'created',
  'moved',
  'run_started',
  'run_finished',
  'reviewed',
  'question_asked',
  'answered',
  'note',
  // Written when the card's pull request is seen merged on GitHub. Cards that
  // squash-merged before pull requests replaced that also carry one.
  'merged',
  'pr_opened',
  'pr_failed',
  'archived',
  'restored',
  'handed_off',
  // A review in Crit that ended without a verdict: stopped, failed, or
  // finished after the plan had already moved on. One that reached a verdict
  // writes `reviewed` instead, the same as the buttons.
  'crit_reviewed',
  // The Done band's Resolve conflicts: the base branch merged in and pushed to
  // the pull request, or the reason the branch was put back as it was.
  'conflicts_resolved',
  'conflicts_failed',
  // `gh` refused to merge the pull request: from the Done band's Merge, or
  // VIBES MODE landing it. Success is `merged`, written once GitHub says so.
  'merge_failed',
  // An open card moved to No project because its project was archived. `meta`
  // names the project, which the card no longer points at.
  'left_project',
] as const;
export type CardEventKind = (typeof CARD_EVENT_KINDS)[number];

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' });

export const repo = sqliteTable('repo', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  repoPath: text('repo_path').notNull(),
  worktreeRoot: text('worktree_root').notNull(),
  defaultBranch: text('default_branch').notNull().default('main'),
  // Any of the four lifecycle commands may be blank.
  setupCommand: text('setup_command'),
  testCommand: text('test_command'),
  serverCommand: text('server_command'),
  // Where the dev server can be reached when the repo knows better than the
  // server's own output, e.g. `https://{{slug}}.test` behind a local proxy.
  // Filled by `fillVars` in runs/serverUrl.ts. Null leaves it to the command.
  serverUrl: text('server_url'),
  teardownCommand: text('teardown_command'),
  finishCommand: text('finish_command'),
  allowedTools: text('allowed_tools', { mode: 'json' }).$type<string[]>(),
  laneColor: text('lane_color'),
  // Fast-forward the repo's own default branch once one of its cards' pull
  // requests is merged. Off unless asked for: it moves the person's checkout,
  // which nothing else in Reeve touches.
  syncDefaultBranch: integer('sync_default_branch', { mode: 'boolean' }).notNull().default(false),
  archivedAt: timestamp('archived_at'),
  createdAt: timestamp('created_at').notNull().default(sql`(unixepoch() * 1000)`),
});

export const card = sqliteTable(
  'card',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<CardKind>().notNull().default('task'),
    // The project this card belongs to, if any. A project's own repo is its
    // default: the one its split reads, and the one its tasks fall back to.
    projectId: text('project_id').references((): AnySQLiteColumn => card.id, { onDelete: 'set null' }),
    repoId: text('repo_id').references(() => repo.id, { onDelete: 'restrict' }),
    /**
     * Per-repo, monotonic, and the only human-sized name a card has: `#142`.
     * The default exists solely so SQLite could add the column to existing rows
     * — the migration backfills them and `createCard` has assigned one ever
     * since, so a zero here means something inserted behind that function.
     */
    number: integer('number').notNull().default(0),
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
    /**
     * The squash commit this card landed as on the default branch. Stored
     * rather than derived like everything else about a card: a squash leaves no
     * ancestry to test, and the branch that could have told us is deleted.
     * Only cards from before pull requests replaced the merge have one.
     */
    mergedSha: text('merged_sha'),
    // Set for those, and for a card whose pull request GitHub has merged.
    mergedAt: timestamp('merged_at'),
    /**
     * The pull request this card's branch was opened as. Stored because asking
     * GitHub on every board poll would be slow, and would fail offline.
     */
    prUrl: text('pr_url'),
    prNumber: integer('pr_number'),
    prOpenedAt: timestamp('pr_opened_at'),
    activeRunId: text('active_run_id'),
    // This card's override for every stage run. Null falls through to the
    // Settings default for the stage, then to the stage module's own value.
    model: text('model'),
    effort: text('effort').$type<EffortLevel>(),
    // Whether Planning draws its own mockups for the states this card changes.
    // The `true` default only filled in the cards that predate the column, and
    // they keep it. New cards are opt-in, decided by `createCard`: changing the
    // default here would mean SQLite rebuilding the table, and dropping `card`
    // inside drizzle's migration transaction cascades through everything
    // hanging off it.
    generateMockups: integer('generate_mockups', { mode: 'boolean' }).notNull().default(true),
    // VIBES MODE for this card alone: the sweep takes it all the way to a
    // merged pull request while the board's own switch is off. A flag rather
    // than a timestamp like `settings.vibesSince`, which is only there to give
    // the HUD something to count from, and one card has no HUD. The column
    // keeps the mode's old name, SICKO MODE: renaming it would be a migration
    // for a name nobody sees. On a project it means every task in its lane,
    // and the project itself is never swept (`vibesCards`).
    vibes: integer('sicko', { mode: 'boolean' }).notNull().default(false),
    archivedAt: timestamp('archived_at'),
    createdAt: timestamp('created_at').notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: timestamp('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index('card_board').on(t.stage, t.position),
    index('card_repo').on(t.repoId, t.stage, t.position),
    index('card_number').on(t.repoId, t.number),
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
    // Null for a stage's own attempt. Set to the task's id for work done beside
    // the stage — the brief's Suggest — which must never read as the card's
    // current run, however recently it finished.
    task: text('task'),

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
    // What Claude was last doing and thinking, kept current as messages arrive
    // so the modal opens on it rather than on "Starting up". Read off the row
    // because the last thinking block can sit thousands of events back.
    lastActivity: text('last_activity'),
    lastThinking: text('last_thinking'),

    // --- shell + server runs ---
    command: text('command'),
    pid: integer('pid'),
    port: integer('port'),
    // Where a server run can actually be reached, and how Reeve knows. Null
    // until something says: the port above is only what Reeve offered, and a
    // server that ignores PORT (Vite does) is somewhere else entirely.
    url: text('url'),
    urlSource: text('url_source').$type<DevServerUrlSource>(),
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

/**
 * The card's story, in the terms a person tells it: moved, ran, asked, answered.
 *
 * Deliberately not `run_event`, which is the raw SDK transcript — thousands of
 * rows a run, in Claude's vocabulary rather than the human's. This table is
 * written at the handful of moments that would appear in a changelog, and one
 * table serves three surfaces: the activity timeline, the stage rail's "since
 * 10:38", and the card's own age. Stage history is read back off the `moved`
 * rows rather than kept in a second table that could disagree with this one.
 */
export const cardEvent = sqliteTable(
  'card_event',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => card.id, { onDelete: 'cascade' }),
    actor: text('actor').$type<CardEventActor>().notNull(),
    // Nothing writes this yet. It is here so that the day there is a user table,
    // adding it is a column filling in rather than a migration over every row.
    actorId: text('actor_id'),
    kind: text('kind').$type<CardEventKind>().notNull(),
    // The stage the card was in when this happened, not where it went.
    stage: text('stage').$type<CardStage>(),
    runId: text('run_id').references(() => run.id, { onDelete: 'set null' }),
    fromStage: text('from_stage').$type<CardStage>(),
    toStage: text('to_stage').$type<CardStage>(),
    body: text('body'),
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index('card_event_card').on(t.cardId, t.createdAt)],
);

/**
 * What "done" means for this card, in the human's words before Claude writes a
 * line — and afterwards, in Testing, the checklist Claude marks off.
 *
 * Both readings are the same rows: the brief's numbered list and the rail's
 * "6 of 6 verified" cannot disagree because there is nothing for them to
 * disagree about. A verdict belongs to the run that reached it, so re-running
 * Testing replaces the verdicts without touching what was asked for.
 */
export const acceptanceCriterion = sqliteTable(
  'acceptance_criterion',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => card.id, { onDelete: 'cascade' }),
    // Fractional, like card.position: reordering rewrites one row, not the list.
    position: real('position').notNull(),
    text: text('text').notNull(),
    // Whether a person wrote this or accepted Claude's suggestion of it.
    source: text('source').$type<CardEventActor>().notNull().default('human'),
    verifiedRunId: text('verified_run_id').references(() => run.id, { onDelete: 'set null' }),
    verdict: text('verdict').$type<CriterionVerdict>(),
    /** How Claude knows: a test name, a screenshot label, a line of output. */
    evidence: text('evidence'),
    createdAt: timestamp('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index('criterion_card').on(t.cardId, t.position)],
);

/** The handful of things worth reading before starting: files, cards, links. */
export const cardRef = sqliteTable(
  'card_ref',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => card.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<CardRefKind>().notNull(),
    /** A repo-relative path, another card's id, or a URL, per `kind`. */
    value: text('value').notNull(),
    label: text('label'),
    createdAt: timestamp('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index('card_ref_card').on(t.cardId, t.createdAt)],
);

/**
 * One card that cannot start before another finishes. Its own table rather
 * than a `card_ref` of kind `card`: a ref is something worth reading first,
 * and reading every existing one as a blocker would jam cards nobody meant to.
 * A dependency also has to be read both ways — what this card waits on, and
 * what waits on it — which a ref's free-text `value` cannot be indexed for.
 *
 * The pair is the key, so the same link twice is one row — which is what lets
 * a project's Split run again without doubling every link it proposed.
 *
 * Only tasks take part, and the links never form a cycle; the table cannot say
 * either, so `../dependencies.ts` refuses them before a row is written.
 */
export const cardDependency = sqliteTable(
  'card_dependency',
  {
    cardId: text('card_id')
      .notNull()
      .references(() => card.id, { onDelete: 'cascade' }),
    dependsOnId: text('depends_on_id')
      .notNull()
      .references(() => card.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  // The key serves "what does this card wait on"; the index, the other way.
  (t) => [primaryKey({ columns: [t.cardId, t.dependsOnId] }), index('card_dependency_on').on(t.dependsOnId)],
);

/**
 * A question Claude could not answer for itself, and the human's answer.
 *
 * Stored as rows rather than left in the run's structured output because they
 * are answered one at a time, by a person, possibly hours later — and because
 * `position` is the number shown in the card, which is how a plan step says
 * "waits on question 2". Written in array order so that number means the same
 * thing on both sides.
 */
export const question = sqliteTable(
  'question',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => card.id, { onDelete: 'cascade' }),
    // The run that asked. A later attempt asks its own questions rather than
    // inheriting these, so the band always shows one run's worth.
    runId: text('run_id').references(() => run.id, { onDelete: 'cascade' }),
    stage: text('stage').$type<CardStage>().notNull(),
    /** 1-based, and the number a person sees. */
    position: integer('position').notNull(),
    text: text('text').notNull(),
    /** Concrete answers offered as buttons; the human may write their own. */
    suggestions: text('suggestions', { mode: 'json' }).$type<string[]>(),
    answer: text('answer'),
    answeredAt: timestamp('answered_at'),
    createdAt: timestamp('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index('question_card').on(t.cardId, t.position), index('question_run').on(t.runId, t.position)],
);

/**
 * An image belonging to a card: a mockup someone attached or Planning drew, or
 * a screenshot of what got built.
 *
 * The bytes live on disk under `config.assetsDir` and the row holds the path.
 * A database is a bad place for blobs, and keeping them out means a screenshot
 * costs the same to list as it does to ignore.
 *
 * `url` and `viewport` are what a mockup asks for and what a screenshot answers
 * — a mockup of the cart at 1280 tells the capturer exactly what to go and
 * photograph, which is how the two end up side by side.
 */
export const asset = sqliteTable(
  'asset',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => card.id, { onDelete: 'cascade' }),
    // Set on a screenshot: the run that captured it. On a mockup, the planning
    // run that drew it, which the next plan replaces; null on one a person
    // attached, which outlives every run.
    runId: text('run_id').references(() => run.id, { onDelete: 'set null' }),
    kind: text('kind').$type<AssetKind>().notNull(),
    label: text('label').notNull(),
    /** The app path this shows, e.g. `/cart`. */
    url: text('url'),
    /** Viewport width in CSS pixels. */
    viewport: integer('viewport'),
    /** Relative to config.assetsDir, never absolute: the data dir can move. */
    path: text('path').notNull(),
    contentType: text('content_type').notNull(),
    width: integer('width'),
    height: integer('height'),
    createdAt: timestamp('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index('asset_card').on(t.cardId, t.createdAt)],
);

/**
 * A place the build and the mockup disagree, in Claude's words.
 *
 * Prose rather than pixels on purpose: "Save for later is a link here but a
 * button in the mockup" is a judgement about intent, and a pixel differ would
 * report the same thing as eleven thousand changed pixels.
 */
export const difference = sqliteTable(
  'difference',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => card.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => run.id, { onDelete: 'cascade' }),
    mockupAssetId: text('mockup_asset_id').references(() => asset.id, { onDelete: 'cascade' }),
    screenshotAssetId: text('screenshot_asset_id').references(() => asset.id, { onDelete: 'cascade' }),
    /** 1-based, and the number shown in the callout beside the images. */
    position: integer('position').notNull(),
    /** The difference itself, in one sentence. */
    claim: text('claim').notNull(),
    /** Why it happened, or why it might be fine. Shown muted beside the claim. */
    note: text('note'),
    createdAt: timestamp('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index('difference_card').on(t.cardId, t.position)],
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

/**
 * Reeve's own knobs, as opposed to a repo's. One row, id 1, written on first
 * save — until then there is no row and every field reads its default.
 *
 * Typed columns rather than a key/value bag: there are few of these, and a
 * column is a setting whose type the database already knows. A null field
 * means "not set here", which falls through to the environment in `config`.
 */
export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey(),
  maxConcurrentRuns: integer('max_concurrent_runs'),
  /**
   * When VIBES MODE was switched on, or null while it is off.
   *
   * A timestamp rather than a flag because every number the HUD shows is
   * counted from it — merges, skipped reviews, self-answered questions, spend —
   * and those are read off `card_event` and `run` rows on demand rather than
   * kept in counters that a reload would reset and that could drift from what
   * actually happened. One column is both the switch and the epoch. Its name
   * is the mode's old one, kept for the same reason as the card's `sicko` column.
   */
  vibesSince: timestamp('sicko_since'),
  /**
   * The one exception to typed columns: a model and effort per runnable stage.
   * This is a map keyed by stage, not a handful of knobs, and a stage added
   * later should not need a migration. A stage missing from it is unset.
   */
  stageDefaults: text('stage_defaults', { mode: 'json' }).$type<Partial<StageRunDefaults>>(),
});

export type Repo = typeof repo.$inferSelect;
export type NewRepo = typeof repo.$inferInsert;
export type Card = typeof card.$inferSelect;
export type NewCard = typeof card.$inferInsert;
export type Run = typeof run.$inferSelect;
export type NewRun = typeof run.$inferInsert;
export type RunEvent = typeof runEvent.$inferSelect;
export type NewRunEvent = typeof runEvent.$inferInsert;
export type CardEvent = typeof cardEvent.$inferSelect;
export type NewCardEvent = typeof cardEvent.$inferInsert;
export type AcceptanceCriterion = typeof acceptanceCriterion.$inferSelect;
export type Question = typeof question.$inferSelect;
export type Asset = typeof asset.$inferSelect;
export type Difference = typeof difference.$inferSelect;
export type CardRef = typeof cardRef.$inferSelect;
export type CardDependency = typeof cardDependency.$inferSelect;
export type Artifact = typeof artifact.$inferSelect;
export type Review = typeof review.$inferSelect;
