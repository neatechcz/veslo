ALTER TABLE `worker` ADD `created_by_user_id` varchar(64);
--> statement-breakpoint
CREATE INDEX `worker_created_by_user_id` ON `worker` (`created_by_user_id`);
