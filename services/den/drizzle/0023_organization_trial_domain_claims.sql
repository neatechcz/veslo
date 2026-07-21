CREATE TABLE `organization_trial_domain_claim` (
  `id` varchar(64) NOT NULL,
  `domain` varchar(255) NOT NULL,
  `org_id` varchar(64) NOT NULL,
  `claimed_at` timestamp(3) NOT NULL DEFAULT (now()),
  CONSTRAINT `organization_trial_domain_claim_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_trial_domain_claim_domain` ON `organization_trial_domain_claim` (`domain`);
--> statement-breakpoint
CREATE INDEX `organization_trial_domain_claim_org_id` ON `organization_trial_domain_claim` (`org_id`);
