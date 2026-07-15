SET @add_assignment_origin_sql = (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'user_ai_access_policy'
        AND COLUMN_NAME = 'assignment_origin'
    ),
    'SELECT 1',
    'ALTER TABLE `user_ai_access_policy` ADD COLUMN `assignment_origin` varchar(32) NOT NULL DEFAULT ''admin_assigned'''
  )
);
--> statement-breakpoint
PREPARE add_assignment_origin FROM @add_assignment_origin_sql;
--> statement-breakpoint
EXECUTE add_assignment_origin;
--> statement-breakpoint
DEALLOCATE PREPARE add_assignment_origin;
