CREATE TABLE `organization_billing_account` (
  `id` varchar(64) NOT NULL,
  `org_id` varchar(64) NOT NULL,
  `mode` enum('none','managed_ai','local_models','manual_access') NOT NULL DEFAULT 'none',
  `source` enum('stripe_checkout','stripe_subscription','stripe_invoice','stripe_portal','manual_external','manual_trial','manual_local_models'),
  `status` enum('none','active','trialing','past_due','unpaid','canceled','incomplete') NOT NULL DEFAULT 'none',
  `stripe_customer_id` varchar(255),
  `stripe_subscription_id` varchar(255),
  `billing_interval` varchar(32),
  `managed_ai_basic_quantity` int unsigned NOT NULL DEFAULT 0,
  `managed_ai_extended_quantity` int unsigned NOT NULL DEFAULT 0,
  `local_models_quantity` int unsigned NOT NULL DEFAULT 0,
  `manual_access_enabled` boolean NOT NULL DEFAULT false,
  `manual_access_expires_at` timestamp(3),
  `local_models_unit_amount` int unsigned,
  `local_models_currency` varchar(3),
  `payment_problem_code` varchar(255),
  `payment_problem_message` text,
  `grace_until` timestamp(3),
  `cancel_at_period_end` boolean NOT NULL DEFAULT false,
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `organization_billing_account_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_billing_account_org_id` ON `organization_billing_account` (`org_id`);
--> statement-breakpoint
CREATE INDEX `organization_billing_account_stripe_customer_id` ON `organization_billing_account` (`stripe_customer_id`);
--> statement-breakpoint
CREATE INDEX `organization_billing_account_stripe_subscription_id` ON `organization_billing_account` (`stripe_subscription_id`);
--> statement-breakpoint
CREATE INDEX `organization_billing_account_org_status` ON `organization_billing_account` (`org_id`, `status`);
--> statement-breakpoint
CREATE TABLE `organization_billing_tier_allowlist` (
  `id` varchar(64) NOT NULL,
  `org_id` varchar(64) NOT NULL,
  `tier` varchar(64) NOT NULL,
  `enabled` boolean NOT NULL DEFAULT true,
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  `updated_at` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT `organization_billing_tier_allowlist_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_billing_tier_allowlist_org_tier` ON `organization_billing_tier_allowlist` (`org_id`, `tier`);
--> statement-breakpoint
CREATE INDEX `organization_billing_tier_allowlist_org_id` ON `organization_billing_tier_allowlist` (`org_id`);
--> statement-breakpoint
CREATE INDEX `organization_billing_tier_allowlist_enabled` ON `organization_billing_tier_allowlist` (`enabled`);
--> statement-breakpoint
CREATE TABLE `organization_billing_event` (
  `id` varchar(64) NOT NULL,
  `org_id` varchar(64) NOT NULL,
  `stripe_event_id` varchar(255),
  `stripe_event_type` varchar(255),
  `status` enum('applied','ignored','failed') NOT NULL,
  `payload` json NOT NULL,
  `error_message` text,
  `created_at` timestamp(3) NOT NULL DEFAULT (now()),
  `processed_at` timestamp(3),
  CONSTRAINT `organization_billing_event_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_billing_event_stripe_event_id` ON `organization_billing_event` (`stripe_event_id`);
--> statement-breakpoint
CREATE INDEX `organization_billing_event_org_id` ON `organization_billing_event` (`org_id`);
--> statement-breakpoint
CREATE INDEX `organization_billing_event_status` ON `organization_billing_event` (`status`);
--> statement-breakpoint
CREATE INDEX `organization_billing_event_created_at` ON `organization_billing_event` (`created_at`);
