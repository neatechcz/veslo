CREATE TABLE `desktop_auth_transaction` (
	`id` varchar(64) NOT NULL,
	`transaction_id` varchar(64) NOT NULL,
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
	`authorization_code_hash` varchar(128),
	`manual_code_hash` varchar(128),
	`code_issued_at` timestamp(3),
	`exchanged_at` timestamp(3),
	`expires_at` timestamp(3) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `desktop_auth_transaction_id` PRIMARY KEY(`id`),
	CONSTRAINT `desktop_auth_transaction_transaction_id` UNIQUE(`transaction_id`)
);

CREATE INDEX `desktop_auth_transaction_status_expires` ON `desktop_auth_transaction` (`status`,`expires_at`);
CREATE INDEX `desktop_auth_transaction_authorization_code_hash` ON `desktop_auth_transaction` (`authorization_code_hash`);
CREATE INDEX `desktop_auth_transaction_manual_code_hash` ON `desktop_auth_transaction` (`manual_code_hash`);
