CREATE TABLE `card_event` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`actor` text NOT NULL,
	`actor_id` text,
	`kind` text NOT NULL,
	`stage` text,
	`run_id` text,
	`from_stage` text,
	`to_stage` text,
	`body` text,
	`meta` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `card`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `card_event_card` ON `card_event` (`card_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `card` ADD `number` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `card_number` ON `card` (`project_id`,`number`);--> statement-breakpoint
-- Number the cards that predate the column, oldest first within each project.
UPDATE `card` SET `number` = (
	SELECT `rn` FROM (
		SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `project_id` ORDER BY `created_at`, `id`) AS `rn`
		FROM `card`
	) AS `numbered` WHERE `numbered`.`id` = `card`.`id`
);--> statement-breakpoint
-- Give every existing card the one event we can state as fact. Their stage
-- changes are genuinely lost, and a blank "since" in the rail is more honest
-- than inventing a time for a move nobody recorded.
INSERT INTO `card_event` (`id`, `card_id`, `actor`, `kind`, `stage`, `created_at`)
SELECT lower(hex(randomblob(16))), `id`, 'human', 'created', `stage`, `created_at` FROM `card`;
