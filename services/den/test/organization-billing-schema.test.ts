import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

const migrationUrl = new URL("../drizzle/0018_organization_stripe_billing.sql", import.meta.url)
const journalUrl = new URL("../drizzle/meta/_journal.json", import.meta.url)

function readMigration() {
  assert.equal(existsSync(migrationUrl), true, "missing organization billing migration")
  return readFileSync(migrationUrl, "utf8")
}

function tableBlock(migration: string, tableName: string) {
  const match = migration.match(new RegExp(`CREATE TABLE \`${tableName}\` \\([\\s\\S]*?\\n\\);`))
  assert.ok(match, `missing CREATE TABLE for ${tableName}`)
  return match[0]
}

test("organization billing schema exports core tables and enums", async () => {
  const schema = (await import("../src/db/schema.js")) as Record<string, unknown>

  assert.ok(schema.OrganizationBillingAccountTable)
  assert.ok(schema.OrganizationBillingTierAllowlistTable)
  assert.ok(schema.OrganizationBillingEventTable)
  assert.deepEqual(schema.OrganizationBillingMode, ["none", "managed_ai", "local_models", "manual_access"])
  assert.deepEqual(schema.OrganizationBillingStatus, [
    "none",
    "active",
    "trialing",
    "past_due",
    "unpaid",
    "canceled",
    "incomplete",
  ])
  assert.deepEqual(schema.OrganizationBillingEventStatus, ["applied", "ignored", "failed"])

  const source = schema.OrganizationBillingSource
  assert.ok(Array.isArray(source), "OrganizationBillingSource must be exported as an enum value array")
  assert.ok(source.includes("stripe_checkout"))
  assert.ok(source.includes("stripe_invoice"))
  assert.ok(source.includes("manual_external"))
})

test("organization billing migration creates account, tier allowlist, and event tables", () => {
  const migration = readMigration()

  const accountBlock = tableBlock(migration, "organization_billing_account")
  assert.match(accountBlock, /`org_id` varchar\(64\) NOT NULL/)
  assert.match(accountBlock, /`mode` enum\('none','managed_ai','local_models','manual_access'\) NOT NULL DEFAULT 'none'/)
  assert.match(accountBlock, /`source` enum\('stripe_checkout','stripe_subscription','stripe_invoice','stripe_portal','manual_external','manual_trial','manual_local_models'\)/)
  assert.match(accountBlock, /`status` enum\('none','active','trialing','past_due','unpaid','canceled','incomplete'\) NOT NULL DEFAULT 'none'/)
  assert.match(accountBlock, /`managed_ai_basic_quantity` int unsigned NOT NULL DEFAULT 0/)
  assert.match(accountBlock, /`managed_ai_extended_quantity` int unsigned NOT NULL DEFAULT 0/)
  assert.match(accountBlock, /`local_models_quantity` int unsigned NOT NULL DEFAULT 0/)
  assert.match(accountBlock, /`manual_access_enabled` boolean NOT NULL DEFAULT false/)
  assert.match(accountBlock, /`manual_access_expires_at` timestamp\(3\)/)
  assert.match(accountBlock, /`local_models_unit_amount` int unsigned/)
  assert.match(accountBlock, /`local_models_currency` varchar\(3\)/)
  assert.match(accountBlock, /`payment_problem_code` varchar\(255\)/)
  assert.match(accountBlock, /`payment_problem_message` text/)
  assert.match(accountBlock, /`grace_until` timestamp\(3\)/)
  assert.match(accountBlock, /`cancel_at_period_end` boolean NOT NULL DEFAULT false/)
  assert.match(accountBlock, /`created_at` timestamp\(3\) NOT NULL DEFAULT \(now\(\)\)/)
  assert.match(accountBlock, /`updated_at` timestamp\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP\(3\) ON UPDATE CURRENT_TIMESTAMP\(3\)/)

  const allowlistBlock = tableBlock(migration, "organization_billing_tier_allowlist")
  assert.match(allowlistBlock, /`org_id` varchar\(64\) NOT NULL/)
  assert.match(allowlistBlock, /`tier` varchar\(64\) NOT NULL/)
  assert.match(allowlistBlock, /`enabled` boolean NOT NULL DEFAULT true/)

  const eventBlock = tableBlock(migration, "organization_billing_event")
  assert.match(eventBlock, /`org_id` varchar\(64\) NOT NULL/)
  assert.match(eventBlock, /`stripe_event_id` varchar\(255\)/)
  assert.match(eventBlock, /`stripe_event_type` varchar\(255\)/)
  assert.match(eventBlock, /`status` enum\('applied','ignored','failed'\) NOT NULL/)
  assert.match(eventBlock, /`payload` json NOT NULL/)
  assert.match(eventBlock, /`error_message` text/)
  assert.match(eventBlock, /`created_at` timestamp\(3\) NOT NULL DEFAULT \(now\(\)\)/)
  assert.match(eventBlock, /`processed_at` timestamp\(3\)/)
})

test("organization billing migration has idempotency and allowlist uniqueness indexes", () => {
  const migration = readMigration()

  assert.match(
    migration,
    /CREATE UNIQUE INDEX `organization_billing_event_stripe_event_id` ON `organization_billing_event` \(`stripe_event_id`\)/,
  )
  assert.match(
    migration,
    /CREATE UNIQUE INDEX `organization_billing_tier_allowlist_org_tier` ON `organization_billing_tier_allowlist` \(`org_id`, `tier`\)/,
  )
})

test("organization billing migration is listed in the Drizzle journal", () => {
  const journal = JSON.parse(readFileSync(journalUrl, "utf8")) as {
    entries?: Array<{ idx?: unknown; tag?: unknown; breakpoints?: unknown }>
  }
  const entry = journal.entries?.find((candidate) => candidate.tag === "0018_organization_stripe_billing")

  assert.deepEqual(
    {
      idx: entry?.idx,
      tag: entry?.tag,
      breakpoints: entry?.breakpoints,
    },
    {
      idx: 19,
      tag: "0018_organization_stripe_billing",
      breakpoints: true,
    },
  )
})
