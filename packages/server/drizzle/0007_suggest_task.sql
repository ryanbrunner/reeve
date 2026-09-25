ALTER TABLE `run` ADD `task` text;--> statement-breakpoint
UPDATE `run` SET `task` = 'suggest_criteria' WHERE `kind` = 'claude' AND `prompt` LIKE 'You are reading a piece of planned work%proposing what "done" should mean%';
