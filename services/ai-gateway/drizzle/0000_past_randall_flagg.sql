CREATE TABLE `audit_event` (
	`id` varchar(64) NOT NULL,
	`actor_user_id` varchar(64),
	`entity_type` varchar(64) NOT NULL,
	`entity_id` varchar(64) NOT NULL,
	`action` varchar(64) NOT NULL,
	`result` varchar(32) NOT NULL,
	`summary` text,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `audit_event_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user_ai_access_policy` (
	`id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`enabled` int NOT NULL DEFAULT 1,
	`provider` varchar(64),
	`default_model` varchar(128),
	`allowed_models_json` text NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `user_ai_access_policy_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_ai_access_policy_user_id` UNIQUE(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `credential_binding` (
	`id` varchar(64) NOT NULL,
	`owner_user_id` varchar(64) NOT NULL,
	`provider` varchar(64) NOT NULL,
	`credential_record_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `credential_binding_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `credential_health_event` (
	`id` varchar(64) NOT NULL,
	`credential_record_id` varchar(64) NOT NULL,
	`from_state` enum('healthy','degraded','draining','unhealthy','revoked'),
	`to_state` enum('healthy','degraded','draining','unhealthy','revoked') NOT NULL,
	`reason` text,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `credential_health_event_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `credential_record` (
	`id` varchar(64) NOT NULL,
	`name` varchar(255),
	`owner_user_id` varchar(64) NOT NULL,
	`provider` varchar(64) NOT NULL,
	`credential_type` enum('api_key','oauth') NOT NULL,
	`state` enum('healthy','degraded','draining','unhealthy','revoked') NOT NULL,
	`secret_ref` varchar(255) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `credential_record_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `credential_secret` (
	`secret_ref` varchar(255) NOT NULL,
	`iv` text NOT NULL,
	`auth_tag` text NOT NULL,
	`ciphertext` text NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `credential_secret_secret_ref` PRIMARY KEY(`secret_ref`)
);
--> statement-breakpoint
CREATE TABLE `credential_usage_event` (
	`id` varchar(64) NOT NULL,
	`owner_user_id` varchar(64) NOT NULL,
	`provider` varchar(64) NOT NULL,
	`credential_record_id` varchar(64) NOT NULL,
	`credential_binding_id` varchar(64) NOT NULL,
	`session_id` varchar(64) NOT NULL,
	`request_id` varchar(64) NOT NULL,
	`model` varchar(128) NOT NULL,
	`input_tokens` int NOT NULL DEFAULT 0,
	`output_tokens` int NOT NULL DEFAULT 0,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `credential_usage_event_id` PRIMARY KEY(`id`),
	CONSTRAINT `credential_usage_event_request_id` UNIQUE(`request_id`)
);
--> statement-breakpoint
CREATE TABLE `session_lease` (
	`id` varchar(64) NOT NULL,
	`owner_user_id` varchar(64) NOT NULL,
	`provider` varchar(64) NOT NULL,
	`session_id` varchar(64) NOT NULL,
	`active_binding_id` varchar(64) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `session_lease_id` PRIMARY KEY(`id`),
	CONSTRAINT `session_lease_session_provider` UNIQUE(`session_id`,`provider`)
);
--> statement-breakpoint
CREATE INDEX `audit_event_entity` ON `audit_event` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_event_actor` ON `audit_event` (`actor_user_id`);--> statement-breakpoint
CREATE INDEX `audit_event_action` ON `audit_event` (`action`);--> statement-breakpoint
CREATE INDEX `user_ai_access_policy_provider` ON `user_ai_access_policy` (`provider`);--> statement-breakpoint
CREATE INDEX `credential_binding_owner_provider` ON `credential_binding` (`owner_user_id`,`provider`);--> statement-breakpoint
CREATE INDEX `credential_binding_credential_record_id` ON `credential_binding` (`credential_record_id`);--> statement-breakpoint
CREATE INDEX `credential_health_event_credential_record_id` ON `credential_health_event` (`credential_record_id`);--> statement-breakpoint
CREATE INDEX `credential_record_owner_provider_state` ON `credential_record` (`owner_user_id`,`provider`,`state`);--> statement-breakpoint
CREATE INDEX `credential_usage_event_owner_provider` ON `credential_usage_event` (`owner_user_id`,`provider`);--> statement-breakpoint
CREATE INDEX `credential_usage_event_binding_id` ON `credential_usage_event` (`credential_binding_id`);--> statement-breakpoint
CREATE INDEX `session_lease_owner_provider` ON `session_lease` (`owner_user_id`,`provider`);--> statement-breakpoint
CREATE INDEX `session_lease_active_binding_id` ON `session_lease` (`active_binding_id`);
