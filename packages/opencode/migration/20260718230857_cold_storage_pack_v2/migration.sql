ALTER TABLE `message` ADD `cold_key` blob;--> statement-breakpoint
ALTER TABLE `part` ADD `cold_key` blob;--> statement-breakpoint
ALTER TABLE `part` ADD `cold_stats` text;--> statement-breakpoint
ALTER TABLE `session` ADD `summary_ref` text REFERENCES cold_storage(hash);--> statement-breakpoint
ALTER TABLE `session` ADD `summary_cursor` text;--> statement-breakpoint
ALTER TABLE `session` ADD `summary_initialized` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `summary_init_dirty` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `summary_seed` text;--> statement-breakpoint
CREATE INDEX `session_summary_ref_idx` ON `session` (`summary_ref`);
