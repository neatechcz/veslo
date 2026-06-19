CREATE TABLE `google_workspace_connection` (
  `id` varchar(64) NOT NULL,
  `org_id` varchar(64) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `connector_id` enum('google-gmail','google-calendar','google-drive') NOT NULL,
  `state` enum('connected','revoked','error') NOT NULL,
  `scopes` text NOT NULL,
  `access_token_expires_at` timestamp(3),
  `grant_iv` text NOT NULL,
  `grant_auth_tag` text NOT NULL,
  `grant_ciphertext` longtext NOT NULL,
  `connected_at` timestamp(3) NOT NULL DEFAULT (now()),
  `revoked_at` timestamp(3),
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `google_workspace_connection_id` PRIMARY KEY(`id`),
  CONSTRAINT `google_workspace_connection_scope` UNIQUE(`org_id`,`user_id`,`connector_id`)
);
--> statement-breakpoint
CREATE INDEX `google_workspace_connection_org_user` ON `google_workspace_connection` (`org_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX `google_workspace_connection_state` ON `google_workspace_connection` (`state`);
