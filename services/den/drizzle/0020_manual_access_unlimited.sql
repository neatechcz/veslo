SET @add_manual_access_unlimited_sql = (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'organization_billing_account'
        AND COLUMN_NAME = 'manual_access_unlimited'
    ),
    'SELECT 1',
    'ALTER TABLE `organization_billing_account` ADD COLUMN `manual_access_unlimited` boolean NOT NULL DEFAULT false'
  )
);
--> statement-breakpoint
PREPARE add_manual_access_unlimited FROM @add_manual_access_unlimited_sql;
--> statement-breakpoint
EXECUTE add_manual_access_unlimited;
--> statement-breakpoint
DEALLOCATE PREPARE add_manual_access_unlimited;
