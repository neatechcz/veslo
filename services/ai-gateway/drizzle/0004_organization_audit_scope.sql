CREATE TABLE IF NOT EXISTS `ai_gateway_audit_event` (
  `id` varchar(64) NOT NULL,
  `actor_user_id` varchar(64),
  `entity_type` varchar(64) NOT NULL,
  `entity_id` varchar(64) NOT NULL,
  `action` varchar(64) NOT NULL,
  `result` varchar(32) NOT NULL,
  `summary` text,
  `created_at` timestamp(3) NOT NULL,
  CONSTRAINT `ai_gateway_audit_event_id` PRIMARY KEY (`id`),
  KEY `audit_event_entity` (`entity_type`, `entity_id`),
  KEY `audit_event_actor` (`actor_user_id`),
  KEY `audit_event_action` (`action`)
);
--> statement-breakpoint
SET @backfill_legacy_audit_events_sql = (
  SELECT IF(
    (
      SELECT COUNT(DISTINCT COLUMN_NAME)
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'audit_event'
        AND COLUMN_NAME IN (
          'id',
          'actor_user_id',
          'entity_type',
          'entity_id',
          'action',
          'result',
          'summary',
          'created_at'
        )
    ) = 8,
    'INSERT IGNORE INTO `ai_gateway_audit_event` (`id`, `actor_user_id`, `entity_type`, `entity_id`, `action`, `result`, `summary`, `created_at`) SELECT `id`, `actor_user_id`, `entity_type`, `entity_id`, `action`, `result`, `summary`, `created_at` FROM `audit_event`',
    'SELECT 1'
  )
);
--> statement-breakpoint
PREPARE backfill_legacy_audit_events FROM @backfill_legacy_audit_events_sql;
--> statement-breakpoint
EXECUTE backfill_legacy_audit_events;
--> statement-breakpoint
DEALLOCATE PREPARE backfill_legacy_audit_events;
--> statement-breakpoint
SET @add_audit_organization_column_sql = (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ai_gateway_audit_event'
        AND COLUMN_NAME = 'organization_id'
    ),
    'SELECT 1',
    'ALTER TABLE `ai_gateway_audit_event` ADD COLUMN `organization_id` varchar(64) NULL'
  )
);
--> statement-breakpoint
PREPARE add_audit_organization_column FROM @add_audit_organization_column_sql;
--> statement-breakpoint
EXECUTE add_audit_organization_column;
--> statement-breakpoint
DEALLOCATE PREPARE add_audit_organization_column;
--> statement-breakpoint
SET @create_audit_organization_index_sql = (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ai_gateway_audit_event'
        AND INDEX_NAME = 'audit_event_organization_created'
    ),
    'SELECT 1',
    'CREATE INDEX `audit_event_organization_created` ON `ai_gateway_audit_event` (`organization_id`, `created_at`)'
  )
);
--> statement-breakpoint
PREPARE create_audit_organization_index FROM @create_audit_organization_index_sql;
--> statement-breakpoint
EXECUTE create_audit_organization_index;
--> statement-breakpoint
DEALLOCATE PREPARE create_audit_organization_index;
