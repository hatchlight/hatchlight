ALTER TABLE `api_tokens` ADD `ref` text;--> statement-breakpoint
-- Tokens from before had no scopes, and could do nothing once scopes are
-- enforced; none were handed out by the app. They go.
DELETE FROM `api_tokens`;--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_ref` ON `api_tokens` (`ref`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `token_id` text;--> statement-breakpoint
ALTER TABLE `spending` ADD `token_id` text;--> statement-breakpoint
CREATE INDEX `spending_token` ON `spending` (`token_id`);