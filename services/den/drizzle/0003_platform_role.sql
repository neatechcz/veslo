CREATE TABLE `platform_role` (
	`id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`role` enum('platform_admin') NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `platform_role_id` PRIMARY KEY(`id`),
	CONSTRAINT `platform_role_user_id` UNIQUE(`user_id`)
);
