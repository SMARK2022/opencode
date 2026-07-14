ALTER TABLE `session_goal` ADD `generation` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_goal` ADD `reason` text;--> statement-breakpoint
ALTER TABLE `session_goal` ADD `blocked_reason` text;--> statement-breakpoint
ALTER TABLE `session_goal` ADD `blocked_streak` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_goal` ADD `blocked_last_turn_id` text;--> statement-breakpoint
ALTER TABLE `session_goal` ADD `terminal_turn_id` text;--> statement-breakpoint
-- 旧 terminal 行的 reason 无法恢复，写入诚实兼容标记而非 null 或伪造理由。
-- active/paused 行的 reason 保持 null（默认值），不触碰。
UPDATE `session_goal` SET `reason` = 'Legacy terminal transition (reason unavailable)' WHERE `status` IN ('complete', 'blocked');