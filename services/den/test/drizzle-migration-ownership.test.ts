import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import test from "node:test"

const managedAiTables = [
  "credential_record",
  "credential_secret",
  "credential_binding",
  "session_lease",
  "credential_health_event",
  "credential_usage_event",
  "user_ai_access_policy",
] as const

test("den main migrations do not target managed-AI database tables", () => {
  const migrationsUrl = new URL("../drizzle/", import.meta.url)
  const offenders: string[] = []

  for (const filename of readdirSync(migrationsUrl).filter((entry) => entry.endsWith(".sql"))) {
    const migration = readFileSync(new URL(filename, migrationsUrl), "utf8")
    for (const tableName of managedAiTables) {
      if (migration.includes(`\`${tableName}\``)) {
        offenders.push(`${filename}: ${tableName}`)
      }
    }
  }

  assert.deepEqual(offenders, [])
})
