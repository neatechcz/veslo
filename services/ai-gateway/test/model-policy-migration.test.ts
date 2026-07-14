import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { getTableColumns } from "drizzle-orm";

import { MySqlAiAccessRepository } from "../src/access/mysql-repository.js";
import type { AiGatewayDb } from "../src/db/index.js";
import { userAiAccessPolicyTable } from "../src/db/schema.js";
import { applyPlatformModelPolicy } from "../src/http/providers/access-policy.js";
import { createUserCredentialsRouter } from "../src/http/user-credentials.js";

// Rollout contract:
// 1. deploy schema/repository/API support;
// 2. configure and verify the platform policy;
// 3. keep runtime compatible with existing per-user model fields;
// 4. remove obsolete UI controls only after a separately approved replacement;
// 5. drop legacy columns only in a later separately approved cleanup.

test("rollback compatibility retains historical columns as runtime model authority", async () => {
  const columns = getTableColumns(userAiAccessPolicyTable);
  assert.ok(columns.default_model);
  assert.ok(columns.allowed_models_json);

  const repository = new MySqlAiAccessRepository({
    select() {
      return {
        from() {
          return {
            where() {
              return {
                async limit() {
                  return [{
                    id: "ai_access_legacy",
                    user_id: "user_legacy",
                    enabled: 1,
                    provider: "openai",
                    credential_id: null,
                    default_model: "legacy-user-model",
                    allowed_models_json: JSON.stringify(["legacy-user-model"]),
                    assignment_origin: "admin_assigned",
                    created_at: new Date("2026-07-12T08:00:00.000Z"),
                    updated_at: new Date("2026-07-12T08:00:00.000Z"),
                  }];
                },
              };
            },
          };
        },
      };
    },
  } as AiGatewayDb);

  const access = await repository.getUserAiAccess("user_legacy");
  assert.equal(access?.defaultModel, "legacy-user-model");
  assert.deepEqual(access?.allowedModels, ["legacy-user-model"]);
});

test("platform policy helper can still apply the active model explicitly", () => {
  const legacyUserRow = {
    defaultModel: "legacy-user-model",
    allowedModels: ["legacy-user-model"],
  };
  const result = applyPlatformModelPolicy({
    routeProvider: "openai",
    activeModel: { provider: "openai", model: "gpt-5.4" },
    body: { messages: [], legacyUserRow },
  });

  assert.deepEqual(result, {
    ok: true,
    body: {
      messages: [],
      legacyUserRow,
      model: "gpt-5.4",
    },
  });
});

test("user credentials endpoint uses the user row model without platform policy", async () => {
  const app = express();
  app.use(createUserCredentialsRouter({
    sessionResolver: {
      async resolveSession(token: string) {
        return { token, user: { id: "user_1", email: "user@example.test" } };
      },
    },
    aiAccess: {
      async getUserAiAccess() {
        return {
          id: "ai_access_1",
          userId: "user_1",
          enabled: true,
          provider: "openai",
          credentialId: null,
          defaultModel: "legacy-user-model",
          allowedModels: ["legacy-user-model"],
          assignmentOrigin: "admin_assigned",
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
      async upsertUserAiAccess() {
        throw new Error("unused");
      },
    },
  }));

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/me/ai-access`, {
      headers: { authorization: "Bearer gateway-token" },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).aiAccess.effectiveModel.model, "legacy-user-model");
  } finally {
    server.close();
    await once(server, "close");
  }
});
