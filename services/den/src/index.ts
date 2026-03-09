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

app.get("/v1/debug/tables", asyncRoute(async (_req, res) => {
  const results: Record<string, unknown> = {}
  try {
    const [tables] = await db.execute(sql`SHOW TABLES`)
    results.tables = tables

    const [accountCols] = await db.execute(sql`SHOW COLUMNS FROM \`account\``)
    results.accountColumns = accountCols

    const [userCols] = await db.execute(sql`SHOW COLUMNS FROM \`user\``)
    results.userColumns = userCols

    const [orgCols] = await db.execute(sql`SHOW COLUMNS FROM \`org\``)
    results.orgColumns = orgCols

    const [orgMemCols] = await db.execute(sql`SHOW COLUMNS FROM \`org_membership\``)
    results.orgMembershipColumns = orgMemCols

    // Test: try what sign-up does step by step
    const testResults: string[] = []
    try {
      await db.execute(sql`SELECT * FROM \`user\` WHERE \`email\` = 'debug-probe@test' LIMIT 1`)
      testResults.push("user SELECT: OK")
    } catch (e: any) { testResults.push(`user SELECT: FAIL - ${e.message}`) }

    try {
      await db.execute(sql`SELECT \`user_id\` FROM \`account\` LIMIT 0`)
      testResults.push("account user_id: OK")
    } catch (e: any) { testResults.push(`account user_id: FAIL - ${e.message}`) }

    try {
      await db.execute(sql`SELECT \`user_id\` FROM \`session\` LIMIT 0`)
      testResults.push("session user_id: OK")
    } catch (e: any) { testResults.push(`session user_id: FAIL - ${e.message}`) }

    try {
      await db.execute(sql`SELECT \`user_id\`, \`org_id\` FROM \`org_membership\` LIMIT 0`)
      testResults.push("org_membership: OK")
    } catch (e: any) { testResults.push(`org_membership: FAIL - ${e.message}`) }

    results.testResults = testResults

    // Test sign-up via Better Auth internal API
    try {
      const testEmail = `debug-${Date.now()}@test.com`
      const signupResult = await auth.api.signUpEmail({
        body: {
          name: "Debug Test",
          email: testEmail,
          password: "TestPass123!",
        },
      })
      results.signupTest = { success: true, userId: signupResult?.user?.id, email: testEmail }
      // Clean up test user
      try {
        await db.execute(sql`DELETE FROM \`org_membership\` WHERE \`user_id\` = ${signupResult?.user?.id}`)
        await db.execute(sql`DELETE FROM \`org\` WHERE \`owner_user_id\` = ${signupResult?.user?.id}`)
        await db.execute(sql`DELETE FROM \`session\` WHERE \`user_id\` = ${signupResult?.user?.id}`)
        await db.execute(sql`DELETE FROM \`account\` WHERE \`user_id\` = ${signupResult?.user?.id}`)
        await db.execute(sql`DELETE FROM \`user\` WHERE \`id\` = ${signupResult?.user?.id}`)
      } catch (cleanupErr: any) {
        results.cleanupError = cleanupErr.message
      }
    } catch (signupErr: any) {
      results.signupTest = {
        success: false,
        error: signupErr.message,
        stack: signupErr.stack?.split("\n").slice(0, 10),
        code: signupErr.code,
        cause: signupErr.cause?.message,
      }
    }
  } catch (e: any) {
    results.error = e.message
  }
  res.json(results)
}))

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

    // Check if auth tables have wrong column names (camelCase from migration 0000)
    let needsAuthFix = false
    try {
      await db.execute(sql`SELECT \`user_id\` FROM \`account\` LIMIT 0`)
    } catch {
      needsAuthFix = true
    }
    if (needsAuthFix) {
      console.log("[den] auth tables have camelCase columns, recreating with snake_case...")
      await db.execute(sql`DROP TABLE IF EXISTS \`account\``)
      await db.execute(sql`DROP TABLE IF EXISTS \`session\``)
      await db.execute(sql`DROP TABLE IF EXISTS \`verification\``)
      await db.execute(sql`DROP TABLE IF EXISTS \`user\``)
      await db.execute(sql`
        CREATE TABLE \`user\` (
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
        CREATE TABLE \`session\` (
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
      await db.execute(sql`CREATE INDEX \`session_user_id\` ON \`session\` (\`user_id\`)`)
      await db.execute(sql`
        CREATE TABLE \`account\` (
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
      await db.execute(sql`CREATE INDEX \`account_user_id\` ON \`account\` (\`user_id\`)`)
      await db.execute(sql`
        CREATE TABLE \`verification\` (
          \`id\` varchar(36) NOT NULL,
          \`identifier\` varchar(255) NOT NULL,
          \`value\` text NOT NULL,
          \`expires_at\` timestamp(3) NOT NULL,
          \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
          \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          CONSTRAINT \`verification_id\` PRIMARY KEY(\`id\`)
        )
      `)
      await db.execute(sql`CREATE INDEX \`verification_identifier\` ON \`verification\` (\`identifier\`)`)
      console.log("[den] auth tables recreated with correct column names")
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
        \`token\` varchar(128) NOT NULL,
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
    console.warn("[den] table ensure warning:", err)
  }
}

ensureTables().then(() => {
  app.listen(env.port, () => {
    console.log(`den listening on ${env.port} (provisioner=${env.provisionerMode})`)
  })
})
