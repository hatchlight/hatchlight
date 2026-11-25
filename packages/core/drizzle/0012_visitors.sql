CREATE TABLE `visitors` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`media_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `visitors_user` ON `visitors` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `visitors_media` ON `visitors` (`media_id`);--> statement-breakpoint
CREATE INDEX `visitors_last_seen` ON `visitors` (`last_seen_at`);