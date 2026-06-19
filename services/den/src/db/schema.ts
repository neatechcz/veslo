import { sql } from "drizzle-orm"
import {
  boolean,
  int,
  index,
  json,
  longtext,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core"

const id = () => varchar("id", { length: 64 }).notNull()

const timestamps = {
  created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
}

export const OrgRole = ["owner", "member"] as const
export const PlatformRole = ["platform_admin"] as const
export const WorkerDestination = ["local", "cloud"] as const
export const WorkerStatus = ["provisioning", "healthy", "failed", "stopped"] as const
export const TokenScope = ["client", "host"] as const
export const DesktopAuthIntent = ["signin", "signup"] as const
export const DesktopAuthSessionStatus = ["started", "browser_authed", "exchanged", "expired", "cancelled"] as const
export const DesktopAuthTransactionStatus = ["started", "browser_authed", "exchanged", "expired", "cancelled"] as const
export const FeedbackType = ["bug"] as const
export const FeedbackStatus = ["pending", "projected", "failed"] as const
export const FeedbackScreenshotStatus = ["captured", "failed"] as const
export const FeedbackProjectorAttemptStatus = ["pending", "succeeded", "failed"] as const
export const GoogleWorkspaceConnector = ["google-gmail", "google-calendar", "google-drive"] as const
export const GoogleWorkspaceConnectionState = ["connected", "revoked", "error"] as const

export const AuthUserTable = mysqlTable(
  "user",
  {
    id: varchar("id", { length: 36 }).notNull().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [uniqueIndex("user_email").on(table.email)],
)

export const AuthSessionTable = mysqlTable(
  "session",
  {
    id: varchar("id", { length: 36 }).notNull().primaryKey(),
    userId: varchar("user_id", { length: 36 }).notNull(),
    token: varchar("token", { length: 255 }).notNull(),
    expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("session_token").on(table.token),
    index("session_user_id").on(table.userId),
  ],
)

export const AuthAccountTable = mysqlTable(
  "account",
  {
    id: varchar("id", { length: 36 }).notNull().primaryKey(),
    userId: varchar("user_id", { length: 36 }).notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { fsp: 3 }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { fsp: 3 }),
    scope: text("scope"),
    idToken: text("id_token"),
    password: text("password"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [index("account_user_id").on(table.userId)],
)

export const AuthVerificationTable = mysqlTable(
  "verification",
  {
    id: varchar("id", { length: 36 }).notNull().primaryKey(),
    identifier: varchar("identifier", { length: 255 }).notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [index("verification_identifier").on(table.identifier)],
)

export const user = AuthUserTable
export const session = AuthSessionTable
export const account = AuthAccountTable
export const verification = AuthVerificationTable

export const OrgTable = mysqlTable(
  "org",
  {
    id: id().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 255 }).notNull(),
    owner_user_id: varchar("owner_user_id", { length: 64 }).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("org_slug").on(table.slug), index("org_owner_user_id").on(table.owner_user_id)],
)

export const OrgMembershipTable = mysqlTable(
  "org_membership",
  {
    id: id().primaryKey(),
    org_id: varchar("org_id", { length: 64 }).notNull(),
    user_id: varchar("user_id", { length: 64 }).notNull(),
    role: mysqlEnum("role", OrgRole).notNull(),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [index("org_membership_org_id").on(table.org_id), index("org_membership_user_id").on(table.user_id)],
)

export const PlatformRoleTable = mysqlTable(
  "platform_role",
  {
    id: id().primaryKey(),
    user_id: varchar("user_id", { length: 64 }).notNull(),
    role: mysqlEnum("role", PlatformRole).notNull(),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("platform_role_user_id").on(table.user_id),
  ],
)

export const AdminUserStateTable = mysqlTable(
  "admin_user_state",
  {
    id: id().primaryKey(),
    user_id: varchar("user_id", { length: 64 }).notNull(),
    disabled: boolean("disabled").notNull().default(false),
    disabled_at: timestamp("disabled_at", { fsp: 3 }),
    disabled_by_user_id: varchar("disabled_by_user_id", { length: 64 }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("admin_user_state_user_id").on(table.user_id),
    index("admin_user_state_disabled").on(table.disabled),
  ],
)

export const WorkerTable = mysqlTable(
  "worker",
  {
    id: id().primaryKey(),
    org_id: varchar("org_id", { length: 64 }).notNull(),
    created_by_user_id: varchar("created_by_user_id", { length: 64 }),
    name: varchar("name", { length: 255 }).notNull(),
    description: varchar("description", { length: 1024 }),
    destination: mysqlEnum("destination", WorkerDestination).notNull(),
    status: mysqlEnum("status", WorkerStatus).notNull(),
    failure_reason: varchar("failure_reason", { length: 2048 }),
    image_version: varchar("image_version", { length: 128 }),
    workspace_path: varchar("workspace_path", { length: 1024 }),
    sandbox_backend: varchar("sandbox_backend", { length: 64 }),
    ...timestamps,
  },
  (table) => [
    index("worker_org_id").on(table.org_id),
    index("worker_created_by_user_id").on(table.created_by_user_id),
    index("worker_status").on(table.status),
  ],
)

export const WorkerInstanceTable = mysqlTable(
  "worker_instance",
  {
    id: id().primaryKey(),
    worker_id: varchar("worker_id", { length: 64 }).notNull(),
    provider: varchar("provider", { length: 64 }).notNull(),
    region: varchar("region", { length: 64 }),
    url: varchar("url", { length: 2048 }).notNull(),
    status: mysqlEnum("status", WorkerStatus).notNull(),
    ...timestamps,
  },
  (table) => [index("worker_instance_worker_id").on(table.worker_id)],
)

export const WorkerTokenTable = mysqlTable(
  "worker_token",
  {
    id: id().primaryKey(),
    worker_id: varchar("worker_id", { length: 64 }).notNull(),
    scope: mysqlEnum("scope", TokenScope).notNull(),
    token: varchar("token", { length: 512 }).notNull(),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    revoked_at: timestamp("revoked_at", { fsp: 3 }),
  },
  (table) => [
    index("worker_token_worker_id").on(table.worker_id),
    uniqueIndex("worker_token_token").on(table.token),
  ],
)

export const WorkerBundleTable = mysqlTable(
  "worker_bundle",
  {
    id: id().primaryKey(),
    worker_id: varchar("worker_id", { length: 64 }).notNull(),
    storage_url: varchar("storage_url", { length: 2048 }).notNull(),
    status: varchar("status", { length: 64 }).notNull(),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [index("worker_bundle_worker_id").on(table.worker_id)],
)

export const DesktopAuthHandoffTable = mysqlTable(
  "desktop_auth_handoff",
  {
    id: id().primaryKey(),
    code: varchar("code", { length: 255 }).notNull(),
    session_id: varchar("session_id", { length: 64 }),
    user_id: varchar("user_id", { length: 64 }).notNull(),
    org_id: varchar("org_id", { length: 64 }).notNull(),
    expires_at: timestamp("expires_at", { fsp: 3 }).notNull(),
    consumed_at: timestamp("consumed_at", { fsp: 3 }),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("desktop_auth_handoff_code").on(table.code),
    index("desktop_auth_handoff_user_id").on(table.user_id),
    index("desktop_auth_handoff_session_id").on(table.session_id),
  ],
)

export const DesktopAuthSessionTable = mysqlTable(
  "desktop_auth_session",
  {
    id: id().primaryKey(),
    intent: mysqlEnum("intent", DesktopAuthIntent).notNull(),
    state_hash: varchar("state_hash", { length: 128 }).notNull(),
    code_challenge: varchar("code_challenge", { length: 255 }).notNull(),
    code_challenge_method: varchar("code_challenge_method", { length: 16 }).notNull(),
    redirect_uri: varchar("redirect_uri", { length: 512 }).notNull(),
    status: mysqlEnum("status", DesktopAuthSessionStatus).notNull(),
    user_id: varchar("user_id", { length: 64 }),
    org_id: varchar("org_id", { length: 64 }),
    browser_ip: text("browser_ip"),
    browser_user_agent: text("browser_user_agent"),
    expires_at: timestamp("expires_at", { fsp: 3 }).notNull(),
    exchanged_at: timestamp("exchanged_at", { fsp: 3 }),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("desktop_auth_session_status_expires").on(table.status, table.expires_at),
    index("desktop_auth_session_user_id").on(table.user_id),
  ],
)

export const DesktopAuthTransactionTable = mysqlTable(
  "desktop_auth_transaction",
  {
    id: id().primaryKey(),
    transaction_id: varchar("transaction_id", { length: 64 }).notNull(),
    intent: mysqlEnum("intent", DesktopAuthIntent).notNull(),
    state_hash: varchar("state_hash", { length: 128 }).notNull(),
    code_challenge: varchar("code_challenge", { length: 255 }).notNull(),
    code_challenge_method: varchar("code_challenge_method", { length: 16 }).notNull(),
    redirect_uri: varchar("redirect_uri", { length: 512 }).notNull(),
    status: mysqlEnum("status", DesktopAuthTransactionStatus).notNull(),
    user_id: varchar("user_id", { length: 64 }),
    org_id: varchar("org_id", { length: 64 }),
    browser_ip: text("browser_ip"),
    browser_user_agent: text("browser_user_agent"),
    authorization_code_hash: varchar("authorization_code_hash", { length: 128 }),
    manual_code_hash: varchar("manual_code_hash", { length: 128 }),
    code_issued_at: timestamp("code_issued_at", { fsp: 3 }),
    exchanged_at: timestamp("exchanged_at", { fsp: 3 }),
    expires_at: timestamp("expires_at", { fsp: 3 }).notNull(),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("desktop_auth_transaction_transaction_id").on(table.transaction_id),
    index("desktop_auth_transaction_status_expires").on(table.status, table.expires_at),
    index("desktop_auth_transaction_authorization_code_hash").on(table.authorization_code_hash),
    index("desktop_auth_transaction_manual_code_hash").on(table.manual_code_hash),
  ],
)

export const FeedbackReportTable = mysqlTable(
  "feedback_report",
  {
    id: id().primaryKey(),
    type: mysqlEnum("type", FeedbackType).notNull().default("bug"),
    status: mysqlEnum("status", FeedbackStatus).notNull().default("pending"),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description").notNull(),
    user_id: varchar("user_id", { length: 64 }).notNull(),
    user_email: varchar("user_email", { length: 255 }),
    org_id: varchar("org_id", { length: 64 }).notNull(),
    context: json("context"),
    view: varchar("view", { length: 64 }).notNull(),
    pathname: varchar("pathname", { length: 1024 }),
    dashboard_tab: varchar("dashboard_tab", { length: 64 }),
    settings_tab: varchar("settings_tab", { length: 64 }),
    session_id: varchar("session_id", { length: 64 }),
    workspace_id: varchar("workspace_id", { length: 64 }),
    veslo_server_workspace_id: varchar("veslo_server_workspace_id", { length: 64 }),
    workspace_type: varchar("workspace_type", { length: 64 }),
    workspace_path: varchar("workspace_path", { length: 1024 }),
    worker_id: varchar("worker_id", { length: 64 }),
    run_id: varchar("run_id", { length: 64 }),
    app_version: varchar("app_version", { length: 64 }),
    locale: varchar("locale", { length: 64 }),
    platform: varchar("platform", { length: 64 }),
    os_family: varchar("os_family", { length: 64 }),
    submitted_at: timestamp("submitted_at", { fsp: 3 }).notNull().defaultNow(),
    screenshot_status: mysqlEnum("screenshot_status", FeedbackScreenshotStatus).notNull(),
    screenshot_mime_type: varchar("screenshot_mime_type", { length: 255 }),
    screenshot_bytes: int("screenshot_bytes", { unsigned: true }),
    screenshot_data: longtext("screenshot_data"),
    youtrack_issue_id: varchar("youtrack_issue_id", { length: 255 }),
    youtrack_issue_url: varchar("youtrack_issue_url", { length: 2048 }),
    last_projector_error: text("last_projector_error"),
    next_projector_attempt_at: timestamp("next_projector_attempt_at", { fsp: 3 }),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("feedback_report_org_id").on(table.org_id),
    index("feedback_report_user_id").on(table.user_id),
    index("feedback_report_status").on(table.status),
    index("feedback_report_next_projector_attempt_at").on(table.next_projector_attempt_at),
  ],
)

export const FeedbackProjectorAttemptTable = mysqlTable(
  "feedback_projector_attempt",
  {
    id: id().primaryKey(),
    feedback_id: varchar("feedback_id", { length: 64 }).notNull(),
    attempt_no: int("attempt_no", { unsigned: true }).notNull(),
    status: mysqlEnum("status", FeedbackProjectorAttemptStatus).notNull(),
    error_message: text("error_message"),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [index("feedback_projector_attempt_feedback_id").on(table.feedback_id)],
)

export const DebugLogBatchTable = mysqlTable(
  "debug_log_batch",
  {
    id: id().primaryKey(),
    batch_id: varchar("batch_id", { length: 128 }).notNull(),
    idempotency_key: varchar("idempotency_key", { length: 255 }).notNull(),
    event_count: int("event_count", { unsigned: true }).notNull(),
    expires_at: timestamp("expires_at", { fsp: 3 }).notNull(),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("debug_log_batch_batch_id").on(table.batch_id),
    uniqueIndex("debug_log_batch_idempotency_key").on(table.idempotency_key),
    index("debug_log_batch_expires_at").on(table.expires_at),
  ],
)

export const DebugLogEventTable = mysqlTable(
  "debug_log_event",
  {
    id: id().primaryKey(),
    batch_id: varchar("batch_id", { length: 128 }).notNull(),
    event_id: varchar("event_id", { length: 128 }).notNull(),
    user_id: varchar("user_id", { length: 128 }).notNull(),
    org_id: varchar("org_id", { length: 128 }).notNull(),
    workspace_id: varchar("workspace_id", { length: 128 }).notNull(),
    worker_id: varchar("worker_id", { length: 128 }),
    session_id: varchar("session_id", { length: 128 }),
    run_id: varchar("run_id", { length: 128 }),
    source: varchar("source", { length: 64 }).notNull(),
    stream: varchar("stream", { length: 32 }).notNull(),
    level: varchar("level", { length: 16 }),
    event_timestamp: timestamp("event_timestamp", { fsp: 3 }).notNull(),
    sequence_no: int("sequence_no", { unsigned: true }).notNull(),
    payload_sha256: varchar("payload_sha256", { length: 64 }).notNull(),
    payload_bytes: int("payload_bytes", { unsigned: true }).notNull(),
    encryption_key_version: varchar("encryption_key_version", { length: 128 }).notNull(),
    payload_ciphertext: longtext("payload_ciphertext").notNull(),
    payload_iv: text("payload_iv").notNull(),
    payload_auth_tag: text("payload_auth_tag").notNull(),
    expires_at: timestamp("expires_at", { fsp: 3 }).notNull(),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("debug_log_event_batch_event").on(table.batch_id, table.event_id),
    index("debug_log_event_user_time").on(table.user_id, table.event_timestamp),
    index("debug_log_event_org_time").on(table.org_id, table.event_timestamp),
    index("debug_log_event_workspace_time").on(table.workspace_id, table.event_timestamp),
    index("debug_log_event_session_time").on(table.session_id, table.event_timestamp),
    index("debug_log_event_run_time").on(table.run_id, table.event_timestamp),
    index("debug_log_event_expires_at").on(table.expires_at),
  ],
)

export const AuditEventTable = mysqlTable(
  "audit_event",
  {
    id: id().primaryKey(),
    org_id: varchar("org_id", { length: 64 }).notNull(),
    worker_id: varchar("worker_id", { length: 64 }),
    actor_user_id: varchar("actor_user_id", { length: 64 }).notNull(),
    action: varchar("action", { length: 128 }).notNull(),
    payload: json("payload"),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [index("audit_event_org_id").on(table.org_id), index("audit_event_worker_id").on(table.worker_id)],
)

export const GoogleWorkspaceConnectionTable = mysqlTable(
  "google_workspace_connection",
  {
    id: id().primaryKey(),
    org_id: varchar("org_id", { length: 64 }).notNull(),
    user_id: varchar("user_id", { length: 64 }).notNull(),
    connector_id: mysqlEnum("connector_id", GoogleWorkspaceConnector).notNull(),
    state: mysqlEnum("state", GoogleWorkspaceConnectionState).notNull(),
    scopes: text("scopes").notNull(),
    access_token_expires_at: timestamp("access_token_expires_at", { fsp: 3 }),
    grant_iv: text("grant_iv").notNull(),
    grant_auth_tag: text("grant_auth_tag").notNull(),
    grant_ciphertext: longtext("grant_ciphertext").notNull(),
    connected_at: timestamp("connected_at", { fsp: 3 }).notNull().defaultNow(),
    revoked_at: timestamp("revoked_at", { fsp: 3 }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("google_workspace_connection_scope").on(table.org_id, table.user_id, table.connector_id),
    index("google_workspace_connection_org_user").on(table.org_id, table.user_id),
    index("google_workspace_connection_state").on(table.state),
  ],
)

export * from "../skills/schema.js"
