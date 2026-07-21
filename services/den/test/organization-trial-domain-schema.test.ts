import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"
import { getTableConfig } from "drizzle-orm/mysql-core"

const schema = await import("../src/db/schema.js")
const migrationUrl = new URL("../drizzle/0023_organization_trial_domain_claims.sql", import.meta.url)
const bootstrapSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
const journalUrl = new URL("../drizzle/meta/_journal.json", import.meta.url)

function readBootstrapCreateTableBlock(source: string, tableName: string) {
  const escapedTableName = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = source.match(
    new RegExp("CREATE TABLE IF NOT EXISTS \\\\`" + escapedTableName + "\\\\` \\([\\s\\S]*?\\n\\s*\\)"),
  )
  assert.ok(match, `Missing compatibility-bootstrap CREATE TABLE block for ${tableName}`)
  return match[0]
}

test("trial-domain claim schema exposes an immutable claim ledger", () => {
  const table = Reflect.get(schema, "OrganizationTrialDomainClaimTable")
  assert.ok(table)

  const config = getTableConfig(table)
  assert.equal(config.name, "organization_trial_domain_claim")
  assert.deepEqual(
    config.columns.map((column) => column.name),
    ["id", "domain", "org_id", "claimed_at"],
  )

  const idColumn = config.columns.find((column) => column.name === "id")
  const domainColumn = config.columns.find((column) => column.name === "domain")
  const orgIdColumn = config.columns.find((column) => column.name === "org_id")
  const claimedAtColumn = config.columns.find((column) => column.name === "claimed_at")
  assert.equal(idColumn?.primary, true)
  assert.equal(domainColumn?.notNull, true)
  assert.equal(orgIdColumn?.notNull, true)
  assert.equal(claimedAtColumn?.notNull, true)
  assert.equal(claimedAtColumn?.hasDefault, true)

  assert.deepEqual(
    config.indexes.map((index) => ({
      name: index.config.name,
      unique: index.config.unique,
      columns: index.config.columns.map((column) => "name" in column ? column.name : null),
    })),
    [
      {
        name: "organization_trial_domain_claim_domain",
        unique: true,
        columns: ["domain"],
      },
      {
        name: "organization_trial_domain_claim_org_id",
        unique: false,
        columns: ["org_id"],
      },
    ],
  )
  assert.equal(config.foreignKeys.length, 0)
})

test("trial-domain claim migration creates immutable unique-domain storage", () => {
  assert.equal(existsSync(migrationUrl), true)

  const migration = readFileSync(migrationUrl, "utf8")
  assert.match(migration, /CREATE TABLE `organization_trial_domain_claim`/)
  assert.match(migration, /`id` varchar\(64\) NOT NULL/)
  assert.match(migration, /`domain` varchar\(255\) NOT NULL/)
  assert.match(migration, /`org_id` varchar\(64\) NOT NULL/)
  assert.match(migration, /`claimed_at` timestamp\(3\) NOT NULL DEFAULT \(now\(\)\)/)
  assert.match(migration, /CONSTRAINT `organization_trial_domain_claim_id` PRIMARY KEY\(`id`\)/)
  assert.match(
    migration,
    /CREATE UNIQUE INDEX `organization_trial_domain_claim_domain` ON `organization_trial_domain_claim` \(`domain`\)/,
  )
  assert.match(
    migration,
    /CREATE INDEX `organization_trial_domain_claim_org_id` ON `organization_trial_domain_claim` \(`org_id`\)/,
  )
  assert.doesNotMatch(migration, /FOREIGN KEY|ON DELETE|DELETE FROM/i)
})

test("DEN compatibility bootstrap creates the claim ledger and its indexes", () => {
  const tableBlock = readBootstrapCreateTableBlock(bootstrapSource, "organization_trial_domain_claim")

  assert.match(tableBlock, /\\`id\\` varchar\(64\) NOT NULL/)
  assert.match(tableBlock, /\\`domain\\` varchar\(255\) NOT NULL/)
  assert.match(tableBlock, /\\`org_id\\` varchar\(64\) NOT NULL/)
  assert.match(tableBlock, /\\`claimed_at\\` timestamp\(3\) NOT NULL DEFAULT \(now\(\)\)/)
  assert.match(tableBlock, /CONSTRAINT \\`organization_trial_domain_claim_id\\` PRIMARY KEY\(\\`id\\`\)/)
  assert.doesNotMatch(tableBlock, /FOREIGN KEY|REFERENCES|ON DELETE|DELETE FROM|CASCADE/i)
  assert.match(
    bootstrapSource,
    /ensureIndex\(\s*"organization_trial_domain_claim",\s*"organization_trial_domain_claim_domain",\s*\["domain"\],\s*true,?\s*\)/,
  )
  assert.match(
    bootstrapSource,
    /ensureIndex\(\s*"organization_trial_domain_claim",\s*"organization_trial_domain_claim_org_id",\s*\["org_id"\],?\s*\)/,
  )
})

test("migration journal records the claim ledger after all prior migrations", () => {
  const journal = JSON.parse(readFileSync(journalUrl, "utf8")) as {
    entries: Array<{ idx: number; when: number; tag: string; breakpoints: boolean }>
  }
  const entry = journal.entries.at(-1)
  const previousEntry = journal.entries.at(-2)

  assert.deepEqual(entry, {
    idx: 24,
    version: "5",
    when: entry?.when,
    tag: "0023_organization_trial_domain_claims",
    breakpoints: true,
  })
  assert.ok(entry && previousEntry && entry.when > previousEntry.when)
})
