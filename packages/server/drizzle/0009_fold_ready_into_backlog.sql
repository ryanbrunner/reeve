-- Ready for Planning is gone; its cards go back to Backlog, after the cards already there.
UPDATE `card` SET `position` = `position` + (SELECT COALESCE(MAX(`position`), 0) FROM `card` WHERE `stage` = 'backlog') WHERE `stage` = 'ready_for_planning';
--> statement-breakpoint
UPDATE `card` SET `stage` = 'backlog' WHERE `stage` = 'ready_for_planning';
--> statement-breakpoint
-- A move between Backlog and Ready is now a move from Backlog to Backlog, which would reset the rail's "since".
DELETE FROM `card_event` WHERE `kind` = 'moved' AND `from_stage` IN ('backlog', 'ready_for_planning') AND `to_stage` IN ('backlog', 'ready_for_planning');
--> statement-breakpoint
UPDATE `card_event` SET `stage` = 'backlog' WHERE `stage` = 'ready_for_planning';
--> statement-breakpoint
UPDATE `card_event` SET `from_stage` = 'backlog' WHERE `from_stage` = 'ready_for_planning';
--> statement-breakpoint
UPDATE `card_event` SET `to_stage` = 'backlog' WHERE `to_stage` = 'ready_for_planning';
