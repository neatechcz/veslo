import "dotenv/config"
import cors from "cors"
import express from "express"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { fromNodeHeaders, toNodeHandler } from "better-auth/node"
import { sql } from "drizzle-orm"
import { auth } from "./auth.js"
import { db } from "./db/index.js"
import { shouldWidenVarcharColumn } from "./db/schema-reconcile.js"
import { env } from "./env.js"
import { asyncRoute, errorMiddleware } from "./http/errors.js"
import { desktopAuthRouter } from "./http/desktop-auth.js"
import { orgsRouter } from "./http/orgs.js"
import { workersRouter } from "./http/workers.js"

const app = express()
const currentFile = fileURLToPath(import.meta.url)
const publicDir = path.resolve(path.dirname(currentFile), "../public")

if (env.corsOrigins.length > 0) {
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE"],
    }),
  )
}

// Better Auth reads the raw request body itself — mount BEFORE express.json()
// so the body stream isn't consumed by Express's JSON parser first
app.all("/api/auth/*", toNodeHandler(auth))
app.use(express.json())
app.use(express.static(publicDir))

app.get("/health", (_, res) => {
  res.json({ ok: true })
})


app.get("/v1/me", asyncRoute(async (req, res) => {
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
app.use("/v1/orgs", orgsRouter)
app.use("/v1/workers", workersRouter)
app.use(errorMiddleware)

const identifierPattern = /^[a-zA-Z0-9_]+$/

function quoteIdentifier(value: string) {
  if (!identifierPattern.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`)
  }
  return `\`${value}\``
}

function extractRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value as Array<Record<string, unknown>>
  }

  if (value && typeof value === "object") {
    const maybeRows = (value as { rows?: unknown }).rows
    if (Array.isArray(maybeRows)) {
      return maybeRows as Array<Record<string, unknown>>
    }
  }

  return []
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

async function ensureIndex(table: string, indexName: string, columns: string[]) {
  const existing = await db.execute(sql`
    SELECT 1
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ${table}
      AND INDEX_NAME = ${indexName}
    LIMIT 1
  `)

  if (extractRows(existing).length > 0) {
    return
  }

  const columnList = columns.map((column) => quoteIdentifier(column)).join(", ")
  await db.execute(
    sql.raw(`CREATE INDEX ${quoteIdentifier(indexName)} ON ${quoteIdentifier(table)} (${columnList})`),
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

  if (extractRows(existing).length > 0) {
    return
  }

  await db.execute(
    sql.raw(
      `ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(columnName)} ${columnDefinition}`,
    ),
  )
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

  const metadataRow = extractRows(metadataResult)[0]
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
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        CONSTRAINT \`org_id\` PRIMARY KEY(\`id\`),
        CONSTRAINT \`org_slug\` UNIQUE(\`slug\`)
      )
    `)
    await ensureIndex("org", "org_owner_user_id", ["owner_user_id"])

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS \`org_membership\` (
        \`id\` varchar(64) NOT NULL,
        \`org_id\` varchar(64) NOT NULL,
        \`user_id\` varchar(64) NOT NULL,
        \`role\` enum('owner','member') NOT NULL,
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        CONSTRAINT \`org_membership_id\` PRIMARY KEY(\`id\`)
      )
    `)
    await ensureIndex("org_membership", "org_membership_org_id", ["org_id"])
    await ensureIndex("org_membership", "org_membership_user_id", ["user_id"])

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
      CREATE TABLE IF NOT EXISTS \`desktop_auth_handoff\` (
        \`id\` varchar(64) NOT NULL,
        \`code\` varchar(255) NOT NULL,
        \`user_id\` varchar(64) NOT NULL,
        \`org_id\` varchar(64) NOT NULL,
        \`expires_at\` timestamp(3) NOT NULL,
        \`consumed_at\` timestamp(3),
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        CONSTRAINT \`desktop_auth_handoff_id\` PRIMARY KEY(\`id\`),
        CONSTRAINT \`desktop_auth_handoff_code\` UNIQUE(\`code\`)
      )
    `)
    await ensureIndex("desktop_auth_handoff", "desktop_auth_handoff_user_id", ["user_id"])

    console.log("[den] all tables ensured")
  } catch (err) {
    console.error("[den] table ensure failed:", err)
    throw err
  }
}

async function bootstrap() {
  await ensureTables()
  app.listen(env.port, () => {
    console.log(`den listening on ${env.port} (provisioner=${env.provisionerMode})`)
  })
}

void bootstrap().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(`[den] bootstrap failed: ${message}`)
  process.exit(1)
})
