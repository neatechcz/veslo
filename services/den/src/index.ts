import "dotenv/config"
import cors from "cors"
import express from "express"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { fromNodeHeaders, toNodeHandler } from "better-auth/node"
import { sql } from "drizzle-orm"
import { auth } from "./auth.js"
import { db } from "./db/index.js"
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
    await db.execute(sql`CREATE INDEX IF NOT EXISTS \`session_user_id\` ON \`session\` (\`user_id\`)`)
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
    await db.execute(sql`CREATE INDEX IF NOT EXISTS \`account_user_id\` ON \`account\` (\`user_id\`)`)
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
    await db.execute(sql`CREATE INDEX IF NOT EXISTS \`verification_identifier\` ON \`verification\` (\`identifier\`)`)

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
    await db.execute(sql`CREATE INDEX IF NOT EXISTS \`org_owner_user_id\` ON \`org\` (\`owner_user_id\`)`)

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
    await db.execute(sql`CREATE INDEX IF NOT EXISTS \`org_membership_org_id\` ON \`org_membership\` (\`org_id\`)`)
    await db.execute(sql`CREATE INDEX IF NOT EXISTS \`org_membership_user_id\` ON \`org_membership\` (\`user_id\`)`)

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
    await db.execute(sql`CREATE INDEX IF NOT EXISTS \`worker_org_id\` ON \`worker\` (\`org_id\`)`)
    await db.execute(sql`CREATE INDEX IF NOT EXISTS \`worker_created_by_user_id\` ON \`worker\` (\`created_by_user_id\`)`)
    await db.execute(sql`CREATE INDEX IF NOT EXISTS \`worker_status\` ON \`worker\` (\`status\`)`)
    await db.execute(sql`ALTER TABLE \`worker\` ADD COLUMN IF NOT EXISTS \`failure_reason\` varchar(2048)`)

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
    await db.execute(sql`CREATE INDEX IF NOT EXISTS \`worker_instance_worker_id\` ON \`worker_instance\` (\`worker_id\`)`)

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
    await db.execute(sql`CREATE INDEX IF NOT EXISTS \`worker_token_worker_id\` ON \`worker_token\` (\`worker_id\`)`)

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
    await db.execute(sql`CREATE INDEX IF NOT EXISTS \`worker_bundle_worker_id\` ON \`worker_bundle\` (\`worker_id\`)`)

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
    await db.execute(sql`CREATE INDEX IF NOT EXISTS \`audit_event_org_id\` ON \`audit_event\` (\`org_id\`)`)
    await db.execute(sql`CREATE INDEX IF NOT EXISTS \`audit_event_worker_id\` ON \`audit_event\` (\`worker_id\`)`)

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
    await db.execute(sql`CREATE INDEX IF NOT EXISTS \`desktop_auth_handoff_user_id\` ON \`desktop_auth_handoff\` (\`user_id\`)`)

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
