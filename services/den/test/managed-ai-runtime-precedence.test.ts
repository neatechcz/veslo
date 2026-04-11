import assert from "node:assert/strict"
import test from "node:test"

Object.assign(process.env, {
  DATABASE_URL: "mysql://root:root@127.0.0.1:3306/veslo_den",
  BETTER_AUTH_SECRET: "12345678901234567890123456789012",
  BETTER_AUTH_URL: "https://den.example.test",
})

for (const key of [
  "MANAGED_AI_DATABASE_URL",
  "MANAGED_AI_SECRET_KEY",
  "MANAGED_AI_OPENAI_CLIENT_ID",
  "MANAGED_AI_OPENAI_CLIENT_SECRET",
  "MANAGED_AI_OPENAI_REDIRECT_BASE",
]) {
  delete process.env[key]
}

const { resolveManagedAiDb } = await import("../src/managed-ai/db.js")

test("managed ai runtime prefers options databaseUrl over module managedAiDb", () => {
  const moduleDb = { source: "module-scope" }
  const createdDb = { source: "options-database-url" }
  const optionsDb = { source: "explicit-options-db" }

  const fromExplicitDb = resolveManagedAiDb(
    {
      db: optionsDb,
      databaseUrl: "mysql://ignored",
    },
    {
      managedAiDb: moduleDb,
      createManagedAiDb: () => createdDb,
    },
  )

  assert.equal(fromExplicitDb, optionsDb)

  const fromDatabaseUrl = resolveManagedAiDb(
    {
      databaseUrl: "mysql://selected",
    },
    {
      managedAiDb: moduleDb,
      createManagedAiDb: (databaseUrl) => {
        assert.equal(databaseUrl, "mysql://selected")
        return createdDb
      },
    },
  )

  assert.equal(fromDatabaseUrl, createdDb)

  const fromModuleFallback = resolveManagedAiDb(
    {},
    {
      managedAiDb: moduleDb,
      createManagedAiDb: () => createdDb,
    },
  )

  assert.equal(fromModuleFallback, moduleDb)
})
