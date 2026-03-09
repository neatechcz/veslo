CREATE TABLE `desktop_auth_handoff` (
	`id` varchar(64) NOT NULL,
	`code` varchar(255) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`org_id` varchar(64) NOT NULL,
	`session_token` varchar(255) NOT NULL,
	`expires_at` timestamp(3) NOT NULL,
	`consumed_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `desktop_auth_handoff_id` PRIMARY KEY(`id`),
	CONSTRAINT `desktop_auth_handoff_code` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE INDEX `desktop_auth_handoff_user_id` ON `desktop_auth_handoff` (`user_id`);
--> statement-breakpoint
CREATE INDEX `desktop_auth_handoff_org_id` ON `desktop_auth_handoff` (`org_id`);
--> statement-breakpoint
CREATE INDEX `desktop_auth_handoff_expires_at` ON `desktop_auth_handoff` (`expires_at`);
