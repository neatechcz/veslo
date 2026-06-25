import "dotenv/config"
import cors from "cors"
import express from "express"
import path from "node:path"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { fromNodeHeaders, toNodeHandler } from "better-auth/node"
import { sql } from "drizzle-orm"
import { auth, createAuthNodeHandler, guardEmailSignupRequest } from "./auth.js"
import { db } from "./db/index.js"
import { AdminUserStateTable, AuthUserTable, PlatformRoleTable } from "./db/schema.js"
import { createDbDebugLogStore, createDebugLogService } from "./debug-logs/repository.js"
import { extractMetadataRows, shouldWidenVarcharColumn } from "./db/schema-reconcile.js"
import { isAdminAlertEmailConfigured, sendAdminAlertEmail } from "./email/admin-alert-mailer.js"
import { env } from "./env.js"
import { createDbFeedbackProjectorStore, createFeedbackProjector } from "./feedback/projector.js"
import { createDebugLogsIngestRouter } from "./http/debug-logs.js"
import { createDesktopDiagnosticsRouter } from "./http/desktop-diagnostics.js"
import { createInternalPlatformAdminRecipientsRouter } from "./http/internal-platform-admin-recipients.js"
import { asyncRoute, errorMiddleware } from "./http/errors.js"
import { requireSession } from "./http/session.js"
import { desktopAuthRouter } from "./http/desktop-auth.js"
import { desktopAuthV2Router } from "./http/desktop-auth-v2.js"
import {
  createAdminRuntimeRouter,
  isBootstrapPlatformAdminEmail,
  listActivePlatformAdminRecipients,
  requirePlatformAdminSnapshot,
} from "./http/admin-runtime.js"
import { createFeedbackRouter } from "./http/feedback.js"
import { createManagedAiAdminUiRouter } from "./managed-ai/http/admin.js"
import {
  DefaultOpenAiOAuthClient,
  createUnavailableOpenAiOAuthClient,
} from "./managed-ai/credentials/openai-oauth.js"
import {
  DefaultGoogleWorkspaceOAuthClient,
  createUnavailableGoogleWorkspaceOAuthClient,
} from "./google-workspace/oauth.js"
import {
  DbGoogleWorkspaceConnectionStore,
  UnavailableGoogleWorkspaceConnectionStore,
} from "./google-workspace/store.js"
import { createProxyRouter } from "./managed-ai/http/proxy.js"
import { createUserCredentialsRouter } from "./managed-ai/http/user-credentials.js"
import { createDbSkillRegistryStore } from "./skills/db-store.js"
import { ensureCorePlatformSkills } from "./skills/core-platform-skill-bootstrap.js"
import { createSkillRegistryRouter } from "./skills/routes.js"
import { SkillRegistryTables } from "./skills/schema.js"
import {
  createDefaultProxyDependencies,
  createDefaultRuntimeState,
  createDefaultUserCredentialDependencies,
  type RuntimeState,
} from "./managed-ai/runtime/default-runtime.js"
import { createCodexCapacityAlertMonitorRunner } from "./managed-ai/alerts/codex-capacity-monitor.js"
import { buildCodexCapacityOverview } from "./managed-ai/usage/codex-capacity.js"
import { orgsRouter } from "./http/orgs.js"
import { createOrgMcpCatalogRouter } from "./http/org-mcp-catalog.js"
import { orgSkillsCatalogRouter } from "./http/org-skills-catalog.js"
import { createGoogleWorkspaceRouter } from "./http/google-workspace.js"
import { workersRouter } from "./http/workers.js"
import { createYouTrackRestIssueClient } from "./integrations/youtrack-rest.js"

const app = express()
const MANAGED_AI_PROXY_JSON_LIMIT = "10mb"
const FEEDBACK_PROJECTOR_DUE_RETRY_INTERVAL_MS = 60_000
const DEBUG_LOG_RETENTION_INTERVAL_MS = 86_400_000
const MANAGED_AI_CODEX_CAPACITY_ALERT_INTERVAL_MS = 5 * 60_000
const SKILL_REGISTRY_SCHEMA_MIGRATIONS = [
  "0013_skill_registry.sql",
  "0014_skill_rollout_policies.sql",
] as const
const managedAiRuntime = env.managedAi.enabled ? createDefaultRuntimeState() : null
const managedAiProxyJsonParser = express.json({ limit: MANAGED_AI_PROXY_JSON_LIMIT })
const currentFile = fileURLToPath(import.meta.url)
const denRoot = path.resolve(path.dirname(currentFile), "..")
const publicDir = path.resolve(denRoot, "public")
const publicAdminDir = path.resolve(denRoot, "public-admin")
const feedbackProjector = createFeedbackProjector({
  projectKey: env.youtrack.projectKey,
  store: createDbFeedbackProjectorStore(db),
  issueClient: createYouTrackRestIssueClient({
    baseUrl: env.youtrack.baseUrl,
    token: env.youtrack.token,
    timeoutMs: env.youtrack.timeoutMs,
  }),
})
const feedbackRouter = createFeedbackRouter({
  projector: feedbackProjector,
})
const skillRegistryStore = createDbSkillRegistryStore(db)
const debugLogStore = createDbDebugLogStore(db)
const debugLogService = env.debugLogs.masterKey && env.debugLogs.masterKeyVersion
  ? createDebugLogService({
    store: debugLogStore,
    masterKey: env.debugLogs.masterKey,
    masterKeyVersion: env.debugLogs.masterKeyVersion,
    retentionDays: env.debugLogs.retentionDays,
  })
  : null
