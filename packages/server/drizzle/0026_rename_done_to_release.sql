-- Done is now Release: the last column is a stage Claude works in, preparing the
-- pull request with the person, rather than a holding area. Every row that names
-- the stage is renamed with it, so a card's history reads the same as before.
UPDATE `card` SET `stage` = 'release' WHERE `stage` = 'done';
--> statement-breakpoint
UPDATE `run` SET `stage` = 'release' WHERE `stage` = 'done';
--> statement-breakpoint
UPDATE `card_event` SET `stage` = 'release' WHERE `stage` = 'done';
--> statement-breakpoint
UPDATE `card_event` SET `from_stage` = 'release' WHERE `from_stage` = 'done';
--> statement-breakpoint
UPDATE `card_event` SET `to_stage` = 'release' WHERE `to_stage` = 'done';
--> statement-breakpoint
UPDATE `question` SET `stage` = 'release' WHERE `stage` = 'done';
--> statement-breakpoint
UPDATE `artifact` SET `stage` = 'release' WHERE `stage` = 'done';
--> statement-breakpoint
UPDATE `review` SET `stage` = 'release' WHERE `stage` = 'done';
--> statement-breakpoint
UPDATE `review` SET `from_stage` = 'release' WHERE `from_stage` = 'done';
--> statement-breakpoint
UPDATE `review` SET `to_stage` = 'release' WHERE `to_stage` = 'done';
