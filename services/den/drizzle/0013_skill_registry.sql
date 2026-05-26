CREATE TABLE `skills` (
  `id` varchar(64) NOT NULL,
  `scope` enum('user','org','workspace','system') NOT NULL,
  `org_id` varchar(64),
  `owner_user_id` varchar(64),
  `workspace_id` varchar(64),
  `name` varchar(255) NOT NULL,
  `display_name` varchar(255),
  `description` text,
  `latest_version_id` varchar(64),
  `created_by_user_id` varchar(64) NOT NULL,
  `deleted_at` timestamp(3),
  `deleted_by_user_id` varchar(64),
  `purge_after` timestamp(3),
  `restored_at` timestamp(3),
  `restored_by_user_id` varchar(64),
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `skills_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_scope_owner_name` ON `skills` (`scope`, `org_id`, `workspace_id`, `owner_user_id`, `name`);
--> statement-breakpoint
CREATE INDEX `skills_org_skill` ON `skills` (`org_id`, `id`);
--> statement-breakpoint
CREATE INDEX `skills_org_workspace` ON `skills` (`org_id`, `workspace_id`, `name`);
--> statement-breakpoint
CREATE INDEX `skills_org_deleted` ON `skills` (`org_id`, `deleted_at`);
--> statement-breakpoint
CREATE INDEX `skills_owner_user` ON `skills` (`owner_user_id`, `name`);
--> statement-breakpoint
CREATE TABLE `skill_versions` (
  `id` varchar(64) NOT NULL,
  `org_id` varchar(64),
  `skill_id` varchar(64) NOT NULL,
  `version_number` int unsigned NOT NULL,
  `status` enum('draft','pending_review','approved','rejected','archived') NOT NULL,
  `manifest_sha256` varchar(64) NOT NULL,
  `package_sha256` varchar(64) NOT NULL,
  `package_size_bytes` int unsigned NOT NULL,
  `file_count` int unsigned NOT NULL,
  `created_by_user_id` varchar(64) NOT NULL,
  `submitted_for_review_at` timestamp(3),
  `approved_at` timestamp(3),
  `rejected_at` timestamp(3),
  `archived_at` timestamp(3),
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  CONSTRAINT `skill_versions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_version_skill_number` ON `skill_versions` (`skill_id`, `version_number`);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_version_manifest_sha256` ON `skill_versions` (`manifest_sha256`);
--> statement-breakpoint
CREATE INDEX `skill_versions_org_skill` ON `skill_versions` (`org_id`, `skill_id`);
--> statement-breakpoint
CREATE INDEX `skill_versions_org_status` ON `skill_versions` (`org_id`, `status`);
--> statement-breakpoint
CREATE INDEX `skill_versions_status` ON `skill_versions` (`status`);
--> statement-breakpoint
CREATE TABLE `skill_version_files` (
  `id` varchar(64) NOT NULL,
  `org_id` varchar(64),
  `version_id` varchar(64) NOT NULL,
  `blob_id` varchar(64) NOT NULL,
  `path` varchar(1024) NOT NULL,
  `sha256` varchar(64) NOT NULL,
  `size_bytes` int unsigned NOT NULL,
  `media_type` varchar(255) NOT NULL,
  `executable` boolean NOT NULL DEFAULT false,
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  CONSTRAINT `skill_version_files_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_version_file_version_path` ON `skill_version_files` (`version_id`, `path`);
--> statement-breakpoint
CREATE INDEX `skill_version_files_org_version` ON `skill_version_files` (`org_id`, `version_id`);
--> statement-breakpoint
CREATE INDEX `skill_version_files_blob` ON `skill_version_files` (`blob_id`);
--> statement-breakpoint
CREATE TABLE `skill_blobs` (
  `id` varchar(64) NOT NULL,
  `sha256` varchar(64) NOT NULL,
  `size_bytes` int unsigned NOT NULL,
  `media_type` varchar(255) NOT NULL,
  `storage_key` varchar(1024) NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  CONSTRAINT `skill_blobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_blob_sha256` ON `skill_blobs` (`sha256`);
--> statement-breakpoint
CREATE TABLE `skill_installations` (
  `id` varchar(64) NOT NULL,
  `scope` enum('user','org','workspace','system') NOT NULL,
  `org_id` varchar(64),
  `owner_user_id` varchar(64),
  `workspace_id` varchar(64),
  `skill_id` varchar(64) NOT NULL,
  `desired_version_id` varchar(64),
  `approved_version_id` varchar(64),
  `approval_id` varchar(64),
  `update_policy` enum('pinned','latest_user','latest_approved','release_channel') NOT NULL,
  `release_channel` varchar(128),
  `status` enum('active','deleted','disabled') NOT NULL DEFAULT 'active',
  `installed_by_user_id` varchar(64) NOT NULL,
  `deleted_at` timestamp(3),
  `deleted_by_user_id` varchar(64),
  `purge_after` timestamp(3),
  `restored_at` timestamp(3),
  `restored_by_user_id` varchar(64),
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `skill_installation_active_managed_approval` CHECK (`status` <> 'active' OR `scope` NOT IN ('org','system') OR (`approval_id` IS NOT NULL AND `approved_version_id` IS NOT NULL)),
  CONSTRAINT `skill_installations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `skill_installations_org_scope` ON `skill_installations` (`org_id`, `scope`, `skill_id`);
--> statement-breakpoint
CREATE INDEX `skill_installations_org_workspace` ON `skill_installations` (`org_id`, `workspace_id`, `skill_id`);
--> statement-breakpoint
CREATE INDEX `skill_installations_org_user` ON `skill_installations` (`org_id`, `owner_user_id`, `skill_id`);
--> statement-breakpoint
CREATE INDEX `skill_installation_scope_approval` ON `skill_installations` (`scope`, `approval_id`, `approved_version_id`);
--> statement-breakpoint
CREATE INDEX `skill_installations_skill` ON `skill_installations` (`skill_id`);
--> statement-breakpoint
CREATE TABLE `workspace_skill_sets` (
  `id` varchar(64) NOT NULL,
  `org_id` varchar(64) NOT NULL,
  `workspace_id` varchar(64) NOT NULL,
  `name` varchar(255) NOT NULL,
  `revision` int unsigned NOT NULL DEFAULT 1,
  `release_channel` varchar(128),
  `created_by_user_id` varchar(64) NOT NULL,
  `deleted_at` timestamp(3),
  `deleted_by_user_id` varchar(64),
  `purge_after` timestamp(3),
  `restored_at` timestamp(3),
  `restored_by_user_id` varchar(64),
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `workspace_skill_sets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_skill_set_workspace_revision` ON `workspace_skill_sets` (`org_id`, `workspace_id`, `revision`);
--> statement-breakpoint
CREATE INDEX `workspace_skill_sets_org_workspace` ON `workspace_skill_sets` (`org_id`, `workspace_id`);
--> statement-breakpoint
CREATE INDEX `workspace_skill_sets_org_release` ON `workspace_skill_sets` (`org_id`, `release_channel`);
--> statement-breakpoint
CREATE TABLE `workspace_skill_set_entries` (
  `id` varchar(64) NOT NULL,
  `org_id` varchar(64) NOT NULL,
  `skill_set_id` varchar(64) NOT NULL,
  `installation_id` varchar(64) NOT NULL,
  `skill_id` varchar(64) NOT NULL,
  `desired_version_id` varchar(64),
  `release_channel` varchar(128),
  `position` int unsigned NOT NULL DEFAULT 0,
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  CONSTRAINT `workspace_skill_set_entries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_skill_set_entry_installation` ON `workspace_skill_set_entries` (`skill_set_id`, `installation_id`);
--> statement-breakpoint
CREATE INDEX `workspace_skill_set_entries_org_set` ON `workspace_skill_set_entries` (`org_id`, `skill_set_id`);
--> statement-breakpoint
CREATE INDEX `workspace_skill_set_entries_org_skill` ON `workspace_skill_set_entries` (`org_id`, `skill_id`);
--> statement-breakpoint
CREATE TABLE `skill_materializations` (
  `id` varchar(64) NOT NULL,
  `org_id` varchar(64),
  `workspace_id` varchar(64),
  `owner_user_id` varchar(64),
  `skill_set_id` varchar(64),
  `installation_id` varchar(64) NOT NULL,
  `skill_id` varchar(64) NOT NULL,
  `desired_version_id` varchar(64),
  `actual_version_id` varchar(64),
  `target_scope` enum('user','org','workspace','system') NOT NULL,
  `target_path` varchar(2048) NOT NULL,
  `status` enum('pending','materialized','failed','stale') NOT NULL,
  `package_sha256` varchar(64),
  `last_error` text,
  `materialized_at` timestamp(3),
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `skill_materializations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `skill_materializations_org_workspace` ON `skill_materializations` (`org_id`, `workspace_id`, `status`);
--> statement-breakpoint
CREATE INDEX `skill_materializations_org_skill` ON `skill_materializations` (`org_id`, `skill_id`);
--> statement-breakpoint
CREATE INDEX `skill_materializations_installation` ON `skill_materializations` (`installation_id`);
--> statement-breakpoint
CREATE INDEX `skill_materializations_desired_version` ON `skill_materializations` (`desired_version_id`);
--> statement-breakpoint
CREATE INDEX `skill_materializations_actual_version` ON `skill_materializations` (`actual_version_id`);
--> statement-breakpoint
CREATE TABLE `skill_review_requests` (
  `id` varchar(64) NOT NULL,
  `org_id` varchar(64),
  `scope` enum('org','system') NOT NULL,
  `skill_id` varchar(64) NOT NULL,
  `version_id` varchar(64) NOT NULL,
  `status` enum('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  `requested_by_user_id` varchar(64) NOT NULL,
  `reason` text,
  `reviewer_note` text,
  `resolved_by_user_id` varchar(64),
  `resolved_at` timestamp(3),
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `skill_review_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `skill_review_requests_org_status` ON `skill_review_requests` (`org_id`, `status`);
--> statement-breakpoint
CREATE INDEX `skill_review_requests_org_version` ON `skill_review_requests` (`org_id`, `version_id`);
--> statement-breakpoint
CREATE INDEX `skill_review_requests_version_status` ON `skill_review_requests` (`version_id`, `status`);
--> statement-breakpoint
CREATE TABLE `skill_approvals` (
  `id` varchar(64) NOT NULL,
  `org_id` varchar(64),
  `scope` enum('org','system') NOT NULL,
  `skill_id` varchar(64) NOT NULL,
  `version_id` varchar(64) NOT NULL,
  `review_request_id` varchar(64),
  `release_channel` varchar(128),
  `approved_by_user_id` varchar(64) NOT NULL,
  `approved_at` timestamp(3) NOT NULL DEFAULT (now()),
  `revoked_by_user_id` varchar(64),
  `revoked_at` timestamp(3),
  CONSTRAINT `skill_approvals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_approval_scope_version` ON `skill_approvals` (`scope`, `org_id`, `version_id`, `release_channel`);
--> statement-breakpoint
CREATE INDEX `skill_approvals_org_version` ON `skill_approvals` (`org_id`, `version_id`);
--> statement-breakpoint
CREATE INDEX `skill_approvals_org_skill` ON `skill_approvals` (`org_id`, `skill_id`);
--> statement-breakpoint
CREATE INDEX `skill_approvals_review_request` ON `skill_approvals` (`review_request_id`);
--> statement-breakpoint
CREATE TABLE `skill_share_links` (
  `id` varchar(64) NOT NULL,
  `org_id` varchar(64),
  `skill_id` varchar(64) NOT NULL,
  `version_id` varchar(64),
  `audience` enum('private','org','public') NOT NULL,
  `token_hash` varchar(128) NOT NULL,
  `created_by_user_id` varchar(64) NOT NULL,
  `expires_at` timestamp(3),
  `revoked_at` timestamp(3),
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  CONSTRAINT `skill_share_links_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_share_link_token_hash` ON `skill_share_links` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `skill_share_links_org_skill` ON `skill_share_links` (`org_id`, `skill_id`);
--> statement-breakpoint
CREATE INDEX `skill_share_links_org_audience` ON `skill_share_links` (`org_id`, `audience`);
--> statement-breakpoint
CREATE TABLE `skill_search_documents` (
  `id` varchar(64) NOT NULL,
  `org_id` varchar(64),
  `skill_id` varchar(64) NOT NULL,
  `version_id` varchar(64) NOT NULL,
  `source_language` varchar(16) NOT NULL DEFAULT 'en',
  `locale` varchar(16) NOT NULL,
  `title` varchar(512) NOT NULL,
  `body` longtext NOT NULL,
  `translated_title` varchar(512),
  `translated_body` longtext,
  `search_text` longtext NOT NULL,
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `skill_search_documents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_search_document_version_locale` ON `skill_search_documents` (`version_id`, `locale`);
--> statement-breakpoint
CREATE INDEX `skill_search_documents_org_locale` ON `skill_search_documents` (`org_id`, `locale`);
--> statement-breakpoint
CREATE INDEX `skill_search_documents_org_skill` ON `skill_search_documents` (`org_id`, `skill_id`);
--> statement-breakpoint
CREATE TABLE `skill_audit_events` (
  `id` varchar(64) NOT NULL,
  `org_id` varchar(64),
  `skill_id` varchar(64),
  `version_id` varchar(64),
  `installation_id` varchar(64),
  `workspace_id` varchar(64),
  `actor_user_id` varchar(64) NOT NULL,
  `action` varchar(128) NOT NULL,
  `payload` json,
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  CONSTRAINT `skill_audit_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `skill_audit_events_org_time` ON `skill_audit_events` (`org_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `skill_audit_events_org_skill` ON `skill_audit_events` (`org_id`, `skill_id`);
--> statement-breakpoint
CREATE INDEX `skill_audit_events_actor_time` ON `skill_audit_events` (`actor_user_id`, `created_at`);
--> statement-breakpoint
CREATE TRIGGER `skill_versions_prevent_update` BEFORE UPDATE ON `skill_versions` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'skill_versions are immutable';
--> statement-breakpoint
CREATE TRIGGER `skill_version_files_prevent_update` BEFORE UPDATE ON `skill_version_files` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'skill_version_files are immutable';
--> statement-breakpoint
CREATE TRIGGER `skill_blobs_prevent_update` BEFORE UPDATE ON `skill_blobs` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'skill_blobs are immutable';
