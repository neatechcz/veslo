import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

const baseEnv = {
  DATABASE_URL: "mysql://root:root@localhost:3306/veslo_test",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:8788",
}

Object.assign(process.env, baseEnv)

test("den env exposes Google Workspace OAuth configuration", async () => {
  const { parseEnv } = await import("../src/env.js")
  const parsed = parseEnv({
    ...baseEnv,
    GOOGLE_WORKSPACE_OAUTH_CLIENT_ID: "google-client-id",
    GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET: "google-client-secret",
    GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI: "https://api.veslo.work/v1/integrations/google/oauth/callback",
    GOOGLE_WORKSPACE_OAUTH_STATE_SECRET: "state-secret",
    GOOGLE_WORKSPACE_OAUTH_SUCCESS_REDIRECT_URL: "https://app.veslo.work/settings/integrations/google",
    GOOGLE_WORKSPACE_TOKEN_SECRET_KEY: "token-secret-012345678901234567890",
    GOOGLE_WORKSPACE_CONNECTOR_BASE_URL: "https://api.veslo.work/",
  })

  assert.deepEqual(parsed.googleWorkspace, {
    oauthClientId: "google-client-id",
    oauthClientSecret: "google-client-secret",
    oauthRedirectUri: "https://api.veslo.work/v1/integrations/google/oauth/callback",
    oauthStateSecret: "state-secret",
    oauthSuccessRedirectUrl: "https://app.veslo.work/settings/integrations/google",
    tokenSecretKey: "token-secret-012345678901234567890",
    connectorBaseUrl: "https://api.veslo.work",
  })
})

test("den env rejects weak Google Workspace token encryption keys", async () => {
  const { parseEnv } = await import("../src/env.js")

  assert.throws(
    () => parseEnv({
      ...baseEnv,
      GOOGLE_WORKSPACE_TOKEN_SECRET_KEY: "too-short",
    }),
    /GOOGLE_WORKSPACE_TOKEN_SECRET_KEY must be at least 32 characters/,
  )
})

test("owned-server compose passes Google Workspace env into Den", () => {
  const compose = readFileSync(new URL("../../../packaging/owned-server/compose.yml", import.meta.url), "utf8")
  assert.match(compose, /GOOGLE_WORKSPACE_OAUTH_CLIENT_ID/)
  assert.match(compose, /GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET/)
  assert.match(compose, /GOOGLE_WORKSPACE_TOKEN_SECRET_KEY/)
  assert.match(compose, /GOOGLE_WORKSPACE_CONNECTOR_BASE_URL/)
})

test("google workspace schema and migration create encrypted connection storage", async () => {
  const schema = await import("../src/db/schema.js")
  assert.ok(schema.GoogleWorkspaceConnectionTable)

  const migrationUrl = new URL("../drizzle/0015_google_workspace_connections.sql", import.meta.url)
  assert.equal(existsSync(migrationUrl), true)

  const migration = readFileSync(migrationUrl, "utf8")
  assert.match(migration, /CREATE TABLE `google_workspace_connection`/)
  assert.match(migration, /`grant_ciphertext` longtext NOT NULL/)
  assert.match(migration, /google_workspace_connection_scope/)

  const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
  assert.ok(indexSource.includes("CREATE TABLE IF NOT EXISTS \\`google_workspace_connection\\`"))
  assert.match(
    indexSource,
    /ensureIndex\("google_workspace_connection", "google_workspace_connection_scope", \["org_id", "user_id", "connector_id"\], true\)/,
  )
})
