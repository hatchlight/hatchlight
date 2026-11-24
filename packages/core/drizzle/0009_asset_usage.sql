CREATE TABLE `asset_usage` (
	`user_id` text PRIMARY KEY NOT NULL,
	`bytes` integer NOT NULL
);
--> statement-breakpoint
-- What is stored already: each file once per person, as on disk.
INSERT INTO `asset_usage` (`user_id`, `bytes`)
SELECT `user_id`, sum(`size`) FROM (SELECT DISTINCT `user_id`, `hash`, `size` FROM `assets`) GROUP BY `user_id`;
