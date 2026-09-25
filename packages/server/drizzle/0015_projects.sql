ALTER TABLE `card` ADD `kind` text DEFAULT 'task' NOT NULL;--> statement-breakpoint
-- drizzle-kit drops the ON DELETE from a column added by ALTER. Written by hand,
-- because a rebuild of `card` to get it back would cascade through every run.
ALTER TABLE `card` ADD `project_id` text REFERENCES card(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `card_project` ON `card` (`project_id`,`stage`,`position`);
