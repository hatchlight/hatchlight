CREATE TABLE `spending` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`job_id` text,
	`cost_usd` real NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `spending_user_created` ON `spending` (`user_id`,`created_at`);--> statement-breakpoint
-- What jobs already cost, so a limit counts the month from its start.
INSERT INTO `spending` (`id`, `user_id`, `kind`, `job_id`, `cost_usd`, `created_at`)
SELECT 'spd_' || `id`, `user_id`, 'generation', `id`, `cost_usd`, coalesce(`finished_at`, `created_at`)
FROM `jobs` WHERE `cost_usd` IS NOT NULL AND `cost_usd` > 0;
