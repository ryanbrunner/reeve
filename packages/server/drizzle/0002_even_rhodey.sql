CREATE TABLE `acceptance_criterion` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`position` real NOT NULL,
	`text` text NOT NULL,
	`source` text DEFAULT 'human' NOT NULL,
	`verified_run_id` text,
	`verdict` text,
	`evidence` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `card`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`verified_run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `criterion_card` ON `acceptance_criterion` (`card_id`,`position`);--> statement-breakpoint
CREATE TABLE `card_ref` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`label` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `card`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `card_ref_card` ON `card_ref` (`card_id`,`created_at`);