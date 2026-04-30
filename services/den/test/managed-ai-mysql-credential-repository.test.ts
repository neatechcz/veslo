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
