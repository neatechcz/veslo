import assert from "node:assert/strict";
import test from "node:test";

import { MySqlAiAccessRepository } from "../src/access/mysql-repository.js";
import type { AiGatewayDb } from "../src/db/index.js";

function createAiAccessDb(row: Record<string, unknown>) {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                async limit() {
                  return [row];
                },
              };
            },
          };
        },
      };
    },
  };
}

test("reads codex_oauth ai access policies from mysql rows", async () => {
  const repository = new MySqlAiAccessRepository(
    createAiAccessDb({
      id: "ai_access_user_codex",
      user_id: "user_codex",
      enabled: 1,
      provider: "codex_oauth",
      default_model: "gpt-5.4",
      allowed_models_json: JSON.stringify(["gpt-5.4"]),
      created_at: new Date("2026-04-14T10:00:00.000Z"),
      updated_at: new Date("2026-04-14T10:05:00.000Z"),
    }) as AiGatewayDb,
  );

  const policy = await repository.getUserAiAccess("user_codex");

  assert.equal(policy?.provider, "codex_oauth");
});
