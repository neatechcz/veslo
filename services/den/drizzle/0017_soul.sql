CREATE TABLE `soul_document` (
  `id` varchar(64) NOT NULL,
  `scope` enum('organization','user') NOT NULL,
  `owner_id` varchar(128) NOT NULL,
  `current_version_id` varchar(64),
  `heartbeat_enabled` boolean NOT NULL DEFAULT false,
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `soul_document_id` PRIMARY KEY(`id`),
  CONSTRAINT `soul_document_scope_owner` UNIQUE(`scope`,`owner_id`)
);
--> statement-breakpoint
CREATE INDEX `soul_document_owner` ON `soul_document` (`owner_id`);
--> statement-breakpoint
CREATE TABLE `soul_version` (
  `id` varchar(64) NOT NULL,
  `document_id` varchar(64) NOT NULL,
  `scope` enum('organization','user') NOT NULL,
  `owner_id` varchar(128) NOT NULL,
  `content` longtext NOT NULL,
  `change_summary` varchar(2048) NOT NULL,
  `created_by` varchar(64) NOT NULL,
  `source` enum('manual','api','heartbeat','restore','system') NOT NULL,
  `base_version_id` varchar(64),
  `restore_source_version_id` varchar(64),
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  CONSTRAINT `soul_version_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `soul_version_document_created` ON `soul_version` (`document_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `soul_version_scope_owner` ON `soul_version` (`scope`,`owner_id`);
