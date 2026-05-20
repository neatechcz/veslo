CREATE TABLE `feedback_report` (
	`id` varchar(64) NOT NULL,
	`type` enum('bug') NOT NULL DEFAULT 'bug',
	`status` enum('pending','projected','failed') NOT NULL DEFAULT 'pending',
	`title` varchar(255) NOT NULL,
	`description` text NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`user_email` varchar(255),
	`org_id` varchar(64) NOT NULL,
	`context` json,
	`view` varchar(64) NOT NULL,
	`pathname` varchar(1024),
	`dashboard_tab` varchar(64),
	`settings_tab` varchar(64),
	`session_id` varchar(64),
	`workspace_id` varchar(64),
	`veslo_server_workspace_id` varchar(64),
	`workspace_type` varchar(64),
	`workspace_path` varchar(1024),
	`worker_id` varchar(64),
	`run_id` varchar(64),
	`app_version` varchar(64),
	`locale` varchar(64),
	`platform` varchar(64),
	`os_family` varchar(64),
	`submitted_at` timestamp(3) NOT NULL DEFAULT (now()),
	`screenshot_status` enum('captured','failed') NOT NULL,
	`screenshot_mime_type` varchar(255),
	`screenshot_bytes` int unsigned,
	`screenshot_data` longtext,
	`youtrack_issue_id` varchar(255),
	`youtrack_issue_url` varchar(2048),
	`last_projector_error` text,
	`next_projector_attempt_at` timestamp(3),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `feedback_report_id` PRIMARY KEY(`id`)
);

--> statement-breakpoint
CREATE INDEX `feedback_report_org_id` ON `feedback_report` (`org_id`);
--> statement-breakpoint
CREATE INDEX `feedback_report_user_id` ON `feedback_report` (`user_id`);
--> statement-breakpoint
CREATE INDEX `feedback_report_status` ON `feedback_report` (`status`);
--> statement-breakpoint
CREATE INDEX `feedback_report_next_projector_attempt_at` ON `feedback_report` (`next_projector_attempt_at`);

--> statement-breakpoint
CREATE TABLE `feedback_projector_attempt` (
	`id` varchar(64) NOT NULL,
	`feedback_id` varchar(64) NOT NULL,
	`attempt_no` int unsigned NOT NULL,
	`status` enum('pending','succeeded','failed') NOT NULL,
	`error_message` text,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `feedback_projector_attempt_id` PRIMARY KEY(`id`)
);

--> statement-breakpoint
CREATE INDEX `feedback_projector_attempt_feedback_id` ON `feedback_projector_attempt` (`feedback_id`);
