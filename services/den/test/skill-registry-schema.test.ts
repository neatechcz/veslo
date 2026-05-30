import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

const skillsSchema = await import("../src/skills/schema.js")
const skillPolicy = await import("../src/skills/policy.js")
const dbSchema = await import("../src/db/schema.js")
const { getTableConfig } = await import("drizzle-orm/mysql-core")

const migrationUrls = [
  new URL("../drizzle/0013_skill_registry.sql", import.meta.url),
  new URL("../drizzle/0014_skill_rollout_policies.sql", import.meta.url),
]

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
  "skill_rollout_policies",
] as const

function readMigration() {
  return migrationUrls.map((migrationUrl) => {
    assert.equal(existsSync(migrationUrl), true)
    return readFileSync(migrationUrl, "utf8")
  }).join("\n")
}

function tableBlock(migration: string, tableName: string) {
  const match = migration.match(new RegExp(`CREATE TABLE \`${tableName}\` \\([\\s\\S]*?\\n\\);`))
  assert.ok(match, `missing CREATE TABLE for ${tableName}`)
  return match[0]
}

function triggerStatement(migration: string, triggerName: string) {
  const match = migration.match(new RegExp(`CREATE TRIGGER \`${triggerName}\`[\\s\\S]*?;`))
  assert.ok(match, `missing trigger ${triggerName}`)
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
  assert.match(migration, /CREATE INDEX `skill_version_manifest_sha256` ON `skill_versions` \(`manifest_sha256`\)/)
  assert.doesNotMatch(migration, /CREATE UNIQUE INDEX `skill_version_manifest_sha256`/)
  const skillVersionTrigger = triggerStatement(migration, "skill_versions_prevent_update")
  assert.match(skillVersionTrigger, /SET NEW\.id = IF\(/)
  for (const immutableColumn of [
    "id",
    "org_id",
    "skill_id",
    "version_number",
    "manifest_sha256",
    "package_sha256",
    "package_size_bytes",
    "file_count",
    "created_by_user_id",
    "created_at",
  ]) {
    assert.match(skillVersionTrigger, new RegExp(`OLD\\.${immutableColumn}`))
    assert.match(skillVersionTrigger, new RegExp(`NEW\\.${immutableColumn}`))
  }
  for (const mutableColumn of ["status", "submitted_for_review_at", "approved_at", "rejected_at", "archived_at"]) {
    assert.doesNotMatch(skillVersionTrigger, new RegExp(`OLD\\.${mutableColumn}|NEW\\.${mutableColumn}`))
  }
  assert.match(
    migration,
    /CREATE TRIGGER `skill_version_files_prevent_update` BEFORE UPDATE ON `skill_version_files` FOR EACH ROW SIGNAL SQLSTATE '45000'/,
  )
  assert.match(
    migration,
    /CREATE TRIGGER `skill_blobs_prevent_update` BEFORE UPDATE ON `skill_blobs` FOR EACH ROW SIGNAL SQLSTATE '45000'/,
  )
})