const debugLogsIngestRouter = createDebugLogsIngestRouter({
  ingestToken: env.debugLogs.ingestToken,
  service: debugLogService,
})
const desktopCorsOrigins = ["tauri://localhost", "http://localhost:1420", "http://localhost:1421"] as const
const corsOrigins =
  env.corsOrigins.length > 0
    ? Array.from(new Set([...env.corsOrigins, ...desktopCorsOrigins]))
    : []

if (corsOrigins.length > 0) {
  app.use(
    cors({
      origin: corsOrigins,
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE"],
    }),
  )
}

// Better Auth reads the raw request body itself — mount BEFORE express.json()
// so the body stream isn't consumed by Express's JSON parser first
app.all("/api/auth/*", createAuthNodeHandler(toNodeHandler(auth), guardEmailSignupRequest))
app.use("/v1", feedbackRouter)
app.use("/v1/internal", debugLogsIngestRouter)
app.use("/v1", createDesktopDiagnosticsRouter({ service: debugLogService }))
app.use("/v1/internal", createInternalPlatformAdminRecipientsRouter({
  token: env.aiGatewayInternalToken,
  listRecipients: listActivePlatformAdminRecipients,
}))
if (managedAiRuntime) {
  app.use("/providers", managedAiProxyJsonParser)
}
app.use(express.json())

function handleRootRequest(req: express.Request, res: express.Response) {
  if (req.query.desktopOnboarding === "1") {
    res.sendFile(path.join(publicDir, "index.html"))
    return
  }

  res.json({ ok: true, service: "veslo-den" })
}

function sendNoStoreFile(res: express.Response, filePath: string) {
  res.setHeader("Cache-Control", "no-store")
  res.sendFile(filePath)
}

app.get("/", handleRootRequest)
app.get("/index.html", handleRootRequest)
app.use(express.static(publicDir, { index: false }))
app.get("/admin/app.js", (_, res) => {
  sendNoStoreFile(res, path.join(publicAdminDir, "app.js"))
})
app.get("/admin/app.css", (_, res) => {
  sendNoStoreFile(res, path.join(publicAdminDir, "app.css"))
})
app.get(/^\/admin(?:\/(?!api(?:\/|$)).*)?$/, (_, res) => {
  sendNoStoreFile(res, path.join(publicAdminDir, "index.html"))
})
app.use("/v1", createSkillRegistryRouter({ store: skillRegistryStore }))

if (managedAiRuntime) {
  app.use(
    createManagedAiAdminUiRouter({
      getAdminSession: requirePlatformAdminSnapshot,
      openAiOAuth: createOpenAiOAuthClient(),
      alerts: managedAiRuntime.alerts,
      audit: managedAiRuntime.audit,
      credentials: managedAiRuntime.credentials,
      secrets: managedAiRuntime.secrets,
    }),
  )
  app.use(createUserCredentialsRouter(createDefaultUserCredentialDependencies(managedAiRuntime)))
  app.use(createProxyRouter(createDefaultProxyDependencies(managedAiRuntime)))
}

app.get("/health", (_, res) => {
  res.json({ ok: true })
})


app.get("/v1/me", asyncRoute(async (req, res) => {
  const checkedSession = await requireSession(req, res)
  if (!checkedSession) {
    return
  }

  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  })
  if (!session?.user?.id) {
    res.status(401).json({ error: "unauthorized" })
    return
  }
  res.json(session)
}))

app.use("/v1/desktop-auth", desktopAuthRouter)
app.use("/v2/desktop-auth", desktopAuthV2Router)
app.use("/v1/admin", createAdminRuntimeRouter({ managedAi: managedAiRuntime, debugLogs: debugLogService }))
app.use("/admin/api", createAdminRuntimeRouter({ managedAi: managedAiRuntime, debugLogs: debugLogService }))
app.use("/v1/orgs", orgsRouter)
app.use("/v1/orgs", createOrgMcpCatalogRouter({
  connectorBaseUrl: env.googleWorkspace.connectorBaseUrl,
}))
app.use("/v1/orgs", orgSkillsCatalogRouter)
app.use("/v1", createGoogleWorkspaceRouter({
  oauth: createGoogleWorkspaceOAuthClient(),
  store: createGoogleWorkspaceConnectionStore(),
  stateSecret: env.googleWorkspace.oauthStateSecret,
  redirectUri: env.googleWorkspace.oauthRedirectUri,
  successRedirectUrl: env.googleWorkspace.oauthSuccessRedirectUrl,
}))
app.use("/v1/workers", workersRouter)
app.use(errorMiddleware)

function createOpenAiOAuthClient() {
  const config = env.managedAi.openAi
  if (!config.clientId || !config.clientSecret || !config.redirectBase) {
    return createUnavailableOpenAiOAuthClient()
  }

  return new DefaultOpenAiOAuthClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectBase: config.redirectBase,
  })
}

function createGoogleWorkspaceOAuthClient() {
  const config = env.googleWorkspace
  if (!config.oauthClientId || !config.oauthClientSecret) {
    return createUnavailableGoogleWorkspaceOAuthClient()
  }

  return new DefaultGoogleWorkspaceOAuthClient({
    clientId: config.oauthClientId,
    clientSecret: config.oauthClientSecret,
  })
}

