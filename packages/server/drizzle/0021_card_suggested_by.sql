-- drizzle-kit drops the ON DELETE from a column added by ALTER, as in 0015.
-- Written by hand, because a rebuild of `card` to get it back would cascade
-- through every run.
ALTER TABLE `card` ADD `suggested_by_id` text REFERENCES card(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `card_suggested_by` ON `card` (`suggested_by_id`);