test("skill registry key helpers produce canonical non-null keys", () => {
  assert.equal(
    skillPolicy.skillVersionFilePathSha256("SKILL.md"),
    createHash("sha256").update("SKILL.md").digest("hex"),
  )
  assert.equal(
    skillPolicy.skillVersionFilePathSha256("scripts\\run.sh"),
    createHash("sha256").update("scripts/run.sh").digest("hex"),
  )
  assert.throws(() => skillPolicy.skillVersionFilePathSha256("../SKILL.md"), /invalid_skill_file_path/)

  assert.equal(skillPolicy.skillScopeOwnerKey({ scope: "user", userId: "user_1" }), "user:user_1")
  assert.equal(skillPolicy.skillScopeOwnerKey({ scope: "org", orgId: "org_1" }), "org:org_1")
  assert.equal(
    skillPolicy.skillScopeOwnerKey({ scope: "workspace", orgId: "org_1", workspaceId: "workspace_1" }),
    "workspace:org_1:workspace_1",
  )
  assert.equal(skillPolicy.skillScopeOwnerKey({ scope: "system" }), "system:__system__")

  assert.equal(skillPolicy.skillApprovalOwnerKey({ scope: "org", orgId: "org_1" }), "org:org_1")
  assert.equal(skillPolicy.skillApprovalOwnerKey({ scope: "system" }), "system:__system__")

  assert.equal(skillPolicy.skillReleaseChannelKey(null), "default")
  assert.equal(skillPolicy.skillReleaseChannelKey(undefined), "default")
  assert.equal(skillPolicy.skillReleaseChannelKey(""), "default")
  assert.equal(skillPolicy.skillReleaseChannelKey("  beta  "), "beta")
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
  assert.match(installationBlock, /CONSTRAINT `skill_installation_active_managed_approval` CHECK/)
  assert.match(installationBlock, /`scope` NOT IN \('org','system'\)/)
  assert.match(installationBlock, /`approval_id` IS NOT NULL/)
  assert.match(installationBlock, /`approved_version_id` IS NOT NULL/)
  assert.ok(
    getTableConfig(skillsSchema.SkillInstallationTable).checks.some(
      (check) => check.name === "skill_installation_active_managed_approval",
    ),
  )
  assert.match(approvalsBlock, /`scope` enum\('org','system'\) NOT NULL/)
  assert.match(approvalsBlock, /`version_id` varchar\(64\) NOT NULL/)
  assert.match(migration, /skill_installation_scope_approval/)
  assert.match(migration, /skill_approval_scope_version/)
})

test("skill rollout policies encode target, audience, and removal policy", () => {
  const migration = readMigration()
  const rolloutBlock = tableBlock(migration, "skill_rollout_policies")

  assert.match(rolloutBlock, /`target` enum\('user-global','workspace'\) NOT NULL/)
  assert.match(
    rolloutBlock,
    /`audience` enum\('user','selected-workspaces','all-org-users','all-platform-users'\) NOT NULL/,
  )
  assert.match(
    rolloutBlock,
    /`removal_policy` enum\('user_removable','admin_removable','locked'\) NOT NULL DEFAULT 'user_removable'/,
  )
  assert.match(rolloutBlock, /`enabled` boolean NOT NULL DEFAULT true/)
  assert.match(rolloutBlock, /CONSTRAINT `skill_rollout_user_target_shape` CHECK/)
  assert.match(rolloutBlock, /CONSTRAINT `skill_rollout_workspace_target_shape` CHECK/)
  assert.match(rolloutBlock, /CONSTRAINT `skill_rollout_audience_user_shape` CHECK/)
  assert.match(rolloutBlock, /CONSTRAINT `skill_rollout_audience_workspace_shape` CHECK/)
  assert.match(rolloutBlock, /CONSTRAINT `skill_rollout_audience_all_org_shape` CHECK/)
  assert.match(rolloutBlock, /CONSTRAINT `skill_rollout_audience_all_platform_shape` CHECK/)
  assert.match(migration, /skill_rollout_active_target_guard/)
  assert.match(migration, /skill_rollout_org_audience/)
  assert.match(migration, /skill_rollout_workspace_lookup/)
})

