CREATE TABLE `asset` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`run_id` text,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`url` text,
	`viewport` integer,
	`path` text NOT NULL,
	`content_type` text NOT NULL,
	`width` integer,
	`height` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `card`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `asset_card` ON `asset` (`card_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `difference` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`run_id` text,
	`mockup_asset_id` text,
	`screenshot_asset_id` text,
	`position` integer NOT NULL,
	`claim` text NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `card`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mockup_asset_id`) REFERENCES `asset`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`screenshot_asset_id`) REFERENCES `asset`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `difference_card` ON `difference` (`card_id`,`position`);