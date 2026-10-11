ALTER TABLE `card` ADD `stacked_on_id` text;--> statement-breakpoint
ALTER TABLE `card` ADD `max_turns` integer;--> statement-breakpoint
ALTER TABLE `repo` ADD `focused_test_command` text;--> statement-breakpoint
CREATE INDEX `run_event_rate_limit` ON `run_event` (`at`) WHERE "run_event"."kind" = 'unknown:rate_limit_event';