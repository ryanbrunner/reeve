CREATE TABLE `question` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`run_id` text,
	`stage` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`suggestions` text,
	`answer` text,
	`answered_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `card`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `question_card` ON `question` (`card_id`,`position`);--> statement-breakpoint
CREATE INDEX `question_run` ON `question` (`run_id`,`position`);