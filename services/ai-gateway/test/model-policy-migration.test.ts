import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { getTableColumns } from "drizzle-orm";

import { MySqlAiAccessRepository } from "../src/access/mysql-repository.js";
import type { AiGatewayDb } from "../src/db/index.js";
import { userAiAccessPolicyTable } from "../src/db/schema.js";
import { createProxyRouter } from "../src/http/proxy.js";
import { applyPlatformModelPolicy } from "../src/http/providers/access-policy.js";
import { createUserCredentialsRouter } from "../src/http/user-credentials.js";
import type { PlatformModelPolicyRecord, PlatformModelRef } from "../src/model-policy/repository.js";

// Rollout contract:
// 1. deploy schema/repository/API support;
// 2. configure and verify the platform policy;
// 3. enable runtime enforcement and simplified user contracts;
// 4. remove obsolete UI controls;
// 5. drop legacy columns only in a later separately approved cleanup.

test("rollback compatibility retains historical columns without exposing model authority", async () => {
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
  assert.equal(Object.hasOwn(access ?? {}, "defaultModel"), false);
  assert.equal(Object.hasOwn(access ?? {}, "allowedModels"), false);
});

test("global active model overrides historical per-user model values", () => {
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

test("runtime enforcement fails closed while the platform policy is unavailable", async () => {
  const app = express();
  app.use(express.json());
  app.use(createProxyRouter({
    gatewaySessions: {
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
          assignmentOrigin: "admin_assigned",
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
      async upsertUserAiAccess() {
        throw new Error("unused");
      },
    },
    modelPolicy: {
      async getPolicy() {
        return null;
      },
      async replacePolicy() {
        throw new Error("unused");
      },
    },
  } as never));

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/providers/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer gateway-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "platform_model_policy_not_configured" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("platform policy can be configured before the simplified runtime contract is enabled", async () => {
  let storedPolicy: PlatformModelPolicyRecord | null = null;
  const modelPolicy = {
    async getPolicy() {
      return storedPolicy;
    },
    async replacePolicy(input: { enabledModels: PlatformModelRef[]; activeModel: PlatformModelRef }) {
      storedPolicy = {
        id: "platform" as const,
        enabledModels: input.enabledModels,
        activeModel: input.activeModel,
        createdAt: new Date("2026-07-12T08:00:00.000Z"),
        updatedAt: new Date("2026-07-12T08:00:00.000Z"),
      };
      return storedPolicy;
    },
  };

  await modelPolicy.replacePolicy({
    enabledModels: [
      { provider: "openai", model: "gpt-5.4" },
      { provider: "openai", model: "gpt-5.5" },
    ],
    activeModel: { provider: "openai", model: "gpt-5.4" },
  });

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
          assignmentOrigin: "admin_assigned",
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
      async upsertUserAiAccess() {
        throw new Error("unused");
      },
    },
    modelPolicy,
  }));

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/me/ai-access`, {
      headers: { authorization: "Bearer gateway-token" },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).aiAccess.effectiveModel.model, "gpt-5.4");
  } finally {
    server.close();
    await once(server, "close");
  }
});
