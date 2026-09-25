ALTER TABLE `project` RENAME TO `repo`;--> statement-breakpoint
ALTER TABLE `card` RENAME COLUMN `project_id` TO `repo_id`;--> statement-breakpoint
-- SQLite carries the foreign key and `card_number` across both renames, but not index names.
DROP INDEX `project_name_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `repo_name_unique` ON `repo` (`name`);--> statement-breakpoint
DROP INDEX `card_project`;--> statement-breakpoint
CREATE INDEX `card_repo` ON `card` (`repo_id`,`stage`,`position`);