function createGoogleWorkspaceConnectionStore() {
  const config = env.googleWorkspace
  if (!config.tokenSecretKey) {
    return new UnavailableGoogleWorkspaceConnectionStore()
  }

  return new DbGoogleWorkspaceConnectionStore({
    db,
    secretKey: config.tokenSecretKey,
  })
}

function unrefTimer(handle: unknown) {
  if (!handle || typeof handle !== "object") {
    return
  }
  const unref = (handle as { unref?: unknown }).unref
  if (typeof unref === "function") {
    unref.call(handle)
  }
}

function startFeedbackProjectorDueRetryLoop(projector: Pick<ReturnType<typeof createFeedbackProjector>, "processDueRetries">) {
  const runDueRetries = () => {
    void projector.processDueRetries().catch((error) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error)
      console.error(`[den] feedback projector due retry sweep failed: ${message}`)
    })
  }

  runDueRetries()
  const interval = setInterval(runDueRetries, FEEDBACK_PROJECTOR_DUE_RETRY_INTERVAL_MS)
  unrefTimer(interval)
}

function startDebugLogRetentionLoop(service: typeof debugLogService) {
  if (!service) {
    return
  }

  const runPurge = () => {
    void service.purgeExpired().catch((error) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error)
      console.error(`[den] debug log retention purge failed: ${message}`)
    })
  }

  runPurge()
  const interval = setInterval(runPurge, DEBUG_LOG_RETENTION_INTERVAL_MS)
  unrefTimer(interval)
}

async function listPlatformAdminAlertRecipients(): Promise<string[]> {
  const [users, platformRoles, userStates] = await Promise.all([
    db
      .select({
        id: AuthUserTable.id,
        email: AuthUserTable.email,
      })
      .from(AuthUserTable),
    db
      .select({
        userId: PlatformRoleTable.user_id,
      })
      .from(PlatformRoleTable),
    db
      .select({
        userId: AdminUserStateTable.user_id,
        disabled: AdminUserStateTable.disabled,
      })
      .from(AdminUserStateTable),
  ])

  const platformAdminIds = new Set(platformRoles.map((entry) => entry.userId))
  const disabledUserIds = new Set(userStates.filter((entry) => entry.disabled === true).map((entry) => entry.userId))
  return users
    .filter((user) => !disabledUserIds.has(user.id))
    .filter((user) => platformAdminIds.has(user.id) || isBootstrapPlatformAdminEmail(user.email))
    .map((user) => user.email.trim().toLowerCase())
    .filter(Boolean)
}

async function loadManagedAiCodexCapacityOverview(runtime: RuntimeState) {
  const listAdminCredentials = runtime.credentials.listAdminCredentials
  if (!listAdminCredentials) {
    return buildCodexCapacityOverview([])
  }

  const credentials = await listAdminCredentials.call(runtime.credentials)
  const capacityCredentials = await Promise.all(
    credentials
      .filter((credential) => credential.provider === "codex_oauth")
      .map(async (credential) => ({
        id: credential.id,
        name: credential.name,
        state: credential.state,
        upstreamStatus: await runtime.codexStatusProvider.getStatus({
          credentialId: credential.id,
          credentialName: credential.name,
        }).catch(() => null),
      })),
  )
  return buildCodexCapacityOverview(capacityCredentials)
}

function startManagedAiCodexCapacityAlertLoop(runtime: RuntimeState) {
  if (!isAdminAlertEmailConfigured()) {
    console.warn("[den] managed-ai Codex capacity alert emails disabled: Lettr email env is not configured")
    return
  }

  const runMonitor = createCodexCapacityAlertMonitorRunner({
    loadCapacityOverview: () => loadManagedAiCodexCapacityOverview(runtime),
    listAdminRecipients: listPlatformAdminAlertRecipients,
    sendEmail: sendAdminAlertEmail,
    audit: runtime.audit,
  })
  const runMonitorBestEffort = () => {
    void runMonitor().catch((error) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error)
      console.error(`[den] managed-ai Codex capacity alert monitor failed: ${message}`)
    })
  }

  runMonitorBestEffort()
  const interval = setInterval(runMonitorBestEffort, MANAGED_AI_CODEX_CAPACITY_ALERT_INTERVAL_MS)
  unrefTimer(interval)
}

const identifierPattern = /^[a-zA-Z0-9_]+$/

