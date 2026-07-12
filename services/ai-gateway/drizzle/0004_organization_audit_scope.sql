ALTER TABLE `ai_gateway_audit_event`
  ADD COLUMN `organization_id` varchar(64) NULL;

CREATE INDEX `audit_event_organization_created`
  ON `ai_gateway_audit_event` (`organization_id`, `created_at`);
