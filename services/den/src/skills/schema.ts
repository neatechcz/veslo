import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  int,
  json,
  longtext,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core"

const idColumn = () => varchar("id", { length: 64 }).notNull()
const orgIdColumn = () => varchar("org_id", { length: 64 })
const userIdColumn = (name = "user_id") => varchar(name, { length: 64 })
const skillIdColumn = (name = "skill_id") => varchar(name, { length: 64 })
const versionIdColumn = (name = "version_id") => varchar(name, { length: 64 })
const sha256Column = (name: string) => varchar(name, { length: 64 }).notNull()

const createdAt = {
  created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
}

const timestamps = {
  ...createdAt,
  updated_at: timestamp("updated_at", { fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
}

const softDeleteColumns = {
  deleted_at: timestamp("deleted_at", { fsp: 3 }),
  deleted_by_user_id: userIdColumn("deleted_by_user_id"),
  purge_after: timestamp("purge_after", { fsp: 3 }),
  restored_at: timestamp("restored_at", { fsp: 3 }),
  restored_by_user_id: userIdColumn("restored_by_user_id"),
}

export const SkillRegistryTables = {
  skills: "skills",
  skill_versions: "skill_versions",
  skill_version_files: "skill_version_files",
  skill_blobs: "skill_blobs",
  skill_installations: "skill_installations",
  workspace_skill_sets: "workspace_skill_sets",
  workspace_skill_set_entries: "workspace_skill_set_entries",
  skill_materializations: "skill_materializations",
  skill_review_requests: "skill_review_requests",
  skill_approvals: "skill_approvals",
  skill_share_links: "skill_share_links",
  skill_search_documents: "skill_search_documents",
  skill_audit_events: "skill_audit_events",
} as const

export const SkillScope = ["user", "org", "workspace", "system"] as const
export const SkillVersionStatus = ["draft", "pending_review", "approved", "rejected", "archived"] as const
export const SkillInstallationUpdatePolicy = ["pinned", "latest_user", "latest_approved", "release_channel"] as const
export const SkillInstallationStatus = ["active", "deleted", "disabled"] as const
export const SkillMaterializationStatus = ["pending", "materialized", "failed", "stale"] as const
export const SkillReviewRequestStatus = ["pending", "approved", "rejected", "cancelled"] as const
export const SkillApprovalScope = ["org", "system"] as const
export const SkillShareLinkAudience = ["private", "org", "public"] as const

export type SkillScope = (typeof SkillScope)[number]
export type SkillVersionStatus = (typeof SkillVersionStatus)[number]
export type SkillInstallationUpdatePolicy = (typeof SkillInstallationUpdatePolicy)[number]
export type SkillInstallationStatus = (typeof SkillInstallationStatus)[number]
export type SkillMaterializationStatus = (typeof SkillMaterializationStatus)[number]
export type SkillReviewRequestStatus = (typeof SkillReviewRequestStatus)[number]
export type SkillApprovalScope = (typeof SkillApprovalScope)[number]
export type SkillShareLinkAudience = (typeof SkillShareLinkAudience)[number]

export const SkillTable = mysqlTable(
  SkillRegistryTables.skills,
  {
    id: idColumn().primaryKey(),
    scope: mysqlEnum("scope", SkillScope).notNull(),
    scope_owner_key: varchar("scope_owner_key", { length: 255 }).notNull(),
    org_id: orgIdColumn(),
    owner_user_id: userIdColumn("owner_user_id"),
    workspace_id: varchar("workspace_id", { length: 64 }),
    name: varchar("name", { length: 255 }).notNull(),
    display_name: varchar("display_name", { length: 255 }),
    description: text("description"),
    latest_version_id: versionIdColumn("latest_version_id"),
    created_by_user_id: userIdColumn("created_by_user_id").notNull(),
    ...softDeleteColumns,
    ...timestamps,
  },
  (table) => [
    uniqueIndex("skills_scope_owner_name").on(table.scope, table.scope_owner_key, table.name),
    index("skills_org_skill").on(table.org_id, table.id),
    index("skills_org_workspace").on(table.org_id, table.workspace_id, table.name),
    index("skills_org_deleted").on(table.org_id, table.deleted_at),
    index("skills_owner_user").on(table.owner_user_id, table.name),
  ],
)

export const SkillVersionTable = mysqlTable(
  SkillRegistryTables.skill_versions,
  {
    id: idColumn().primaryKey(),
    org_id: orgIdColumn(),
    skill_id: skillIdColumn().notNull(),
    version_number: int("version_number", { unsigned: true }).notNull(),
    status: mysqlEnum("status", SkillVersionStatus).notNull(),
    manifest_sha256: sha256Column("manifest_sha256"),
    package_sha256: sha256Column("package_sha256"),
    package_size_bytes: int("package_size_bytes", { unsigned: true }).notNull(),
    file_count: int("file_count", { unsigned: true }).notNull(),
    created_by_user_id: userIdColumn("created_by_user_id").notNull(),
    submitted_for_review_at: timestamp("submitted_for_review_at", { fsp: 3 }),
    approved_at: timestamp("approved_at", { fsp: 3 }),
    rejected_at: timestamp("rejected_at", { fsp: 3 }),
    archived_at: timestamp("archived_at", { fsp: 3 }),
    ...createdAt,
  },
  (table) => [
    uniqueIndex("skill_version_skill_number").on(table.skill_id, table.version_number),
    index("skill_version_manifest_sha256").on(table.manifest_sha256),
    index("skill_versions_org_skill").on(table.org_id, table.skill_id),
    index("skill_versions_org_status").on(table.org_id, table.status),
    index("skill_versions_status").on(table.status),
  ],
)

export const SkillBlobTable = mysqlTable(
  SkillRegistryTables.skill_blobs,
  {
    id: idColumn().primaryKey(),
    sha256: sha256Column("sha256"),
    size_bytes: int("size_bytes", { unsigned: true }).notNull(),
    media_type: varchar("media_type", { length: 255 }).notNull(),
    storage_key: varchar("storage_key", { length: 1024 }).notNull(),
    content_base64: longtext("content_base64").notNull(),
    ...createdAt,
  },
  (table) => [
    uniqueIndex("skill_blob_sha256").on(table.sha256),
  ],
)

export const SkillVersionFileTable = mysqlTable(
  SkillRegistryTables.skill_version_files,
  {
    id: idColumn().primaryKey(),
    org_id: orgIdColumn(),
    version_id: versionIdColumn().notNull(),
    blob_id: varchar("blob_id", { length: 64 }).notNull(),
    path: varchar("path", { length: 1024 }).notNull(),
    path_sha256: sha256Column("path_sha256"),
    sha256: sha256Column("sha256"),
    size_bytes: int("size_bytes", { unsigned: true }).notNull(),
    media_type: varchar("media_type", { length: 255 }).notNull(),
    executable: boolean("executable").notNull().default(false),
    text_content: longtext("text_content"),
    ...createdAt,
  },
  (table) => [
    uniqueIndex("skill_version_file_version_path_sha").on(table.version_id, table.path_sha256),
    index("skill_version_files_org_version").on(table.org_id, table.version_id),
    index("skill_version_files_blob").on(table.blob_id),
  ],
)

export const SkillInstallationTable = mysqlTable(
  SkillRegistryTables.skill_installations,
  {
    id: idColumn().primaryKey(),
    scope: mysqlEnum("scope", SkillScope).notNull(),
    org_id: orgIdColumn(),
    owner_user_id: userIdColumn("owner_user_id"),
    workspace_id: varchar("workspace_id", { length: 64 }),
    skill_id: skillIdColumn().notNull(),
    desired_version_id: versionIdColumn("desired_version_id"),
    approved_version_id: versionIdColumn("approved_version_id"),
    approval_id: varchar("approval_id", { length: 64 }),
    update_policy: mysqlEnum("update_policy", SkillInstallationUpdatePolicy).notNull(),
    release_channel: varchar("release_channel", { length: 128 }),
    status: mysqlEnum("status", SkillInstallationStatus).notNull().default("active"),
    installed_by_user_id: userIdColumn("installed_by_user_id").notNull(),
    ...softDeleteColumns,
    ...timestamps,
  },
  (table) => [
    index("skill_installations_org_scope").on(table.org_id, table.scope, table.skill_id),
    index("skill_installations_org_workspace").on(table.org_id, table.workspace_id, table.skill_id),
    index("skill_installations_org_user").on(table.org_id, table.owner_user_id, table.skill_id),
    index("skill_installation_scope_approval").on(table.scope, table.approval_id, table.approved_version_id),
    index("skill_installations_skill").on(table.skill_id),
    check(
      "skill_installation_active_managed_approval",
      sql`${table.status} <> 'active' OR ${table.scope} NOT IN ('org','system') OR (${table.approval_id} IS NOT NULL AND ${table.approved_version_id} IS NOT NULL)`,
    ),
  ],
)

export const WorkspaceSkillSetTable = mysqlTable(
  SkillRegistryTables.workspace_skill_sets,
  {
    id: idColumn().primaryKey(),
    org_id: orgIdColumn().notNull(),
    workspace_id: varchar("workspace_id", { length: 64 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    revision: int("revision", { unsigned: true }).notNull().default(1),
    release_channel: varchar("release_channel", { length: 128 }),
    created_by_user_id: userIdColumn("created_by_user_id").notNull(),
    ...softDeleteColumns,
    ...timestamps,
  },
  (table) => [
    uniqueIndex("workspace_skill_set_workspace_revision").on(table.org_id, table.workspace_id, table.revision),
    index("workspace_skill_sets_org_workspace").on(table.org_id, table.workspace_id),
    index("workspace_skill_sets_org_release").on(table.org_id, table.release_channel),
  ],
)

export const WorkspaceSkillSetEntryTable = mysqlTable(
  SkillRegistryTables.workspace_skill_set_entries,
  {
    id: idColumn().primaryKey(),
    org_id: orgIdColumn().notNull(),
    skill_set_id: varchar("skill_set_id", { length: 64 }).notNull(),
    installation_id: varchar("installation_id", { length: 64 }).notNull(),
    skill_id: skillIdColumn().notNull(),
    desired_version_id: versionIdColumn("desired_version_id"),
    release_channel: varchar("release_channel", { length: 128 }),
    position: int("position", { unsigned: true }).notNull().default(0),
    ...createdAt,
  },
  (table) => [
    uniqueIndex("workspace_skill_set_entry_installation").on(table.skill_set_id, table.installation_id),
    index("workspace_skill_set_entries_org_set").on(table.org_id, table.skill_set_id),
    index("workspace_skill_set_entries_org_skill").on(table.org_id, table.skill_id),
  ],
)

export const SkillMaterializationTable = mysqlTable(
  SkillRegistryTables.skill_materializations,
  {
    id: idColumn().primaryKey(),
    org_id: orgIdColumn(),
    workspace_id: varchar("workspace_id", { length: 64 }),
    owner_user_id: userIdColumn("owner_user_id"),
    skill_set_id: varchar("skill_set_id", { length: 64 }),
    installation_id: varchar("installation_id", { length: 64 }).notNull(),
    skill_id: skillIdColumn().notNull(),
    desired_version_id: versionIdColumn("desired_version_id"),
    actual_version_id: versionIdColumn("actual_version_id"),
    target_scope: mysqlEnum("target_scope", SkillScope).notNull(),
    target_path: varchar("target_path", { length: 2048 }).notNull(),
    status: mysqlEnum("status", SkillMaterializationStatus).notNull(),
    package_sha256: varchar("package_sha256", { length: 64 }),
    last_error: text("last_error"),
    materialized_at: timestamp("materialized_at", { fsp: 3 }),
    ...timestamps,
  },
  (table) => [
    index("skill_materializations_org_workspace").on(table.org_id, table.workspace_id, table.status),
    index("skill_materializations_org_skill").on(table.org_id, table.skill_id),
    index("skill_materializations_installation").on(table.installation_id),
    index("skill_materializations_desired_version").on(table.desired_version_id),
    index("skill_materializations_actual_version").on(table.actual_version_id),
  ],
)

export const SkillReviewRequestTable = mysqlTable(
  SkillRegistryTables.skill_review_requests,
  {
    id: idColumn().primaryKey(),
    org_id: orgIdColumn(),
    scope: mysqlEnum("scope", SkillApprovalScope).notNull(),
    skill_id: skillIdColumn().notNull(),
    version_id: versionIdColumn().notNull(),
    status: mysqlEnum("status", SkillReviewRequestStatus).notNull().default("pending"),
    requested_by_user_id: userIdColumn("requested_by_user_id").notNull(),
    reason: text("reason"),
    release_channel: varchar("release_channel", { length: 128 }),
    reviewer_note: text("reviewer_note"),
    resolved_by_user_id: userIdColumn("resolved_by_user_id"),
    resolved_at: timestamp("resolved_at", { fsp: 3 }),
    ...timestamps,
  },
  (table) => [
    index("skill_review_requests_org_status").on(table.org_id, table.status),
    index("skill_review_requests_org_version").on(table.org_id, table.version_id),
    index("skill_review_requests_version_status").on(table.version_id, table.status),
  ],
)

export const SkillApprovalTable = mysqlTable(
  SkillRegistryTables.skill_approvals,
  {
    id: idColumn().primaryKey(),
    org_id: orgIdColumn(),
    scope: mysqlEnum("scope", SkillApprovalScope).notNull(),
    approval_owner_key: varchar("approval_owner_key", { length: 255 }).notNull(),
    skill_id: skillIdColumn().notNull(),
    version_id: versionIdColumn().notNull(),
    review_request_id: varchar("review_request_id", { length: 64 }),
    release_channel: varchar("release_channel", { length: 128 }),
    release_channel_key: varchar("release_channel_key", { length: 128 }).notNull().default("default"),
    approved_by_user_id: userIdColumn("approved_by_user_id").notNull(),
    approved_at: timestamp("approved_at", { fsp: 3 }).notNull().defaultNow(),
    revoked_by_user_id: userIdColumn("revoked_by_user_id"),
    revoked_at: timestamp("revoked_at", { fsp: 3 }),
  },
  (table) => [
    uniqueIndex("skill_approval_scope_version").on(
      table.scope,
      table.approval_owner_key,
      table.version_id,
      table.release_channel_key,
    ),
    index("skill_approvals_org_version").on(table.org_id, table.version_id),
    index("skill_approvals_org_skill").on(table.org_id, table.skill_id),
    index("skill_approvals_review_request").on(table.review_request_id),
  ],
)

export const SkillShareLinkTable = mysqlTable(
  SkillRegistryTables.skill_share_links,
  {
    id: idColumn().primaryKey(),
    org_id: orgIdColumn(),
    skill_id: skillIdColumn().notNull(),
    version_id: versionIdColumn("version_id"),
    audience: mysqlEnum("audience", SkillShareLinkAudience).notNull(),
    token_hash: varchar("token_hash", { length: 128 }).notNull(),
    created_by_user_id: userIdColumn("created_by_user_id").notNull(),
    expires_at: timestamp("expires_at", { fsp: 3 }),
    revoked_at: timestamp("revoked_at", { fsp: 3 }),
    ...createdAt,
  },
  (table) => [
    uniqueIndex("skill_share_link_token_hash").on(table.token_hash),
    index("skill_share_links_org_skill").on(table.org_id, table.skill_id),
    index("skill_share_links_org_audience").on(table.org_id, table.audience),
  ],
)

export const SkillSearchDocumentTable = mysqlTable(
  SkillRegistryTables.skill_search_documents,
  {
    id: idColumn().primaryKey(),
    org_id: orgIdColumn(),
    skill_id: skillIdColumn().notNull(),
    version_id: versionIdColumn().notNull(),
    source_language: varchar("source_language", { length: 16 }).notNull().default("en"),
    locale: varchar("locale", { length: 16 }).notNull(),
    title: varchar("title", { length: 512 }).notNull(),
    body: longtext("body").notNull(),
    translated_title: varchar("translated_title", { length: 512 }),
    translated_body: longtext("translated_body"),
    search_text: longtext("search_text").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("skill_search_document_version_locale").on(table.version_id, table.locale),
    index("skill_search_documents_org_locale").on(table.org_id, table.locale),
    index("skill_search_documents_org_skill").on(table.org_id, table.skill_id),
  ],
)

export const SkillAuditEventTable = mysqlTable(
  SkillRegistryTables.skill_audit_events,
  {
    id: idColumn().primaryKey(),
    org_id: orgIdColumn(),
    skill_id: skillIdColumn(),
    version_id: versionIdColumn("version_id"),
    installation_id: varchar("installation_id", { length: 64 }),
    workspace_id: varchar("workspace_id", { length: 64 }),
    actor_user_id: userIdColumn("actor_user_id").notNull(),
    action: varchar("action", { length: 128 }).notNull(),
    payload: json("payload"),
    ...createdAt,
  },
  (table) => [
    index("skill_audit_events_org_time").on(table.org_id, table.created_at),
    index("skill_audit_events_org_skill").on(table.org_id, table.skill_id),
    index("skill_audit_events_actor_time").on(table.actor_user_id, table.created_at),
  ],
)
