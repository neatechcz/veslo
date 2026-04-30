import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("managed ai usage accounting migration adds columns, indexes, and backfill", () => {
  const migration = readFileSync(new URL("../drizzle/0010_managed_ai_usage_accounting.sql", import.meta.url), "utf8")

  assert.match(migration, /ALTER TABLE `credential_usage_event`/)
  assert.match(migration, /ADD COLUMN `org_id` varchar\(64\)/)
  assert.match(migration, /ADD COLUMN `cached_tokens` int NOT NULL DEFAULT 0/)
  assert.match(migration, /ADD COLUMN `total_tokens` int NOT NULL DEFAULT 0/)
  assert.match(
    migration,
    /UPDATE `credential_usage_event`\s+SET `total_tokens` = `input_tokens` \+ `output_tokens`\s+WHERE `total_tokens` = 0/,
  )
  assert.match(
    migration,
    /CREATE INDEX `credential_usage_event_org_provider` ON `credential_usage_event` \(`org_id`, `provider`\)/,
  )
  assert.match(
    migration,
    /CREATE INDEX `credential_usage_event_credential_created` ON `credential_usage_event` \(`credential_record_id`, `created_at`\)/,
  )
})
