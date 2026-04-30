import assert from "node:assert/strict";
import test from "node:test";
import { MySqlDialect } from "drizzle-orm/mysql-core";

import type { AiGatewayDb } from "../src/db/index.js";
import { MySqlUsageRepository } from "../src/usage/mysql-repository.js";

function createUsageDb(rows: unknown[]) {
  let whereClause: unknown;

  return {
    db: {
      select() {
        return {
          from() {
            return {
              async where(clause: unknown) {
                whereClause = clause;
                return rows;
              },
            };
          },
        };
      },
      insert() {
        throw new Error("unused");
      },
    },
    whereClause() {
      return whereClause;
    },
  };
}

test("aggregateUsage uses stored total token values from usage rows", async () => {
  const fakeDb = createUsageDb([
    {
      credential_record_id: "cred_openai_1",
      owner_user_id: "user_gateway",
      org_id: null,
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 42,
      created_at: new Date("2026-04-30T10:00:00.000Z"),
    },
  ]);
  const repository = new MySqlUsageRepository(fakeDb.db as AiGatewayDb);

  const usage = await repository.aggregateUsage({
    groupBy: "total",
    credentialId: null,
    userId: null,
    orgId: null,
  });

  assert.equal(usage.summary.totalTokens, 42);
  assert.equal(usage.series[0]?.totalTokens, 42);
  assert.equal(usage.topCredentials[0]?.totalTokens, 42);
});

test("aggregateUsage filters unknown org usage with an org_id IS NULL predicate", async () => {
  const fakeDb = createUsageDb([]);
  const repository = new MySqlUsageRepository(fakeDb.db as AiGatewayDb);

  await repository.aggregateUsage({
    groupBy: "org",
    credentialId: null,
    userId: null,
    orgId: "unknown-org",
  });

  const dialect = new MySqlDialect();
  assert.deepEqual(dialect.sqlToQuery(fakeDb.whereClause() as never), {
    sql: "`credential_usage_event`.`org_id` is null",
    params: [],
  });
});
