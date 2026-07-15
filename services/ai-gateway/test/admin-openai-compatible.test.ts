import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createDefaultAdminService, type CredentialRecord } from "../src/http/admin.js";
import { createApp } from "../src/index.js";

const ADMIN_AUTHORIZATION = { authorization: "Bearer admin-token" };

function createAdminSession() {
  return {
    user: {
      id: "user_admin",
      email: "admin@example.test",
      emailVerified: true,
      name: "Admin",
    },
    platformAdmin: true,
    activeOrgId: null,
    organizations: [],
  };
}

function createDenClient() {
  return {
    async startBrowserAuth() {
      throw new Error("unused");
    },
    async exchangeBrowserAuth() {
      throw new Error("unused");
    },
    async getSession() {
      return createAdminSession();
    },
    async listUsers() {
      return [];
    },
    async createUser() {
      throw new Error("unused");
    },
    async updateUser() {
      throw new Error("unused");
    },
    async disableUser() {
      throw new Error("unused");
    },
    async enableUser() {
      throw new Error("unused");
    },
    async deleteUser() {},
  };
}

function createAdminCredential(overrides: Partial<CredentialRecord> = {}): CredentialRecord {
  return {
    id: "cred_custom_1",
    name: "Custom compatible provider",
    provider: "openai_compatible",
    type: "api_key",
    state: "healthy",
    scope: "platform:openai_compatible",
    activeLeases: 0,
    alertCount: 0,
    lastRefreshAt: "2026-05-03T08:00:00.000Z",
    lastFailureAt: null,
    cachedTokens: 0,
    totalTokens: 0,
    nextRotationAt: null,
    linkedAlertIds: [],
    ...overrides,
  };
}

test("POST /admin/api/credentials creates an openai-compatible platform credential", async () => {
  const secretCalls: unknown[] = [];
  const credentialCalls: unknown[] = [];
  const app = createApp({
    admin: createDefaultAdminService("http://den.example.test", {
      denClient: createDenClient() as never,
      credentialWriteRepository: {
        async createPlatformCredential(input) {
          credentialCalls.push(input);
          return {
            id: "cred_custom_1",
            name: input.name,
            ownerUserId: input.ownerUserId,
            provider: input.provider,
            credentialType: input.credentialType,
            state: "healthy",
            secretRef: input.secretRef,
            createdAt: new Date("2026-05-03T08:00:00.000Z"),
            updatedAt: new Date("2026-05-03T08:00:00.000Z"),
            lastFailureAt: null,
          };
        },
      },
      secretStore: {
        async put(secret) {
          secretCalls.push(secret);
          return { secretRef: "secret_custom_1" };
        },
        async get() {
          throw new Error("unused");
        },
        async replace() {
          throw new Error("unused");
        },
      },
      auditRepository: {
        async recordEvent() {},
        async listEvents() {
          return [];
        },
      },
    }),
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...ADMIN_AUTHORIZATION,
      },
      body: JSON.stringify({
        provider: "openai_compatible",
        name: "Custom compatible provider",
        secret: "sk-compatible",
        baseUrl: "https://custom.example.test/v1/",
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      credential: createAdminCredential(),
    });
    assert.deepEqual(secretCalls, [
      {
        kind: "openai_compatible_api_key",
        apiKey: "sk-compatible",
        baseUrl: "https://custom.example.test/v1",
      },
    ]);
    assert.deepEqual(credentialCalls, [
      {
        ownerUserId: "platform:openai_compatible",
        provider: "openai_compatible",
        credentialType: "api_key",
        secretRef: "secret_custom_1",
        name: "Custom compatible provider",
      },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("GET /admin/api/users/:userId/ai-access returns assignable openai-compatible credentials", async () => {
  const app = createApp({
    admin: createDefaultAdminService("http://den.example.test", {
      denClient: createDenClient() as never,
      aiAccessRepository: {
        async getUserAiAccess(userId: string) {
          return {
            id: "ai_access_user_123",
            userId,
            enabled: true,
            provider: "openai_compatible" as never,
            credentialId: "cred_custom_1",
            createdAt: new Date("2026-05-03T08:00:00.000Z"),
            updatedAt: new Date("2026-05-03T08:00:00.000Z"),
          };
        },
        async upsertUserAiAccess() {
          throw new Error("unused");
        },
      },
      modelPolicyRepository: {
        async getPolicy() {
          return {
            id: "platform",
            enabledModels: [{ provider: "openai_compatible", model: "custom-model" }],
            activeModel: { provider: "openai_compatible", model: "custom-model" },
            createdAt: new Date("2026-07-12T08:00:00.000Z"),
            updatedAt: new Date("2026-07-12T08:00:00.000Z"),
          };
        },
        async replacePolicy() { throw new Error("unused"); },
      } as any,
      modelCapabilities: {
        async checkHealthyCredentialForModel() { return { status: "supported", credentialId: "cred_custom_1" }; },
        async checkCredentialForModel(credentialId: string) { return { status: "supported", credentialId }; },
        async hasHealthyCredentialForModel() { return true; },
        invalidateCredential() {},
      } as any,
      credentialReadRepository: {
        async listAdminCredentials() {
          return [
            createAdminCredential(),
            createAdminCredential({
              id: "cred_custom_revoked",
              name: "Revoked compatible provider",
              state: "revoked",
            }),
          ];
        },
      },
      alertRepository: {
        async listAlerts() {
          return [];
        },
      },
    }),
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      headers: ADMIN_AUTHORIZATION,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      aiAccess: {
        id: "ai_access_user_123",
        userId: "user_123",
        enabled: true,
        provider: "openai_compatible",
        credentialId: "cred_custom_1",
        updatedAt: "2026-05-03T08:00:00.000Z",
      },
      availableCredentials: [
        {
          id: "cred_custom_1",
          name: "Custom compatible provider",
          provider: "openai_compatible",
        },
      ],
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("GET /admin/api/credentials/:credentialId/models discovers openai-compatible models", async () => {
  const modelCalls: unknown[] = [];
  const app = createApp({
    admin: createDefaultAdminService("http://den.example.test", {
      denClient: createDenClient() as never,
      credentialSecretLookupRepository: {
        async getCredentialRecordById(credentialId: string) {
          assert.equal(credentialId, "cred_custom_1");
          return {
            id: "cred_custom_1",
            provider: "openai_compatible",
            state: "healthy",
            secretRef: "secret_custom_1",
          };
        },
      },
      secretStore: {
        async put() {
          throw new Error("unused");
        },
        async get(secretRef: string) {
          assert.equal(secretRef, "secret_custom_1");
          return {
            kind: "openai_compatible_api_key",
            apiKey: "sk-compatible",
            baseUrl: "https://custom.example.test/v1",
          };
        },
        async replace() {
          throw new Error("unused");
        },
      },
      openAiCompatibleTransport: {
        async chatCompletions() {
          throw new Error("unused");
        },
        async listModels(input) {
          modelCalls.push(input);
          return {
            models: ["qwen3.6", "qwen3.6:free"],
          };
        },
      },
    }),
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials/cred_custom_1/models`, {
      headers: ADMIN_AUTHORIZATION,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      credentialId: "cred_custom_1",
      models: ["qwen3.6", "qwen3.6:free"],
    });
    assert.deepEqual(modelCalls, [
      {
        apiKey: "sk-compatible",
        baseUrl: "https://custom.example.test/v1",
      },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});
