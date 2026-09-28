ALTER TABLE `card` ADD `suggestion_accepted_at` integer;--> statement-breakpoint
-- Written by hand, as in 0009. A suggestion that has already left Backlog, or
-- been archived, was decided on before there was anywhere to say so; only the
-- ones still waiting in Backlog are left to ask about. Stamped with when the
-- card was made, since when it was taken on was never recorded.
UPDATE `card` SET `suggestion_accepted_at` = `created_at`
  WHERE `suggested_by_id` IS NOT NULL AND (`stage` != 'backlog' OR `archived_at` IS NOT NULL);
