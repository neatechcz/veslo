CREATE TABLE `debug_log_batch` (
  `id` varchar(64) NOT NULL,
  `batch_id` varchar(128) NOT NULL,
  `idempotency_key` varchar(255) NOT NULL,
  `event_count` int unsigned NOT NULL,
  `expires_at` timestamp(3) NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  CONSTRAINT `debug_log_batch_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `debug_log_batch_batch_id` ON `debug_log_batch` (`batch_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `debug_log_batch_idempotency_key` ON `debug_log_batch` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `debug_log_batch_expires_at` ON `debug_log_batch` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `debug_log_event` (
  `id` varchar(64) NOT NULL,
  `batch_id` varchar(128) NOT NULL,
  `event_id` varchar(128) NOT NULL,
  `user_id` varchar(128) NOT NULL,
  `org_id` varchar(128) NOT NULL,
  `workspace_id` varchar(128) NOT NULL,
  `worker_id` varchar(128),
  `session_id` varchar(128),
  `run_id` varchar(128),
  `source` varchar(64) NOT NULL,
  `stream` varchar(32) NOT NULL,
  `level` varchar(16),
  `event_timestamp` timestamp(3) NOT NULL,
  `sequence_no` int unsigned NOT NULL,
  `payload_sha256` varchar(64) NOT NULL,
  `payload_bytes` int unsigned NOT NULL,
  `encryption_key_version` varchar(128) NOT NULL,
  `payload_ciphertext` longtext NOT NULL,
  `payload_iv` text NOT NULL,
  `payload_auth_tag` text NOT NULL,
  `expires_at` timestamp(3) NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  CONSTRAINT `debug_log_event_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `debug_log_event_batch_event` ON `debug_log_event` (`batch_id`, `event_id`);
--> statement-breakpoint
CREATE INDEX `debug_log_event_user_time` ON `debug_log_event` (`user_id`, `event_timestamp`);
--> statement-breakpoint
CREATE INDEX `debug_log_event_org_time` ON `debug_log_event` (`org_id`, `event_timestamp`);
--> statement-breakpoint
CREATE INDEX `debug_log_event_workspace_time` ON `debug_log_event` (`workspace_id`, `event_timestamp`);
--> statement-breakpoint
CREATE INDEX `debug_log_event_session_time` ON `debug_log_event` (`session_id`, `event_timestamp`);
--> statement-breakpoint
CREATE INDEX `debug_log_event_run_time` ON `debug_log_event` (`run_id`, `event_timestamp`);
--> statement-breakpoint
CREATE INDEX `debug_log_event_expires_at` ON `debug_log_event` (`expires_at`);
