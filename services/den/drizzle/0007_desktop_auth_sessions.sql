CREATE TABLE `desktop_auth_session` (
	`id` varchar(64) NOT NULL,
	`intent` enum('signin','signup') NOT NULL,
	`state_hash` varchar(128) NOT NULL,
	`code_challenge` varchar(255) NOT NULL,
	`code_challenge_method` varchar(16) NOT NULL,
	`redirect_uri` varchar(512) NOT NULL,
	`status` enum('started','browser_authed','exchanged','expired','cancelled') NOT NULL,
	`user_id` varchar(64),
	`org_id` varchar(64),
	`browser_ip` text,
	`browser_user_agent` text,
	`expires_at` timestamp(3) NOT NULL,
	`exchanged_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `desktop_auth_session_id` PRIMARY KEY(`id`)
);

CREATE INDEX `desktop_auth_session_status_expires` ON `desktop_auth_session` (`status`,`expires_at`);
CREATE INDEX `desktop_auth_session_user_id` ON `desktop_auth_session` (`user_id`);

ALTER TABLE `desktop_auth_handoff`
	ADD COLUMN `session_id` varchar(64) NULL;

CREATE INDEX `desktop_auth_handoff_session_id` ON `desktop_auth_handoff` (`session_id`);