test("approved org and system installation policy rejects unapproved or mismatched versions", () => {
  const orgInstallation = {
    scope: "org",
    status: "active",
    orgId: "org_1",
    skillId: "skill_1",
    approvalId: "approval_1",
    approvedVersionId: "version_1",
  } as const
  const approvedVersion = {
    id: "version_1",
    orgId: "org_1",
    skillId: "skill_1",
    status: "approved",
  } as const
  const orgApproval = {
    id: "approval_1",
    scope: "org",
    orgId: "org_1",
    skillId: "skill_1",
    versionId: "version_1",
    revokedAt: null,
  } as const

  assert.deepEqual(
    skillPolicy.validateManagedSkillInstallationApproval({
      installation: orgInstallation,
      version: approvedVersion,
      approval: orgApproval,
    }),
    { ok: true },
  )
  assert.deepEqual(
    skillPolicy.validateManagedSkillInstallationApproval({
      installation: {
        ...orgInstallation,
        approvalId: "approval_system",
      },
      version: { ...approvedVersion, orgId: null },
      approval: { ...orgApproval, id: "approval_system", scope: "system", orgId: null },
    }),
    { ok: true },
  )
  assert.deepEqual(
    skillPolicy.validateManagedSkillInstallationApproval({
      installation: orgInstallation,
      version: { ...approvedVersion, status: "draft" },
      approval: orgApproval,
    }),
    { ok: false, code: "version_not_approved" },
  )
  assert.deepEqual(
    skillPolicy.validateManagedSkillInstallationApproval({
      installation: orgInstallation,
      version: { ...approvedVersion, status: "rejected" },
      approval: orgApproval,
    }),
    { ok: false, code: "version_not_approved" },
  )
  assert.deepEqual(
    skillPolicy.validateManagedSkillInstallationApproval({
      installation: orgInstallation,
      version: approvedVersion,
      approval: { ...orgApproval, versionId: "version_2" },
    }),
    { ok: false, code: "approval_version_mismatch" },
  )
  assert.deepEqual(
    skillPolicy.validateManagedSkillInstallationApproval({
      installation: orgInstallation,
      version: approvedVersion,
      approval: { ...orgApproval, orgId: "org_2" },
    }),
    { ok: false, code: "approval_org_mismatch" },
  )

  assert.deepEqual(
    skillPolicy.validateManagedSkillInstallationApproval({
      installation: {
        scope: "system",
        status: "active",
        orgId: null,
        skillId: "skill_1",
        approvalId: "approval_2",
        approvedVersionId: "version_1",
      },
      version: { ...approvedVersion, orgId: null },
      approval: { ...orgApproval, id: "approval_2", scope: "system", orgId: null },
    }),
    { ok: true },
  )
  assert.deepEqual(
    skillPolicy.validateManagedSkillInstallationApproval({
      installation: {
        scope: "system",
        status: "active",
        orgId: "org_1",
        skillId: "skill_1",
        approvalId: "approval_2",
        approvedVersionId: "version_1",
      },
      version: { ...approvedVersion, orgId: null },
      approval: { ...orgApproval, id: "approval_2", scope: "system", orgId: null },
    }),
    { ok: false, code: "approval_org_mismatch" },
  )
})

test("skill version files use a bounded path hash for version uniqueness", () => {
  const migration = readMigration()
  const fileBlock = tableBlock(migration, "skill_version_files")

  assert.match(fileBlock, /`path` varchar\(1024\) NOT NULL/)
  assert.match(fileBlock, /`path_sha256` varchar\(64\) NOT NULL/)
  assert.match(fileBlock, /`text_content` longtext/)
  assert.match(
    migration,
    /CREATE UNIQUE INDEX `skill_version_file_version_path_sha` ON `skill_version_files` \(`version_id`, `path_sha256`\)/,
  )
  assert.doesNotMatch(migration, /CREATE UNIQUE INDEX `skill_version_file_version_path` ON `skill_version_files` \(`version_id`, `path`\)/)
})

