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
