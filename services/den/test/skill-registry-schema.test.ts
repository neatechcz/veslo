import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

const skillsSchema = await import("../src/skills/schema.js")
const dbSchema = await import("../src/db/schema.js")

const migrationUrl = new URL("../drizzle/0013_skill_registry.sql", import.meta.url)

const requiredTables = [
  "skills",
  "skill_versions",
  "skill_version_files",
  "skill_blobs",
  "skill_installations",
  "workspace_skill_sets",
  "workspace_skill_set_entries",
  "skill_materializations",
  "skill_review_requests",
  "skill_approvals",
  "skill_share_links",
  "skill_search_documents",
  "skill_audit_events",
] as const

function readMigration() {
  assert.equal(existsSync(migrationUrl), true)
  return readFileSync(migrationUrl, "utf8")
}

function tableBlock(migration: string, tableName: string) {
  const match = migration.match(new RegExp(`CREATE TABLE \`${tableName}\` \\([\\s\\S]*?\\n\\);`))
  assert.ok(match, `missing CREATE TABLE for ${tableName}`)
  return match[0]
}

test("skill registry schema exports every registry table through skills and db schema modules", () => {
  for (const tableName of requiredTables) {
    const exportName = skillsSchema.SkillRegistryTables[tableName]
    assert.equal(exportName, tableName)
  }

  assert.ok(skillsSchema.SkillTable)
  assert.ok(skillsSchema.SkillVersionTable)
  assert.ok(skillsSchema.SkillBlobTable)
  assert.strictEqual(dbSchema.SkillTable, skillsSchema.SkillTable)
  assert.strictEqual(dbSchema.SkillVersionTable, skillsSchema.SkillVersionTable)
})

test("skill_versions, version files, and blobs are immutable schema rows", () => {
  const migration = readMigration()

  assert.deepEqual(Array.from(skillsSchema.SkillVersionStatus), [
    "draft",
    "pending_review",
    "approved",
    "rejected",
    "archived",
  ])

  for (const tableName of ["skill_versions", "skill_version_files", "skill_blobs"] as const) {
    const block = tableBlock(migration, tableName)
    assert.match(block, /`created_at` timestamp\(3\) NOT NULL DEFAULT \(now\(\)\)/)
    assert.doesNotMatch(block, /`updated_at`/)
  }

  const versionBlock = tableBlock(migration, "skill_versions")
  assert.match(versionBlock, /`manifest_sha256` varchar\(64\) NOT NULL/)
  assert.match(versionBlock, /`package_sha256` varchar\(64\) NOT NULL/)
})

test("approved org and system installations have approval and approved-version wiring", () => {
  const migration = readMigration()
  const installationBlock = tableBlock(migration, "skill_installations")
  const approvalsBlock = tableBlock(migration, "skill_approvals")

  assert.deepEqual(Array.from(skillsSchema.SkillInstallationUpdatePolicy), [
    "pinned",
    "latest_user",
    "latest_approved",
    "release_channel",
  ])

  assert.match(installationBlock, /`scope` enum\('user','org','workspace','system'\) NOT NULL/)
  assert.match(
    installationBlock,
    /`update_policy` enum\('pinned','latest_user','latest_approved','release_channel'\) NOT NULL/,
  )
  assert.match(installationBlock, /`desired_version_id` varchar\(64\)/)
  assert.match(installationBlock, /`approval_id` varchar\(64\)/)
  assert.match(installationBlock, /`approved_version_id` varchar\(64\)/)
  assert.match(approvalsBlock, /`scope` enum\('org','system'\) NOT NULL/)
  assert.match(approvalsBlock, /`version_id` varchar\(64\) NOT NULL/)
  assert.match(migration, /skill_installation_scope_approval/)
  assert.match(migration, /skill_approval_scope_version/)
})

test("soft-deleted skills and installations retain enough data to restore before purge", () => {
  const migration = readMigration()
  const skillBlock = tableBlock(migration, "skills")
  const installationBlock = tableBlock(migration, "skill_installations")

  for (const block of [skillBlock, installationBlock]) {
    assert.match(block, /`deleted_at` timestamp\(3\)/)
    assert.match(block, /`deleted_by_user_id` varchar\(64\)/)
    assert.match(block, /`purge_after` timestamp\(3\)/)
    assert.match(block, /`restored_at` timestamp\(3\)/)
    assert.match(block, /`restored_by_user_id` varchar\(64\)/)
  }
})

test("skill package blobs are content-addressed and globally de-duplicated by hash", () => {
  const migration = readMigration()
  const blobBlock = tableBlock(migration, "skill_blobs")

  assert.match(blobBlock, /`sha256` varchar\(64\) NOT NULL/)
  assert.match(blobBlock, /`size_bytes` int unsigned NOT NULL/)
  assert.match(migration, /CREATE UNIQUE INDEX `skill_blob_sha256` ON `skill_blobs` \(`sha256`\)/)
})

test("tenant-scoped registry reads can filter by org before workspace or skill", () => {
  const migration = readMigration()
  const tenantScopedTables = [
    "skills",
    "skill_versions",
    "skill_installations",
    "workspace_skill_sets",
    "workspace_skill_set_entries",
    "skill_materializations",
    "skill_review_requests",
    "skill_approvals",
    "skill_share_links",
    "skill_search_documents",
    "skill_audit_events",
  ] as const

  for (const tableName of tenantScopedTables) {
    assert.match(tableBlock(migration, tableName), /`org_id` varchar\(64\)/, `${tableName} must carry org_id`)
    assert.match(
      migration,
      new RegExp(`CREATE INDEX \`${tableName}_org_[^\\n]+\` ON \`${tableName}\` \\(\`org_id\`, `),
      `${tableName} must have an org-first lookup index`,
    )
  }

  assert.match(tableBlock(migration, "workspace_skill_sets"), /`revision` int unsigned NOT NULL/)
  assert.match(tableBlock(migration, "workspace_skill_sets"), /`release_channel` varchar\(128\)/)
  assert.match(tableBlock(migration, "skill_materializations"), /`desired_version_id` varchar\(64\)/)
  assert.match(tableBlock(migration, "skill_materializations"), /`actual_version_id` varchar\(64\)/)
})
