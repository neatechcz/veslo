import assert from "node:assert/strict"
import test from "node:test"

const baseEnv = {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_den",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
}

Object.assign(process.env, baseEnv)

for (const key of [
  "MANAGED_AI_DATABASE_URL",
  "MANAGED_AI_SECRET_KEY",
  "MANAGED_AI_OPENAI_CLIENT_ID",
  "MANAGED_AI_OPENAI_CLIENT_SECRET",
  "MANAGED_AI_OPENAI_REDIRECT_BASE",
]) {
  delete process.env[key]
}

const { parseEnv } = await import("../src/env.js")

test("managed ai env parses explicit database, secret key, and OpenAI OAuth config", () => {
  const parsed = parseEnv({
    ...baseEnv,
    MANAGED_AI_DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_ai_gateway",
    MANAGED_AI_SECRET_KEY: "abcdefghijklmnopqrstuvwxyz123456",
    MANAGED_AI_OPENAI_CLIENT_ID: "openai-client",
    MANAGED_AI_OPENAI_CLIENT_SECRET: "openai-secret",
    MANAGED_AI_OPENAI_REDIRECT_BASE: "https://den.example.test/admin/oauth/openai/callback",
  })

  assert.equal(parsed.managedAi.enabled, true)
  assert.equal(parsed.managedAi.databaseUrl, "mysql://root:root@127.0.0.1:3306/veslo_ai_gateway")
  assert.equal(parsed.managedAi.secretKey, "abcdefghijklmnopqrstuvwxyz123456")
  assert.deepEqual(parsed.managedAi.openAi, {
    clientId: "openai-client",
    clientSecret: "openai-secret",
    redirectBase: "https://den.example.test/admin/oauth/openai/callback",
  })
})

test("managed ai env stays disabled when no managed AI env vars are provided", () => {
  const parsed = parseEnv(baseEnv)

  assert.equal(parsed.managedAi.enabled, false)
  assert.equal(parsed.managedAi.databaseUrl, null)
  assert.equal(parsed.managedAi.secretKey, null)
  assert.deepEqual(parsed.managedAi.openAi, {
    clientId: null,
    clientSecret: null,
    redirectBase: null,
  })
})

test("managed ai env rejects partial managed AI configuration", () => {
  assert.throws(
    () =>
      parseEnv({
        ...baseEnv,
        MANAGED_AI_DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_ai_gateway",
      }),
    /managed-ai/i,
  )
})
