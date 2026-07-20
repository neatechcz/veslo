ALTER TABLE `debug_log_event` ADD `capture_id` varchar(36);
--> statement-breakpoint
CREATE INDEX `debug_log_event_capture_time` ON `debug_log_event` (`capture_id`,`event_timestamp`);