test("registry uniqueness keys avoid nullable owner and release-channel columns", () => {
  const migration = readMigration()
  const skillBlock = tableBlock(migration, "skills")
  const approvalBlock = tableBlock(migration, "skill_approvals")
  const reviewRequestBlock = tableBlock(migration, "skill_review_requests")

  assert.match(skillBlock, /`scope_owner_key` varchar\(255\) NOT NULL/)
  assert.match(migration, /CREATE UNIQUE INDEX `skills_scope_owner_name` ON `skills` \(`scope`, `scope_owner_key`, `name`\)/)

  assert.match(approvalBlock, /`approval_owner_key` varchar\(255\) NOT NULL/)
  assert.match(approvalBlock, /`release_channel_key` varchar\(128\) NOT NULL DEFAULT 'default'/)
  assert.match(reviewRequestBlock, /`release_channel` varchar\(128\)/)
  assert.match(
    migration,
    /CREATE UNIQUE INDEX `skill_approval_scope_version` ON `skill_approvals` \(`scope`, `approval_owner_key`, `version_id`, `release_channel_key`\)/,
  )
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

test("skill retention policy allows hard purge only for admins after retention and restore before purge", () => {
  const now = new Date("2026-05-26T12:00:00.000Z")
  const deletedAt = new Date("2026-05-20T12:00:00.000Z")

  assert.deepEqual(
    skillPolicy.evaluateSkillRegistryRetentionPolicy({
      roles: ["owner"],
      deletedAt,
      purgeAfter: new Date("2026-05-27T12:00:00.000Z"),
      now,
    }),
    { canHardPurge: false, canRestore: true },
  )
  assert.deepEqual(
    skillPolicy.evaluateSkillRegistryRetentionPolicy({
      roles: ["member"],
      deletedAt,
      purgeAfter: new Date("2026-05-25T12:00:00.000Z"),
      now,
    }),
    { canHardPurge: false, canRestore: false },
  )
  assert.deepEqual(
    skillPolicy.evaluateSkillRegistryRetentionPolicy({
      roles: ["platform_admin"],
      deletedAt,
      purgeAfter: new Date("2026-05-25T12:00:00.000Z"),
      now,
    }),
    { canHardPurge: true, canRestore: false },
  )
  assert.deepEqual(
    skillPolicy.evaluateSkillRegistryRetentionPolicy({
      roles: ["platform_admin"],
      deletedAt: null,
      purgeAfter: new Date("2026-05-25T12:00:00.000Z"),
      now,
    }),
    { canHardPurge: false, canRestore: false },
  )
})

test("skill package blobs are content-addressed and globally de-duplicated by hash", () => {
  const migration = readMigration()
  const blobBlock = tableBlock(migration, "skill_blobs")

  assert.match(blobBlock, /`sha256` varchar\(64\) NOT NULL/)
  assert.match(blobBlock, /`size_bytes` int unsigned NOT NULL/)
  assert.match(blobBlock, /`content_base64` longtext NOT NULL/)
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

test("tenant isolation policy rejects cross-org references and allows matching org plus system refs", () => {
  assert.deepEqual(
    skillPolicy.validateSkillRegistryTenantIsolation({
      orgId: "org_1",
      refs: [
        { entity: "skill", orgId: "org_1" },
        { entity: "version", orgId: "org_1" },
        { entity: "installation", orgId: "org_1" },
        { entity: "workspace_skill_set", orgId: "org_1" },
        { entity: "materialization", orgId: "org_1" },
        { entity: "system_approval", orgId: null, systemScope: true },
      ],
    }),
    { ok: true },
  )
  assert.deepEqual(
    skillPolicy.validateSkillRegistryTenantIsolation({
      orgId: "org_1",
      refs: [
        { entity: "skill", orgId: "org_1" },
        { entity: "version", orgId: "org_2" },
      ],
    }),
    { ok: false, code: "org_mismatch", entity: "version" },
  )
  assert.deepEqual(
    skillPolicy.validateSkillRegistryTenantIsolation({
      orgId: "org_1",
      refs: [
        { entity: "skill", orgId: "org_1" },
        { entity: "approval", orgId: null },
      ],
    }),
    { ok: false, code: "missing_org", entity: "approval" },
  )
  assert.deepEqual(
    skillPolicy.validateSkillRegistryTenantIsolation({
      orgId: null,
      refs: [{ entity: "system_skill", orgId: null, systemScope: true }],
    }),
    { ok: true },
  )
  assert.deepEqual(
    skillPolicy.validateSkillRegistryTenantIsolation({
      orgId: null,
      refs: [{ entity: "ambiguous_null_skill", orgId: null }],
    }),
    { ok: false, code: "missing_system_scope", entity: "ambiguous_null_skill" },
  )
})
