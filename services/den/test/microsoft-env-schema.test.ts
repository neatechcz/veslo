import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const baseEnv = {
  DATABASE_URL: "mysql://root:root@localhost:3306/veslo_test",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:8788",
}

Object.assign(process.env, baseEnv)

test("den env exposes Microsoft OAuth configuration", async () => {
  const { parseEnv } = await import("../src/env.js")
  const parsed = parseEnv({
    ...baseEnv,
    MICROSOFT_CLIENT_ID: "microsoft-client-id",
    MICROSOFT_CLIENT_SECRET: "microsoft-client-secret",
    MICROSOFT_REDIRECT_URI: "https://api.veslo.work/v1/integrations/microsoft/oauth/callback",
    MICROSOFT_TOKEN_SECRET_KEY: "microsoft-token-secret-012345678901",
    MICROSOFT_CONNECTOR_BASE_URL: "https://api.veslo.work/",
  })

  assert.equal(parsed.microsoft.clientId, "microsoft-client-id")
  assert.equal(parsed.microsoft.clientSecret, "microsoft-client-secret")
  assert.equal(
    parsed.microsoft.redirectUri,
    "https://api.veslo.work/v1/integrations/microsoft/oauth/callback",
  )
  assert.equal(parsed.microsoft.tokenSecretKey, "microsoft-token-secret-012345678901")
  assert.equal(parsed.microsoft.connectorBaseUrl, "https://api.veslo.work")
})

test("den env rejects missing or weak Microsoft token encryption keys in production", async () => {
  const { parseEnv } = await import("../src/env.js")

  assert.throws(
    () => parseEnv({
      ...baseEnv,
      NODE_ENV: "production",
      MICROSOFT_CLIENT_ID: "microsoft-client-id",
      MICROSOFT_CLIENT_SECRET: "microsoft-client-secret",
    }),
    /MICROSOFT_TOKEN_SECRET_KEY is required when Microsoft OAuth is enabled in production/,
  )

  assert.throws(
    () => parseEnv({
      ...baseEnv,
      NODE_ENV: "production",
      MICROSOFT_CLIENT_ID: "microsoft-client-id",
      MICROSOFT_CLIENT_SECRET: "microsoft-client-secret",
      MICROSOFT_TOKEN_SECRET_KEY: "too-short",
    }),
    /MICROSOFT_TOKEN_SECRET_KEY must be at least 32 characters/,
  )
})

test("den env requires Microsoft client id and secret together in production", async () => {
  const { parseEnv } = await import("../src/env.js")

  assert.throws(
    () => parseEnv({
      ...baseEnv,
      NODE_ENV: "production",
      MICROSOFT_CLIENT_ID: "microsoft-client-id",
      MICROSOFT_TOKEN_SECRET_KEY: "microsoft-token-secret-012345678901",
    }),
    /MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET must be configured together/,
  )

  assert.throws(
    () => parseEnv({
      ...baseEnv,
      NODE_ENV: "production",
      MICROSOFT_CLIENT_SECRET: "microsoft-client-secret",
      MICROSOFT_TOKEN_SECRET_KEY: "microsoft-token-secret-012345678901",
    }),
    /MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET must be configured together/,
  )
})

test(".env.example documents Microsoft OAuth environment variables", () => {
  const envExample = readFileSync(new URL("../.env.example", import.meta.url), "utf8")

  assert.match(envExample, /MICROSOFT_CLIENT_ID=/)
  assert.match(envExample, /MICROSOFT_CLIENT_SECRET=/)
  assert.match(envExample, /MICROSOFT_REDIRECT_URI=/)
  assert.match(envExample, /MICROSOFT_TOKEN_SECRET_KEY=/)
  assert.match(envExample, /MICROSOFT_CONNECTOR_BASE_URL=/)
})

test("owned-server compose and env example pass Microsoft OAuth env into Den", () => {
  const compose = readFileSync(new URL("../../../packaging/owned-server/compose.yml", import.meta.url), "utf8")
  const envExample = readFileSync(new URL("../../../packaging/owned-server/env.example", import.meta.url), "utf8")

  assert.match(compose, /MICROSOFT_CLIENT_ID: \$\{MICROSOFT_CLIENT_ID:-\}/)
  assert.match(compose, /MICROSOFT_CLIENT_SECRET: \$\{MICROSOFT_CLIENT_SECRET:-\}/)
  assert.match(
    compose,
    /MICROSOFT_REDIRECT_URI: \$\{MICROSOFT_REDIRECT_URI:-https:\/\/api\.veslo\.work\/v1\/integrations\/microsoft\/oauth\/callback\}/,
  )
  assert.match(compose, /MICROSOFT_TOKEN_SECRET_KEY: \$\{MICROSOFT_TOKEN_SECRET_KEY:-\}/)
  assert.match(
    compose,
    /MICROSOFT_CONNECTOR_BASE_URL: \$\{MICROSOFT_CONNECTOR_BASE_URL:-https:\/\/api\.veslo\.work\}/,
  )

  assert.match(envExample, /^MICROSOFT_CLIENT_ID=/m)
  assert.match(envExample, /^MICROSOFT_CLIENT_SECRET=/m)
  assert.match(envExample, /^MICROSOFT_REDIRECT_URI=https:\/\/api\.veslo\.work\/v1\/integrations\/microsoft\/oauth\/callback$/m)
  assert.match(envExample, /^MICROSOFT_TOKEN_SECRET_KEY=/m)
  assert.match(envExample, /^MICROSOFT_CONNECTOR_BASE_URL=https:\/\/api\.veslo\.work$/m)
})
