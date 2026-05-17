UPDATE `session`
SET `agent` = 'interactive'
WHERE `agent` = 'review';
--> statement-breakpoint
UPDATE `request_usage`
SET `agent` = 'interactive'
WHERE `agent` = 'review';
--> statement-breakpoint
UPDATE `message`
SET `data` = json_set(`data`, '$.agent', 'interactive')
WHERE json_extract(`data`, '$.agent') = 'review';
--> statement-breakpoint
UPDATE `message`
SET `data` = json_set(`data`, '$.mode', 'interactive')
WHERE json_extract(`data`, '$.mode') = 'review';
--> statement-breakpoint
UPDATE `session_message`
SET `data` = json_set(`data`, '$.agent', 'interactive')
WHERE json_extract(`data`, '$.agent') = 'review';
--> statement-breakpoint
UPDATE `event`
SET `data` = json_set(`data`, '$.agent', 'interactive')
WHERE json_extract(`data`, '$.agent') = 'review';
