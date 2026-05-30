CREATE TABLE `skill_rollout_policies` (
  `id` varchar(64) NOT NULL,
  `org_id` varchar(64),
  `skill_id` varchar(64) NOT NULL,
  `desired_version_id` varchar(64),
  `release_channel` varchar(128),
  `update_policy` enum('pinned','latest_user','latest_approved','release_channel') NOT NULL DEFAULT 'pinned',
  `catalog_scope` enum('organization','platform') NOT NULL,
  `owner_org_id` varchar(64),
  `target` enum('user-global','workspace') NOT NULL,
  `audience` enum('user','selected-workspaces','all-org-users','all-platform-users') NOT NULL,
  `user_id` varchar(64),
  `workspace_id` varchar(64),
  `enabled` boolean NOT NULL DEFAULT true,
  `removal_policy` enum('user_removable','admin_removable','locked') NOT NULL DEFAULT 'user_removable',
  `created_by_user_id` varchar(64) NOT NULL,
  `deleted_at` timestamp(3),
  `deleted_by_user_id` varchar(64),
  `purge_after` timestamp(3),
  `restored_at` timestamp(3),
  `restored_by_user_id` varchar(64),
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `skill_rollout_user_target_shape` CHECK (`target` <> 'user-global' OR `workspace_id` IS NULL),
  CONSTRAINT `skill_rollout_workspace_target_shape` CHECK (`target` <> 'workspace' OR `audience` = 'selected-workspaces'),
  CONSTRAINT `skill_rollout_policies_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `skill_rollout_org_audience` ON `skill_rollout_policies` (`org_id`, `audience`, `enabled`);
--> statement-breakpoint
CREATE INDEX `skill_rollout_workspace_lookup` ON `skill_rollout_policies` (`org_id`, `workspace_id`, `enabled`);
--> statement-breakpoint
CREATE INDEX `skill_rollout_user_lookup` ON `skill_rollout_policies` (`user_id`, `enabled`);
--> statement-breakpoint
CREATE INDEX `skill_rollout_skill` ON `skill_rollout_policies` (`skill_id`, `enabled`);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_rollout_active_target_guard` ON `skill_rollout_policies` (`skill_id`, `catalog_scope`, `owner_org_id`, `target`, `audience`, `user_id`, `workspace_id`);
