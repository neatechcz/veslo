ALTER TABLE `organization_billing_account`
  ADD COLUMN IF NOT EXISTS `manual_access_unlimited` boolean NOT NULL DEFAULT false;
