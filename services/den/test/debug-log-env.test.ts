import assert from "node:assert/strict"
import test from "node:test"

const baseEnv = {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_den",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
}

Object.assign(process.env, baseEnv)

const { parseEnv } = await import("../src/env.js")

test("debug log env parses ingest, encryption, and retention settings", () => {
  const parsed = parseEnv({
    ...baseEnv,
    DEN_LOG_INGEST_TOKEN: " ingest-token ",
    DEN_LOG_MASTER_KEY: " master-key ",
    DEN_LOG_MASTER_KEY_VERSION: " v1 ",
    DEN_LOG_RETENTION_DAYS: "14",
  })

  assert.deepEqual(parsed.debugLogs, {
    ingestToken: "ingest-token",
    masterKey: "master-key",
    masterKeyVersion: "v1",
    retentionDays: 14,
  })
})

test("debug log env defaults retention and allows missing unused secrets", () => {
  const parsed = parseEnv(baseEnv)

  assert.deepEqual(parsed.debugLogs, {
    ingestToken: null,
    masterKey: null,
    masterKeyVersion: null,
    retentionDays: 30,
  })
})

test("internal AI gateway token env parses optional service token", () => {
  const parsed = parseEnv({
    ...baseEnv,
    DEN_AI_GATEWAY_INTERNAL_TOKEN: " internal-token ",
  })

  assert.equal(parsed.aiGatewayInternalToken, "internal-token")
})

test("debug log env rejects invalid retention days", () => {
  assert.throws(
    () =>
      parseEnv({
        ...baseEnv,
        DEN_LOG_RETENTION_DAYS: "0",
      }),
    /DEN_LOG_RETENTION_DAYS must be a positive number/,
  )
})
