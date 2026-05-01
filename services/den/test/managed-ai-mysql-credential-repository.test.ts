import assert from "node:assert/strict"
import test from "node:test"
import { MySqlDialect } from "drizzle-orm/mysql-core"

import {
  credentialBindingTable,
  credentialUsageEventTable,
  sessionLeaseTable,
} from "../src/managed-ai/schema.js"
import { MySqlCredentialRepository } from "../src/managed-ai/credentials/mysql-repository.js"

function createActiveLeaseDb(rows: unknown[]) {
  let innerJoinArgs: unknown[] = []
  let whereClause: unknown
  let groupByColumn: unknown

  return {
    db: {
      select() {
        return {
          from() {
            return {
              innerJoin(...args: unknown[]) {
                innerJoinArgs = args
                return {
                  where(clause: unknown) {
                    whereClause = clause
                    return {
                      async groupBy(column: unknown) {
                        groupByColumn = column
                        return rows
                      },
                    }
                  },
                }
              },
            }
          },
        }
      },
    },
    innerJoinArgs() {
      return innerJoinArgs
    },
    whereClause() {
      return whereClause
    },
    groupByColumn() {
      return groupByColumn
    },
  }
}

function createRecentUsageDb(rows: unknown[]) {
  let whereClause: unknown
  let groupByColumn: unknown

  return {
    db: {
      select() {
        return {
          from() {
            return {
              where(clause: unknown) {
                whereClause = clause
                return {
                  async groupBy(column: unknown) {
                    groupByColumn = column
                    return rows
                  },
                }
              },
            }
          },
        }
      },
    },
    whereClause() {
      return whereClause
    },
    groupByColumn() {
      return groupByColumn
    },
  }
}

function createAdminCredentialsDb(input: {
  credentials: unknown[]
  activeLeases: unknown[]
  usage: unknown[]
}) {
  const selections: unknown[] = []

  return {
    db: {
      select(selection?: unknown) {
        const index = selections.length
        selections.push(selection)
        return {
          from() {
            if (index === 0) {
              return {
                async orderBy() {
                  return input.credentials
                },
              }
            }

            if (index === 1) {
              return {
                innerJoin() {
                  return {
                    async groupBy() {
                      return input.activeLeases
                    },
                  }
                },
              }
            }

            return {
              async groupBy() {
                return input.usage
              },
            }
          },
        }
      },
    },
    selections() {
      return selections
    },
  }
}

test("listActiveLeasesByCredential counts active leases by credential id", async () => {
  const fakeDb = createActiveLeaseDb([
    {
      credentialId: "cred_busy",
      activeLeases: 3,
    },
  ])
  const repository = new MySqlCredentialRepository(fakeDb.db)

  const activeLeases = await repository.listActiveLeasesByCredential([
    "cred_idle",
    "cred_busy",
  ])

  assert.deepEqual(activeLeases, [
    {
      credentialId: "cred_busy",
      activeLeases: 3,
    },
  ])
  assert.deepEqual(fakeDb.innerJoinArgs()[0], credentialBindingTable)
  assert.equal(fakeDb.groupByColumn(), credentialBindingTable.credential_record_id)

  const dialect = new MySqlDialect()
  assert.deepEqual(dialect.sqlToQuery(fakeDb.innerJoinArgs()[1] as never), {
    sql: "`session_lease`.`active_binding_id` = `credential_binding`.`id`",
    params: [],
  })
  assert.deepEqual(dialect.sqlToQuery(fakeDb.whereClause() as never), {
    sql: "`credential_binding`.`credential_record_id` in (?, ?)",
    params: ["cred_idle", "cred_busy"],
    typings: ["none", "none"],
  })
})

test("listActiveLeasesByCredential skips the database for an empty credential set", async () => {
  const repository = new MySqlCredentialRepository({
    select() {
      throw new Error("select_not_expected")
    },
  })

  assert.deepEqual(await repository.listActiveLeasesByCredential([]), [])
})

test("listRecentCredentialUsage sums recent total tokens by credential id", async () => {
  const since = new Date("2026-04-29T10:00:00.000Z")
  const fakeDb = createRecentUsageDb([
    {
      credentialId: "cred_recent",
      totalTokens: 42,
      requestCount: 2,
    },
  ])
  const repository = new MySqlCredentialRepository(fakeDb.db)

  const usage = await repository.listRecentCredentialUsage({
    credentialIds: ["cred_old", "cred_recent"],
    since,
  })

  assert.deepEqual(usage, [
    {
      credentialId: "cred_recent",
      totalTokens: 42,
      requestCount: 2,
    },
  ])
  assert.equal(fakeDb.groupByColumn(), credentialUsageEventTable.credential_record_id)

  const dialect = new MySqlDialect()
  assert.deepEqual(dialect.sqlToQuery(fakeDb.whereClause() as never), {
    sql: "(`credential_usage_event`.`credential_record_id` in (?, ?) and `credential_usage_event`.`created_at` >= ?)",
    params: ["cred_old", "cred_recent", "2026-04-29 10:00:00.000"],
    typings: ["none", "none", "none"],
  })
})

test("listRecentCredentialUsage skips the database for an empty credential set", async () => {
  const repository = new MySqlCredentialRepository({
    select() {
      throw new Error("select_not_expected")
    },
  })

  assert.deepEqual(
    await repository.listRecentCredentialUsage({
      credentialIds: [],
      since: new Date("2026-04-29T10:00:00.000Z"),
    }),
    [],
  )
})

test("listAdminCredentials exposes cached and total token totals", async () => {
  const fakeDb = createAdminCredentialsDb({
    credentials: [
      {
        id: "cred_codex_1",
        name: "Shared Codex",
        provider: "codex_oauth",
        credential_type: "oauth",
        state: "healthy",
        owner_user_id: "platform:codex",
        updated_at: new Date("2026-04-29T10:00:00.000Z"),
      },
    ],
    activeLeases: [
      {
        credentialRecordId: "cred_codex_1",
        activeLeases: 3,
      },
    ],
    usage: [
      {
        credentialRecordId: "cred_codex_1",
        cachedTokens: 11,
        totalTokens: 42,
      },
    ],
  })
  const repository = new MySqlCredentialRepository(fakeDb.db)

  const credentials = await repository.listAdminCredentials()

  assert.deepEqual(credentials, [
    {
      id: "cred_codex_1",
      name: "Shared Codex",
      provider: "codex_oauth",
      type: "oauth",
      state: "healthy",
      scope: "platform:codex",
      activeLeases: 3,
      alertCount: 0,
      lastRefreshAt: "2026-04-29T10:00:00.000Z",
      lastFailureAt: null,
      cachedTokens: 11,
      totalTokens: 42,
      nextRotationAt: null,
      linkedAlertIds: [],
    },
  ])
  assert.ok((fakeDb.selections()[2] as Record<string, unknown>).cachedTokens)
  assert.ok((fakeDb.selections()[2] as Record<string, unknown>).totalTokens)
  assert.equal((fakeDb.selections()[2] as Record<string, unknown>).credentialRecordId, credentialUsageEventTable.credential_record_id)
})
