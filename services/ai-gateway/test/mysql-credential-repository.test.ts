import assert from "node:assert/strict";
import test from "node:test";
import { MySqlDialect } from "drizzle-orm/mysql-core";

import { credentialBindingTable, sessionLeaseTable } from "../src/db/schema.js";
import type { AiGatewayDb } from "../src/db/index.js";
import { MySqlCredentialRepository } from "../src/credentials/mysql-repository.js";

function createCredentialDb(rows: unknown[]) {
  let innerJoinArgs: unknown[] = [];
  let whereClause: unknown;
  let groupByColumn: unknown;

  return {
    db: {
      select() {
        return {
          from() {
            return {
              innerJoin(...args: unknown[]) {
                innerJoinArgs = args;
                return {
                  where(clause: unknown) {
                    whereClause = clause;
                    return {
                      async groupBy(column: unknown) {
                        groupByColumn = column;
                        return rows;
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    },
    innerJoinArgs() {
      return innerJoinArgs;
    },
    whereClause() {
      return whereClause;
    },
    groupByColumn() {
      return groupByColumn;
    },
  };
}

test("listActiveLeasesByCredential counts active leases by credential id", async () => {
  const fakeDb = createCredentialDb([
    {
      credentialId: "cred_busy",
      activeLeases: 3,
    },
  ]);
  const repository = new MySqlCredentialRepository(fakeDb.db as AiGatewayDb);

  const activeLeases = await repository.listActiveLeasesByCredential([
    "cred_idle",
    "cred_busy",
  ]);

  assert.deepEqual(activeLeases, [
    {
      credentialId: "cred_busy",
      activeLeases: 3,
    },
  ]);
  assert.deepEqual(fakeDb.innerJoinArgs()[0], credentialBindingTable);
  assert.equal(fakeDb.groupByColumn(), credentialBindingTable.credential_record_id);

  const dialect = new MySqlDialect();
  assert.deepEqual(dialect.sqlToQuery(fakeDb.innerJoinArgs()[1] as never), {
    sql: "`session_lease`.`active_binding_id` = `credential_binding`.`id`",
    params: [],
  });
  assert.deepEqual(dialect.sqlToQuery(fakeDb.whereClause() as never), {
    sql: "`credential_binding`.`credential_record_id` in (?, ?)",
    params: ["cred_idle", "cred_busy"],
    typings: ["none", "none"],
  });
});

test("listActiveLeasesByCredential skips the database for an empty credential set", async () => {
  const repository = new MySqlCredentialRepository({
    select() {
      throw new Error("select_not_expected");
    },
  } as never);

  assert.deepEqual(await repository.listActiveLeasesByCredential([]), []);
});

test("listAdminCredentials exposes credential read data used by Codex rotation", async () => {
  const db = {
    select(selection?: Record<string, unknown>) {
      if (!selection) {
        return {
          from() {
            return {
              async orderBy() {
                return [
                  {
                    id: "cred_old",
                    name: "Shared Michal CODEX",
                    owner_user_id: "platform:codex_oauth",
                    provider: "codex_oauth",
                    credential_type: "oauth",
                    state: "unhealthy",
                    secret_ref: "secret_old",
                    created_at: new Date("2026-05-05T09:00:00.000Z"),
                    updated_at: new Date("2026-05-05T10:00:00.000Z"),
                  },
                  {
                    id: "cred_new",
                    name: "Share Vaclav CODEX - new",
                    owner_user_id: "platform:codex_oauth",
                    provider: "codex_oauth",
                    credential_type: "oauth",
                    state: "healthy",
                    secret_ref: "secret_new",
                    created_at: new Date("2026-05-05T09:10:00.000Z"),
                    updated_at: new Date("2026-05-05T10:10:00.000Z"),
                  },
                  {
                    id: "cred_deleted",
                    name: "Shared Michal CODEX - deleted",
                    owner_user_id: "platform:codex_oauth",
                    provider: "codex_oauth",
                    credential_type: "oauth",
                    state: "revoked",
                    secret_ref: "secret_deleted",
                    created_at: new Date("2026-05-05T09:20:00.000Z"),
                    updated_at: new Date("2026-05-05T10:20:00.000Z"),
                    deleted_at: new Date("2026-05-05T11:20:00.000Z"),
                  },
                ];
              },
            };
          },
        };
      }

      if ("activeLeases" in selection) {
        return {
          from() {
            return {
              innerJoin() {
                return {
                  async groupBy() {
                    return [
                      {
                        credentialRecordId: "cred_new",
                        activeLeases: 2,
                      },
                    ];
                  },
                };
              },
            };
          },
        };
      }

      return {
        from() {
          return {
            async groupBy() {
              return [
                {
                  credentialRecordId: "cred_old",
                  cachedTokens: 7,
                  totalTokens: 11,
                },
                {
                  credentialRecordId: "cred_new",
                  cachedTokens: 13,
                  totalTokens: 17,
                },
                {
                  credentialRecordId: "cred_deleted",
                  cachedTokens: 19,
                  totalTokens: 23,
                },
              ];
            },
          };
        },
      };
    },
  };
  const repository = new MySqlCredentialRepository(db as AiGatewayDb);

  const credentials = await repository.listAdminCredentials?.();

  assert.deepEqual(credentials, [
    {
      id: "cred_old",
      name: "Shared Michal CODEX",
      provider: "codex_oauth",
      type: "oauth",
      state: "unhealthy",
      scope: "platform:codex_oauth",
      activeLeases: 0,
      alertCount: 0,
      lastRefreshAt: "2026-05-05T10:00:00.000Z",
      lastFailureAt: "2026-05-05T10:00:00.000Z",
      cachedTokens: 7,
      totalTokens: 11,
      nextRotationAt: null,
      linkedAlertIds: [],
    },
    {
      id: "cred_new",
      name: "Share Vaclav CODEX - new",
      provider: "codex_oauth",
      type: "oauth",
      state: "healthy",
      scope: "platform:codex_oauth",
      activeLeases: 2,
      alertCount: 0,
      lastRefreshAt: "2026-05-05T10:10:00.000Z",
      lastFailureAt: null,
      cachedTokens: 13,
      totalTokens: 17,
      nextRotationAt: null,
      linkedAlertIds: [],
    },
  ]);

  const credentialsWithDeleted = await repository.listAdminCredentials?.({ includeDeleted: true });

  assert.deepEqual(credentialsWithDeleted?.at(-1), {
    id: "cred_deleted",
    name: "Shared Michal CODEX - deleted",
    provider: "codex_oauth",
    type: "oauth",
    state: "revoked",
    scope: "platform:codex_oauth",
    activeLeases: 0,
    alertCount: 0,
    lastRefreshAt: "2026-05-05T10:20:00.000Z",
    lastFailureAt: "2026-05-05T10:20:00.000Z",
    cachedTokens: 19,
    totalTokens: 23,
    nextRotationAt: null,
    linkedAlertIds: [],
    deletedAt: "2026-05-05T11:20:00.000Z",
  });
});
