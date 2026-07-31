ALTER TABLE `feedback_report` ADD `diagnostic_capture_id` varchar(36);
--> statement-breakpoint
CREATE INDEX `feedback_report_diagnostic_capture_id` ON `feedback_report` (`diagnostic_capture_id`);
