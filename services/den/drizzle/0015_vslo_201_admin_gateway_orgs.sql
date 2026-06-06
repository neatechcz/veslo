ALTER TABLE `org` ADD `seat_limit` int unsigned;
--> statement-breakpoint
ALTER TABLE `org_membership` ADD `status` enum('active','disabled','removed') NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE `org_membership` MODIFY COLUMN `role` enum('owner','member','organization_admin') NOT NULL;
--> statement-breakpoint
UPDATE `org_membership` SET `role` = 'organization_admin' WHERE `role` = 'owner';
--> statement-breakpoint
ALTER TABLE `org_membership` MODIFY COLUMN `role` enum('member','organization_admin') NOT NULL;
--> statement-breakpoint
CREATE INDEX `org_membership_org_status` ON `org_membership` (`org_id`, `status`);
--> statement-breakpoint
CREATE INDEX `org_membership_user_status` ON `org_membership` (`user_id`, `status`);
--> statement-breakpoint
CREATE TABLE `organization_domain` (
  `id` varchar(64) NOT NULL,
  `org_id` varchar(64) NOT NULL,
  `domain` varchar(255) NOT NULL,
  `enabled` boolean NOT NULL DEFAULT true,
  `self_signup_enabled` boolean NOT NULL DEFAULT false,
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `organization_domain_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_domain_domain` ON `organization_domain` (`domain`);
--> statement-breakpoint
CREATE INDEX `organization_domain_org_id` ON `organization_domain` (`org_id`);
--> statement-breakpoint
CREATE INDEX `organization_domain_org_enabled` ON `organization_domain` (`org_id`, `enabled`);
--> statement-breakpoint
CREATE INDEX `organization_domain_self_signup` ON `organization_domain` (`self_signup_enabled`);
--> statement-breakpoint
CREATE TABLE `organization_invite` (
  `id` varchar(64) NOT NULL,
  `org_id` varchar(64) NOT NULL,
  `email` varchar(255) NOT NULL,
  `role` enum('member','organization_admin') NOT NULL DEFAULT 'member',
  `status` enum('pending','accepted','expired','revoked') NOT NULL DEFAULT 'pending',
  `token_hash` varchar(255) NOT NULL,
  `invited_by_user_id` varchar(64) NOT NULL,
  `accepted_by_user_id` varchar(64),
  `expires_at` timestamp(3),
  `accepted_at` timestamp(3),
  `revoked_at` timestamp(3),
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `organization_invite_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_invite_token_hash` ON `organization_invite` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `organization_invite_org_id` ON `organization_invite` (`org_id`);
--> statement-breakpoint
CREATE INDEX `organization_invite_org_status` ON `organization_invite` (`org_id`, `status`);
--> statement-breakpoint
CREATE INDEX `organization_invite_email` ON `organization_invite` (`email`);
--> statement-breakpoint
CREATE INDEX `organization_invite_email_status` ON `organization_invite` (`email`, `status`);
--> statement-breakpoint
CREATE INDEX `organization_invite_invited_by` ON `organization_invite` (`invited_by_user_id`);
--> statement-breakpoint
CREATE INDEX `organization_invite_accepted_by` ON `organization_invite` (`accepted_by_user_id`);
