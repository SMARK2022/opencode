CREATE TABLE `cold_storage` (
	`hash` text PRIMARY KEY,
	`kind` text NOT NULL,
	`codec` text NOT NULL,
	`payload` blob NOT NULL,
	`raw_bytes` integer NOT NULL,
	`compressed_bytes` integer NOT NULL,
	`ref_count` integer DEFAULT 0 NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `message` ADD `cold_ref` text REFERENCES cold_storage(hash);--> statement-breakpoint
ALTER TABLE `part` ADD `cold_ref` text REFERENCES cold_storage(hash);--> statement-breakpoint
CREATE INDEX `cold_storage_ref_count_idx` ON `cold_storage` (`ref_count`);--> statement-breakpoint
CREATE INDEX `message_cold_ref_idx` ON `message` (`cold_ref`);--> statement-breakpoint
CREATE INDEX `part_cold_ref_idx` ON `part` (`cold_ref`);