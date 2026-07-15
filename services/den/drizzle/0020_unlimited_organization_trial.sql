ALTER TABLE `organization_billing_account`
  ADD `manual_access_unlimited` boolean NOT NULL DEFAULT false AFTER `manual_access_enabled`;
--> statement-breakpoint
INSERT INTO `organization_billing_account` (
  `id`,
  `org_id`,
  `mode`,
  `source`,
  `status`,
  `managed_ai_basic_quantity`,
  `managed_ai_extended_quantity`,
  `local_models_quantity`,
  `manual_access_enabled`,
  `manual_access_unlimited`,
  `manual_access_expires_at`,
  `cancel_at_period_end`,
  `created_at`,
  `updated_at`
)
SELECT
  CONCAT('billing_', REPLACE(UUID(), '-', '')),
  `org`.`id`,
  'manual_access',
  'manual_trial',
  'trialing',
  0,
  0,
  0,
  true,
  true,
  NULL,
  false,
  CURRENT_TIMESTAMP(3),
  CURRENT_TIMESTAMP(3)
FROM `org`
LEFT JOIN `organization_billing_account`
  ON `organization_billing_account`.`org_id` = `org`.`id`
WHERE `organization_billing_account`.`id` IS NULL;
--> statement-breakpoint
UPDATE `organization_billing_account`
SET
  `mode` = 'manual_access',
  `source` = 'manual_trial',
  `status` = 'trialing',
  `managed_ai_basic_quantity` = 0,
  `managed_ai_extended_quantity` = 0,
  `local_models_quantity` = 0,
  `manual_access_enabled` = true,
  `manual_access_unlimited` = true,
  `manual_access_expires_at` = NULL,
  `payment_problem_code` = NULL,
  `payment_problem_message` = NULL,
  `grace_until` = NULL,
  `cancel_at_period_end` = false,
  `updated_at` = CURRENT_TIMESTAMP(3)
WHERE `stripe_subscription_id` IS NULL;