function quoteIdentifier(value: string) {
  if (!identifierPattern.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`)
  }
  return `\`${value}\``
}

function readRowValueCaseInsensitive(row: Record<string, unknown>, key: string) {
  const lowered = key.toLowerCase()
  for (const [rowKey, rowValue] of Object.entries(row)) {
    if (rowKey.toLowerCase() === lowered) {
      return rowValue
    }
  }
  return undefined
}

function toNullableNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

async function ensureIndex(table: string, indexName: string, columns: string[], unique = false) {
  const existing = await db.execute(sql`
    SELECT 1
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ${table}
      AND INDEX_NAME = ${indexName}
    LIMIT 1
  `)

  if (extractMetadataRows(existing).length > 0) {
    return
  }

  const columnList = columns.map((column) => quoteIdentifier(column)).join(", ")
  const createKeyword = unique ? "CREATE UNIQUE INDEX" : "CREATE INDEX"
  await db.execute(
    sql.raw(`${createKeyword} ${quoteIdentifier(indexName)} ON ${quoteIdentifier(table)} (${columnList})`),
  )
}

async function ensureColumn(table: string, columnName: string, columnDefinition: string) {
  const existing = await db.execute(sql`
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ${table}
      AND COLUMN_NAME = ${columnName}
    LIMIT 1
  `)

  if (extractMetadataRows(existing).length > 0) {
    return
  }

  await db.execute(
    sql.raw(
      `ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(columnName)} ${columnDefinition}`,
    ),
  )
}

async function tableExists(table: string) {
  const existing = await db.execute(sql`
    SELECT 1
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ${table}
    LIMIT 1
  `)
  return extractMetadataRows(existing).length > 0
}

async function ensureSkillRegistryTables() {
  const tableNames = Object.values(SkillRegistryTables)
  const present = new Set<string>()
  for (const tableName of tableNames) {
    if (await tableExists(tableName)) {
      present.add(tableName)
    }
  }

  if (present.size === tableNames.length) {
    return
  }

  if (present.size > 0) {
    const missing = tableNames.filter((tableName) => !present.has(tableName))
    throw new Error(
      `skill registry schema is incomplete; missing tables: ${missing.join(", ")}. Run pnpm --filter @neatech/den db:migrate.`,
    )
  }

  for (const migration of SKILL_REGISTRY_SCHEMA_MIGRATIONS) {
    const migrationPath = path.resolve(denRoot, "drizzle", migration)
    const statements = splitDrizzleMigrationStatements(await readFile(migrationPath, "utf8"))
    for (const statement of statements) {
      await db.execute(sql.raw(statement))
    }
  }
}

function splitDrizzleMigrationStatements(content: string) {
  return content
    .split(/-->\s*statement-breakpoint\s*/g)
    .map((statement) => statement.trim())
    .filter(Boolean)
}

async function ensureVarcharColumnMinimumLength(
  table: string,
  columnName: string,
  minimumLength: number,
  nullable: boolean,
) {
  const metadataResult = await db.execute(sql`
    SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ${table}
      AND COLUMN_NAME = ${columnName}
    LIMIT 1
  `)

  const metadataRow = extractMetadataRows(metadataResult)[0]
  if (!metadataRow) {
    return
  }

  const columnMetadata = {
    dataType: typeof readRowValueCaseInsensitive(metadataRow, "DATA_TYPE") === "string"
      ? String(readRowValueCaseInsensitive(metadataRow, "DATA_TYPE"))
      : null,
    maxLength: toNullableNumber(readRowValueCaseInsensitive(metadataRow, "CHARACTER_MAXIMUM_LENGTH")),
  }

  if (!shouldWidenVarcharColumn(columnMetadata, minimumLength)) {
    return
  }

  const nullableClause = nullable ? "NULL" : "NOT NULL"
  await db.execute(
    sql.raw(
      `ALTER TABLE ${quoteIdentifier(table)} MODIFY COLUMN ${quoteIdentifier(columnName)} varchar(${minimumLength}) ${nullableClause}`,
    ),
  )
}

async function getColumnType(table: string, columnName: string) {
  const metadataResult = await db.execute(sql`
    SELECT COLUMN_TYPE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ${table}
      AND COLUMN_NAME = ${columnName}
    LIMIT 1
  `)

  const metadataRow = extractMetadataRows(metadataResult)[0]
  if (!metadataRow) {
    return null
  }

  const columnType = readRowValueCaseInsensitive(metadataRow, "COLUMN_TYPE")
  return typeof columnType === "string" ? columnType.trim().toLowerCase() : null
}

async function reconcileOrgMembershipRoleColumn() {
  const columnType = await getColumnType("org_membership", "role")
  if (columnType === "enum('member','organization_admin')") {
    return
  }

  await db.execute(
    sql.raw(
      `ALTER TABLE ${quoteIdentifier("org_membership")} MODIFY COLUMN ${quoteIdentifier("role")} enum('owner','member','organization_admin') NOT NULL`,
    ),
  )
  await db.execute(sql`
    UPDATE \`org_membership\`
    SET \`role\` = 'organization_admin'
    WHERE \`role\` = 'owner'
  `)
  await db.execute(
    sql.raw(
      `ALTER TABLE ${quoteIdentifier("org_membership")} MODIFY COLUMN ${quoteIdentifier("role")} enum('member','organization_admin') NOT NULL`,
    ),
  )
}

async function ensureTables() {
  try {
    // Auth tables (Better Auth requires these with snake_case columns)
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`user\` (
        \`id\` varchar(36) NOT NULL,
        \`name\` varchar(255) NOT NULL,
        \`email\` varchar(255) NOT NULL,
        \`email_verified\` boolean NOT NULL DEFAULT false,
        \`image\` text,
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        CONSTRAINT \`user_id\` PRIMARY KEY(\`id\`),
        CONSTRAINT \`user_email\` UNIQUE(\`email\`)
      )
    `)
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`session\` (
        \`id\` varchar(36) NOT NULL,
        \`expires_at\` timestamp(3) NOT NULL,
        \`token\` varchar(255) NOT NULL,
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        \`ip_address\` text,
        \`user_agent\` text,
        \`user_id\` varchar(36) NOT NULL,
        CONSTRAINT \`session_id\` PRIMARY KEY(\`id\`),
        CONSTRAINT \`session_token\` UNIQUE(\`token\`)
      )
    `)
    await ensureIndex("session", "session_user_id", ["user_id"])
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`account\` (
        \`id\` varchar(36) NOT NULL,
        \`account_id\` text NOT NULL,
        \`provider_id\` text NOT NULL,
        \`user_id\` varchar(36) NOT NULL,
        \`access_token\` text,
        \`refresh_token\` text,
        \`id_token\` text,
        \`access_token_expires_at\` timestamp(3),
        \`refresh_token_expires_at\` timestamp(3),
        \`scope\` text,
        \`password\` text,
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        CONSTRAINT \`account_id\` PRIMARY KEY(\`id\`)
      )
    `)
    await ensureIndex("account", "account_user_id", ["user_id"])
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`verification\` (
        \`id\` varchar(36) NOT NULL,
        \`identifier\` varchar(255) NOT NULL,
        \`value\` text NOT NULL,
        \`expires_at\` timestamp(3) NOT NULL,
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        CONSTRAINT \`verification_id\` PRIMARY KEY(\`id\`)
      )
    `)
    await ensureIndex("verification", "verification_identifier", ["identifier"])

    // Detect legacy auth schema (camelCase columns from early migrations) and fail closed.
    try {
      await db.execute(sql`SELECT \`user_id\` FROM \`account\` LIMIT 0`)
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error"
      throw new Error(
        `Detected incompatible Better Auth schema (missing account.user_id). Run 'pnpm --dir services/den db:migrate' before starting DEN. Original error: ${message}`,
      )
    }

    // Application tables
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`org\` (
        \`id\` varchar(64) NOT NULL,
        \`name\` varchar(255) NOT NULL,
        \`slug\` varchar(255) NOT NULL,
        \`owner_user_id\` varchar(64) NOT NULL,
        \`seat_limit\` int unsigned,
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        CONSTRAINT \`org_id\` PRIMARY KEY(\`id\`),
        CONSTRAINT \`org_slug\` UNIQUE(\`slug\`)
      )
    `)

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`org_membership\` (
        \`id\` varchar(64) NOT NULL,
        \`org_id\` varchar(64) NOT NULL,
        \`user_id\` varchar(64) NOT NULL,
        \`role\` enum('member','organization_admin') NOT NULL,
        \`status\` enum('active','disabled','removed') NOT NULL DEFAULT 'active',
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        CONSTRAINT \`org_membership_id\` PRIMARY KEY(\`id\`)
      )
    `)
    await ensureColumn("org", "seat_limit", "int unsigned")
    await ensureColumn("org_membership", "status", "enum('active','disabled','removed') NOT NULL DEFAULT 'active'")
    await reconcileOrgMembershipRoleColumn()

    await ensureIndex("org", "org_owner_user_id", ["owner_user_id"])
    await ensureIndex("org_membership", "org_membership_org_id", ["org_id"])
    await ensureIndex("org_membership", "org_membership_user_id", ["user_id"])
    await ensureIndex("org_membership", "org_membership_org_status", ["org_id", "status"])
    await ensureIndex("org_membership", "org_membership_user_status", ["user_id", "status"])

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`organization_domain\` (
        \`id\` varchar(64) NOT NULL,
        \`org_id\` varchar(64) NOT NULL,
        \`domain\` varchar(255) NOT NULL,
        \`enabled\` boolean NOT NULL DEFAULT true,
        \`self_signup_enabled\` boolean NOT NULL DEFAULT false,
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        CONSTRAINT \`organization_domain_id\` PRIMARY KEY(\`id\`)
      )
    `)
    await ensureIndex("organization_domain", "organization_domain_domain", ["domain"], true)
    await ensureIndex("organization_domain", "organization_domain_org_id", ["org_id"])
    await ensureIndex("organization_domain", "organization_domain_org_enabled", ["org_id", "enabled"])
    await ensureIndex("organization_domain", "organization_domain_self_signup", ["self_signup_enabled"])

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`organization_invite\` (
        \`id\` varchar(64) NOT NULL,
        \`org_id\` varchar(64) NOT NULL,
        \`email\` varchar(255) NOT NULL,
        \`role\` enum('member','organization_admin') NOT NULL DEFAULT 'member',
        \`status\` enum('pending','accepted','expired','revoked') NOT NULL DEFAULT 'pending',
        \`token_hash\` varchar(255) NOT NULL,
        \`invited_by_user_id\` varchar(64) NOT NULL,
        \`accepted_by_user_id\` varchar(64),
        \`expires_at\` timestamp(3),
        \`accepted_at\` timestamp(3),
        \`revoked_at\` timestamp(3),
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        CONSTRAINT \`organization_invite_id\` PRIMARY KEY(\`id\`)
      )
    `)
    await ensureIndex("organization_invite", "organization_invite_token_hash", ["token_hash"], true)
    await ensureIndex("organization_invite", "organization_invite_org_id", ["org_id"])
    await ensureIndex("organization_invite", "organization_invite_org_status", ["org_id", "status"])
    await ensureIndex("organization_invite", "organization_invite_email", ["email"])
    await ensureIndex("organization_invite", "organization_invite_email_status", ["email", "status"])
    await ensureIndex("organization_invite", "organization_invite_invited_by", ["invited_by_user_id"])
    await ensureIndex("organization_invite", "organization_invite_accepted_by", ["accepted_by_user_id"])

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`platform_role\` (
        \`id\` varchar(64) NOT NULL,
        \`user_id\` varchar(64) NOT NULL,
        \`role\` enum('platform_admin') NOT NULL,
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        CONSTRAINT \`platform_role_id\` PRIMARY KEY(\`id\`),
        CONSTRAINT \`platform_role_user_id\` UNIQUE(\`user_id\`)
      )
    `)

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`admin_user_state\` (
        \`id\` varchar(64) NOT NULL,
        \`user_id\` varchar(64) NOT NULL,
        \`disabled\` boolean NOT NULL DEFAULT false,
        \`disabled_at\` timestamp(3),
        \`disabled_by_user_id\` varchar(64),
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        CONSTRAINT \`admin_user_state_id\` PRIMARY KEY(\`id\`),
        CONSTRAINT \`admin_user_state_user_id\` UNIQUE(\`user_id\`)
      )
    `)
    await ensureIndex("admin_user_state", "admin_user_state_disabled", ["disabled"])

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`worker\` (
        \`id\` varchar(64) NOT NULL,
        \`org_id\` varchar(64) NOT NULL,
        \`created_by_user_id\` varchar(64),
        \`name\` varchar(255) NOT NULL,
        \`description\` varchar(1024),
        \`destination\` enum('local','cloud') NOT NULL,
        \`status\` enum('provisioning','healthy','failed','stopped') NOT NULL,
        \`failure_reason\` varchar(2048),
        \`image_version\` varchar(128),
        \`workspace_path\` varchar(1024),
        \`sandbox_backend\` varchar(64),
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        CONSTRAINT \`worker_id\` PRIMARY KEY(\`id\`)
      )
    `)
    await ensureIndex("worker", "worker_org_id", ["org_id"])
    await ensureColumn("worker", "created_by_user_id", "varchar(64)")
    await ensureIndex("worker", "worker_created_by_user_id", ["created_by_user_id"])
    await ensureIndex("worker", "worker_status", ["status"])
    await ensureColumn("worker", "failure_reason", "varchar(2048)")

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`worker_instance\` (
        \`id\` varchar(64) NOT NULL,
        \`worker_id\` varchar(64) NOT NULL,
        \`provider\` varchar(64) NOT NULL,
        \`region\` varchar(64),
        \`url\` varchar(2048) NOT NULL,
        \`status\` enum('provisioning','healthy','failed','stopped') NOT NULL,
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        CONSTRAINT \`worker_instance_id\` PRIMARY KEY(\`id\`)
      )
    `)
    await ensureIndex("worker_instance", "worker_instance_worker_id", ["worker_id"])

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`worker_token\` (
        \`id\` varchar(64) NOT NULL,
        \`worker_id\` varchar(64) NOT NULL,
        \`scope\` enum('client','host') NOT NULL,
        \`token\` varchar(512) NOT NULL,
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        \`revoked_at\` timestamp(3),
        CONSTRAINT \`worker_token_id\` PRIMARY KEY(\`id\`),
        CONSTRAINT \`worker_token_token\` UNIQUE(\`token\`)
      )
    `)
    await ensureIndex("worker_token", "worker_token_worker_id", ["worker_id"])
    await ensureVarcharColumnMinimumLength("worker_token", "token", 512, false)

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`worker_bundle\` (
        \`id\` varchar(64) NOT NULL,
        \`worker_id\` varchar(64) NOT NULL,
        \`storage_url\` varchar(2048) NOT NULL,
        \`status\` varchar(64) NOT NULL,
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        CONSTRAINT \`worker_bundle_id\` PRIMARY KEY(\`id\`)
      )
    `)
    await ensureIndex("worker_bundle", "worker_bundle_worker_id", ["worker_id"])

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`audit_event\` (
        \`id\` varchar(64) NOT NULL,
        \`org_id\` varchar(64) NOT NULL,
        \`worker_id\` varchar(64),
        \`actor_user_id\` varchar(64) NOT NULL,
        \`action\` varchar(128) NOT NULL,
        \`payload\` json,
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        CONSTRAINT \`audit_event_id\` PRIMARY KEY(\`id\`)
      )
    `)
    await ensureIndex("audit_event", "audit_event_org_id", ["org_id"])
    await ensureIndex("audit_event", "audit_event_worker_id", ["worker_id"])

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`google_workspace_connection\` (
        \`id\` varchar(64) NOT NULL,
        \`org_id\` varchar(64) NOT NULL,
        \`user_id\` varchar(64) NOT NULL,
        \`connector_id\` enum('google-gmail','google-calendar','google-drive') NOT NULL,
        \`state\` enum('connected','revoked','error') NOT NULL,
        \`scopes\` text NOT NULL,
        \`access_token_expires_at\` timestamp(3),
        \`grant_iv\` text NOT NULL,
        \`grant_auth_tag\` text NOT NULL,
        \`grant_ciphertext\` longtext NOT NULL,
        \`connected_at\` timestamp(3) NOT NULL DEFAULT (now()),
        \`revoked_at\` timestamp(3),
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        CONSTRAINT \`google_workspace_connection_id\` PRIMARY KEY(\`id\`)
      )
    `)
    await ensureIndex("google_workspace_connection", "google_workspace_connection_scope", ["org_id", "user_id", "connector_id"], true)
    await ensureIndex("google_workspace_connection", "google_workspace_connection_org_user", ["org_id", "user_id"])
    await ensureIndex("google_workspace_connection", "google_workspace_connection_state", ["state"])

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`feedback_report\` (
        \`id\` varchar(64) NOT NULL,
        \`type\` enum('bug') NOT NULL DEFAULT 'bug',
        \`status\` enum('pending','projected','failed') NOT NULL DEFAULT 'pending',
        \`title\` varchar(255) NOT NULL,
        \`description\` text NOT NULL,
        \`user_id\` varchar(64) NOT NULL,
        \`user_email\` varchar(255),
        \`org_id\` varchar(64) NOT NULL,
        \`context\` json,
        \`view\` varchar(64) NOT NULL,
        \`pathname\` varchar(1024),
        \`dashboard_tab\` varchar(64),
        \`settings_tab\` varchar(64),
        \`session_id\` varchar(64),
        \`workspace_id\` varchar(64),
        \`veslo_server_workspace_id\` varchar(64),
        \`workspace_type\` varchar(64),
        \`workspace_path\` varchar(1024),
        \`worker_id\` varchar(64),
        \`run_id\` varchar(64),
        \`app_version\` varchar(64),
        \`locale\` varchar(64),
        \`platform\` varchar(64),
        \`os_family\` varchar(64),
        \`submitted_at\` timestamp(3) NOT NULL DEFAULT (now()),
        \`screenshot_status\` enum('captured','failed') NOT NULL,
        \`screenshot_mime_type\` varchar(255),
        \`screenshot_bytes\` int unsigned,
        \`screenshot_data\` longtext,
        \`youtrack_issue_id\` varchar(255),
        \`youtrack_issue_url\` varchar(2048),
        \`last_projector_error\` text,
        \`next_projector_attempt_at\` timestamp(3),
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        CONSTRAINT \`feedback_report_id\` PRIMARY KEY(\`id\`)
      )
    `)
    await ensureIndex("feedback_report", "feedback_report_org_id", ["org_id"])
    await ensureIndex("feedback_report", "feedback_report_user_id", ["user_id"])
    await ensureIndex("feedback_report", "feedback_report_status", ["status"])
    await ensureIndex(
      "feedback_report",
      "feedback_report_next_projector_attempt_at",
      ["next_projector_attempt_at"],
    )

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`feedback_projector_attempt\` (
        \`id\` varchar(64) NOT NULL,
        \`feedback_id\` varchar(64) NOT NULL,
        \`attempt_no\` int unsigned NOT NULL,
        \`status\` enum('pending','succeeded','failed') NOT NULL,
        \`error_message\` text,
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        CONSTRAINT \`feedback_projector_attempt_id\` PRIMARY KEY(\`id\`)
      )
    `)
    await ensureIndex(
      "feedback_projector_attempt",
      "feedback_projector_attempt_feedback_id",
      ["feedback_id"],
    )

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`debug_log_batch\` (
        \`id\` varchar(64) NOT NULL,
        \`batch_id\` varchar(128) NOT NULL,
        \`idempotency_key\` varchar(255) NOT NULL,
        \`event_count\` int unsigned NOT NULL,
        \`expires_at\` timestamp(3) NOT NULL,
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        CONSTRAINT \`debug_log_batch_id\` PRIMARY KEY(\`id\`)
      )
    `)
    await ensureIndex("debug_log_batch", "debug_log_batch_batch_id", ["batch_id"], true)
    await ensureIndex("debug_log_batch", "debug_log_batch_idempotency_key", ["idempotency_key"], true)
    await ensureIndex("debug_log_batch", "debug_log_batch_expires_at", ["expires_at"])

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`debug_log_event\` (
        \`id\` varchar(64) NOT NULL,
        \`batch_id\` varchar(128) NOT NULL,
        \`event_id\` varchar(128) NOT NULL,
        \`user_id\` varchar(128) NOT NULL,
        \`org_id\` varchar(128) NOT NULL,
        \`workspace_id\` varchar(128) NOT NULL,
        \`worker_id\` varchar(128),
        \`session_id\` varchar(128),
        \`run_id\` varchar(128),
        \`source\` varchar(64) NOT NULL,
        \`stream\` varchar(32) NOT NULL,
        \`level\` varchar(16),
        \`event_timestamp\` timestamp(3) NOT NULL,
        \`sequence_no\` int unsigned NOT NULL,
        \`payload_sha256\` varchar(64) NOT NULL,
        \`payload_bytes\` int unsigned NOT NULL,
        \`encryption_key_version\` varchar(128) NOT NULL,
        \`payload_ciphertext\` longtext NOT NULL,
        \`payload_iv\` text NOT NULL,
        \`payload_auth_tag\` text NOT NULL,
        \`expires_at\` timestamp(3) NOT NULL,
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        CONSTRAINT \`debug_log_event_id\` PRIMARY KEY(\`id\`)
      )
    `)
    await ensureIndex("debug_log_event", "debug_log_event_batch_event", ["batch_id", "event_id"], true)
    await ensureIndex("debug_log_event", "debug_log_event_user_time", ["user_id", "event_timestamp"])
    await ensureIndex("debug_log_event", "debug_log_event_org_time", ["org_id", "event_timestamp"])
    await ensureIndex("debug_log_event", "debug_log_event_workspace_time", ["workspace_id", "event_timestamp"])
    await ensureIndex("debug_log_event", "debug_log_event_session_time", ["session_id", "event_timestamp"])
    await ensureIndex("debug_log_event", "debug_log_event_run_time", ["run_id", "event_timestamp"])
    await ensureIndex("debug_log_event", "debug_log_event_expires_at", ["expires_at"])

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`desktop_auth_handoff\` (
        \`id\` varchar(64) NOT NULL,
        \`code\` varchar(255) NOT NULL,
        \`session_id\` varchar(64),
        \`user_id\` varchar(64) NOT NULL,
        \`org_id\` varchar(64) NOT NULL,
        \`expires_at\` timestamp(3) NOT NULL,
        \`consumed_at\` timestamp(3),
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        CONSTRAINT \`desktop_auth_handoff_id\` PRIMARY KEY(\`id\`),
        CONSTRAINT \`desktop_auth_handoff_code\` UNIQUE(\`code\`)
      )
    `)
    await ensureColumn("desktop_auth_handoff", "session_id", "varchar(64)")
    await ensureVarcharColumnMinimumLength("desktop_auth_handoff", "id", 64, false)
    await ensureVarcharColumnMinimumLength("desktop_auth_handoff", "code", 255, false)
    await ensureVarcharColumnMinimumLength("desktop_auth_handoff", "session_id", 64, true)
    await ensureVarcharColumnMinimumLength("desktop_auth_handoff", "user_id", 64, false)
    await ensureVarcharColumnMinimumLength("desktop_auth_handoff", "org_id", 64, false)
    await ensureIndex("desktop_auth_handoff", "desktop_auth_handoff_user_id", ["user_id"])
    await ensureIndex("desktop_auth_handoff", "desktop_auth_handoff_session_id", ["session_id"])

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`desktop_auth_session\` (
        \`id\` varchar(64) NOT NULL,
        \`intent\` enum('signin','signup') NOT NULL,
        \`state_hash\` varchar(128) NOT NULL,
        \`code_challenge\` varchar(255) NOT NULL,
        \`code_challenge_method\` varchar(16) NOT NULL,
        \`redirect_uri\` varchar(512) NOT NULL,
        \`status\` enum('started','browser_authed','exchanged','expired','cancelled') NOT NULL,
        \`user_id\` varchar(64),
        \`org_id\` varchar(64),
        \`browser_ip\` text,
        \`browser_user_agent\` text,
        \`expires_at\` timestamp(3) NOT NULL,
        \`exchanged_at\` timestamp(3),
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        CONSTRAINT \`desktop_auth_session_id\` PRIMARY KEY(\`id\`)
      )
    `)
    await ensureIndex("desktop_auth_session", "desktop_auth_session_status_expires", ["status", "expires_at"])
    await ensureIndex("desktop_auth_session", "desktop_auth_session_user_id", ["user_id"])

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`desktop_auth_transaction\` (
        \`id\` varchar(64) NOT NULL,
        \`transaction_id\` varchar(64) NOT NULL,
        \`intent\` enum('signin','signup') NOT NULL,
        \`state_hash\` varchar(128) NOT NULL,
        \`code_challenge\` varchar(255) NOT NULL,
        \`code_challenge_method\` varchar(16) NOT NULL,
        \`redirect_uri\` varchar(512) NOT NULL,
        \`status\` enum('started','browser_authed','exchanged','expired','cancelled') NOT NULL,
        \`user_id\` varchar(64),
        \`org_id\` varchar(64),
        \`browser_ip\` text,
        \`browser_user_agent\` text,
        \`authorization_code_hash\` varchar(128),
        \`manual_code_hash\` varchar(128),
        \`code_issued_at\` timestamp(3),
        \`exchanged_at\` timestamp(3),
        \`expires_at\` timestamp(3) NOT NULL,
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        CONSTRAINT \`desktop_auth_transaction_id\` PRIMARY KEY(\`id\`),
        CONSTRAINT \`desktop_auth_transaction_transaction_id\` UNIQUE(\`transaction_id\`)
      )
    `)
    await ensureColumn("desktop_auth_transaction", "browser_ip", "text")
    await ensureColumn("desktop_auth_transaction", "browser_user_agent", "text")
    await ensureColumn("desktop_auth_transaction", "authorization_code_hash", "varchar(128)")
    await ensureColumn("desktop_auth_transaction", "manual_code_hash", "varchar(128)")
    await ensureColumn("desktop_auth_transaction", "code_issued_at", "timestamp(3)")
    await ensureColumn("desktop_auth_transaction", "exchanged_at", "timestamp(3)")
    await ensureColumn(
      "desktop_auth_transaction",
      "updated_at",
      "timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)",
    )
    await ensureIndex(
      "desktop_auth_transaction",
      "desktop_auth_transaction_transaction_id",
      ["transaction_id"],
      true,
    )
    await ensureIndex(
      "desktop_auth_transaction",
      "desktop_auth_transaction_status_expires",
      ["status", "expires_at"],
    )
    await ensureIndex(
      "desktop_auth_transaction",
      "desktop_auth_transaction_authorization_code_hash",
      ["authorization_code_hash"],
    )
    await ensureIndex("desktop_auth_transaction", "desktop_auth_transaction_manual_code_hash", ["manual_code_hash"])
    await ensureSkillRegistryTables()

    console.log("[den] all tables ensured")
  } catch (err) {
    console.error("[den] table ensure failed:", err)
    throw err
  }
}

async function bootstrap() {
  await ensureTables()
  await ensureCorePlatformSkills(skillRegistryStore)
  startFeedbackProjectorDueRetryLoop(feedbackProjector)
  startDebugLogRetentionLoop(debugLogService)
  if (env.managedAi.enabled) {
    console.log("[den] managed-ai runtime enabled")
    if (managedAiRuntime) {
      startManagedAiCodexCapacityAlertLoop(managedAiRuntime)
    }
  }
  app.listen(env.port, () => {
    console.log(`den listening on ${env.port} (provisioner=${env.provisionerMode})`)
  })
}

void bootstrap().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(`[den] bootstrap failed: ${message}`)
  process.exit(1)
})
