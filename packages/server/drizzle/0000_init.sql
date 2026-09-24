CREATE TABLE `artifact` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`run_id` text,
	`stage` text NOT NULL,
	`kind` text NOT NULL,
	`path` text,
	`content` text NOT NULL,
	`superseded_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `card`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `artifact_card` ON `artifact` (`card_id`,`stage`,`created_at`);--> statement-breakpoint
CREATE TABLE `card` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`stage` text DEFAULT 'backlog' NOT NULL,
	`position` real NOT NULL,
	`priority_rank` integer,
	`priority_rationale` text,
	`branch_name` text,
	`worktree_path` text,
	`base_sha` text,
	`active_run_id` text,
	`archived_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `card_board` ON `card` (`stage`,`position`);--> statement-breakpoint
CREATE INDEX `card_project` ON `card` (`project_id`,`stage`,`position`);--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repo_path` text NOT NULL,
	`worktree_root` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`setup_command` text,
	`test_command` text,
	`server_command` text,
	`teardown_command` text,
	`finish_command` text,
	`allowed_tools` text,
	`lane_color` text,
	`max_budget_usd` real,
	`archived_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_name_unique` ON `project` (`name`);--> statement-breakpoint
CREATE TABLE `review` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`run_id` text,
	`artifact_id` text,
	`stage` text NOT NULL,
	`decision` text NOT NULL,
	`notes` text,
	`from_stage` text NOT NULL,
	`to_stage` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `card`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifact`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `review_card` ON `review` (`card_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `run` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`kind` text NOT NULL,
	`stage` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`session_id` text,
	`parent_run_id` text,
	`forked_from_session_id` text,
	`model` text,
	`effort` text,
	`permission_mode` text,
	`max_budget_usd` real,
	`total_cost_usd` real,
	`usage_json` text,
	`model_usage_json` text,
	`num_turns` integer,
	`sdk_stop_reason` text,
	`sdk_terminal_reason` text,
	`stop_reason` text,
	`result_text` text,
	`structured_output` text,
	`permission_denials` text,
	`command` text,
	`pid` integer,
	`port` integer,
	`exit_code` integer,
	`prompt` text,
	`cwd` text NOT NULL,
	`error_message` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `card`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_card` ON `run` (`card_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `run_active` ON `run` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `run_session` ON `run` (`session_id`);--> statement-breakpoint
CREATE TABLE `run_event` (
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`sdk_uuid` text,
	`payload` text NOT NULL,
	`at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`run_id`, `seq`),
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade
);
