ALTER TABLE `credential_usage_event`
  ADD COLUMN `org_id` varchar(64),
  ADD COLUMN `cached_tokens` int NOT NULL DEFAULT 0,
  ADD COLUMN `total_tokens` int NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE `credential_usage_event`
SET `total_tokens` = `input_tokens` + `output_tokens`
WHERE `total_tokens` = 0;
--> statement-breakpoint
CREATE INDEX `credential_usage_event_org_provider` ON `credential_usage_event` (`org_id`, `provider`);
--> statement-breakpoint
CREATE INDEX `credential_usage_event_credential_created` ON `credential_usage_event` (`credential_record_id`, `created_at`);
