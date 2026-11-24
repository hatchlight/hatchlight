CREATE TABLE `lora_uploads` (
	`lora_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lora_uploads_user` ON `lora_uploads` (`user_id`);