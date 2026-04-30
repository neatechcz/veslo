import assert from "node:assert/strict";
import test from "node:test";
import { MySqlDialect } from "drizzle-orm/mysql-core";

import type { AiGatewayDb } from "../src/db/index.js";
import { MySqlAdminCredentialReadRepository } from "../src/http/admin.js";

test("admin credential read model sums stored usage total_tokens", async () => {
  let usageTotalSelection: unknown;
  const db = {
    select(selection?: Record<string, unknown>) {
      if (!selection) {
        return {
          from() {
            return {
              async orderBy() {
                return [];
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
                    return [];
                  },
                };
              },
            };
          },
        };
      }

      usageTotalSelection = selection.totalTokens;
      return {
        from() {
          return {
            async groupBy() {
              return [];
            },
          };
        },
      };
    },
  };
  const repository = new MySqlAdminCredentialReadRepository(db as AiGatewayDb);

  await repository.listAdminCredentials();

  const dialect = new MySqlDialect();
  const query = dialect.sqlToQuery(usageTotalSelection as never);
  assert.match(query.sql, /sum\(`credential_usage_event`\.`total_tokens`\)/);
  assert.doesNotMatch(query.sql, /input_tokens/);
  assert.doesNotMatch(query.sql, /output_tokens/);
});
