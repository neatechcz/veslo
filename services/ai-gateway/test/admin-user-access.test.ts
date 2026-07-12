import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createDefaultAdminService, type CredentialRecord } from "../src/http/admin.js";
import { createApp } from "../src/index.js";
import { createPlatformModelCapabilityVerifier } from "../src/model-policy/capability-verifier.js";

const ADMIN_AUTHORIZATION = { authorization: "Bearer admin-token" };
const USER_AUTHORIZATION = { authorization: "Bearer den-user-token" };

const AI_ACCESS_PAYLOAD = {
  id: "ai_access_user_123",
  userId: "user_123",
  enabled: true,
  provider: "openai",
  credentialId: "cred_openai_123",
  updatedAt: "2026-04-08T10:00:00.000Z",
};

const AVAILABLE_CREDENTIALS = [
  { id: "cred_codex_123", name: "Shared Codex A", provider: "codex_oauth" },
  { id: "cred_codex_456", name: "Shared Codex B", provider: "codex_oauth" },
];

let adminUserAccessUpsertCalls = 0;
let adminUserAccessOrganizationId: string | null | undefined;

function createCredential(
  id: string,
  overrides: Partial<Pick<CredentialRecord, "provider" | "state" | "activeLeases">> = {},
): CredentialRecord {
  return {
    id,
    name: `Credential ${id}`,
    provider: overrides.provider ?? "codex_oauth",
    type: "oauth",
    state: overrides.state ?? "healthy",
    scope: "platform",
    activeLeases: overrides.activeLeases ?? 0,
    alertCount: 0,
    lastRefreshAt: "2026-04-27T12:00:00.000Z",
    lastFailureAt: null,
    totalTokens: 0,
    nextRotationAt: null,
    linkedAlertIds: [],
  };
}

function createCodexModelPolicyRepository() {
  return {
    async getPolicy() {
      return {
        id: "platform" as const,
        enabledModels: [{ provider: "codex_oauth" as const, model: "gpt-5.5" }],
        activeModel: { provider: "codex_oauth" as const, model: "gpt-5.5" },
        createdAt: new Date("2026-07-12T08:00:00.000Z"),
        updatedAt: new Date("2026-07-12T08:00:00.000Z"),
      };
    },
    async replacePolicy() { throw new Error("unused"); },
  };
}

function createSupportedModelCapabilities() {
  return {
    async checkHealthyCredentialForModel() { return { status: "supported", credentialId: "unused" } as const; },
    async checkCredentialForModel(credentialId: string) { return { status: "supported", credentialId } as const; },
    async hasHealthyCredentialForModel() { return true; },
    invalidateCredential() {},
  };
}

function createAdminUserAccessApp() {
  adminUserAccessUpsertCalls = 0;
  adminUserAccessOrganizationId = undefined;
  let currentAiAccess = {
    ...AI_ACCESS_PAYLOAD,
  };

  const app = createApp({
    admin: {
      async startBrowserAuth() {
        throw new Error("unused");
      },
      async exchangeBrowserAuth() {
        throw new Error("unused");
      },
      async getSession() {
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
      async deleteUser() {
        return;
      },
      async listCredentials() {
        return { credentials: [] };
      },
      async revokeCredential() {
        throw new Error("unused");
      },
      async drainCredential() {
        throw new Error("unused");
      },
      async rotateCredential() {
        throw new Error("unused");
      },
      async listSessions() {
        return { sessions: [] };
      },
      async getUsage() {
        return {
          summary: { totalTokens: 0, totalRequests: 0 },
          groupBy: "total",
          filters: { credentials: [], users: [], orgs: [] },
          series: [],
          topCredentials: [],
          topUsers: [],
          topOrgs: [],
        };
      },
      async listAlerts() {
        return { alerts: [] };
      },
      async acknowledgeAlert() {
        throw new Error("unused");
      },
      async resolveAlert() {
        throw new Error("unused");
      },
      async listAudit() {
        return { events: [] };
      },
      async getUserAiAccess(_token: string, userId: string) {
        return {
          aiAccess: {
            ...currentAiAccess,
            userId,
          },
          availableCredentials: AVAILABLE_CREDENTIALS,
        };
      },
      async upsertUserAiAccess(_token: string, userId: string, input: Record<string, unknown>, organizationId?: string | null) {
        adminUserAccessUpsertCalls += 1;
        adminUserAccessOrganizationId = organizationId;
        currentAiAccess = {
          id: currentAiAccess.id,
          updatedAt: currentAiAccess.updatedAt,
          userId,
          ...input,
        };
        return {
          aiAccess: {
            ...currentAiAccess,
          },
          availableCredentials: AVAILABLE_CREDENTIALS,
        };
      },
    } as any,
    userCredentials: {
      sessionResolver: {
        async resolveSession(token: string) {
          assert.equal(token, "den-user-token");
          return {
            token,
            user: {
              id: "user_123",
              email: "user@example.test",
            },
          };
        },
      },
      openAiOAuth: {
        async startAuthorization() {
          throw new Error("unused");
        },
        async exchangeCode() {
          throw new Error("unused");
        },
      },
      credentials: {
        async getCredentialRecordById() {
          return null;
        },
        async listHealthyCredentialRecordIds() {
          return [];
        },
        async markCredentialState() {},
      },
      secrets: {
        async put() {
          throw new Error("unused");
        },
        async get() {
          throw new Error("unused");
        },
      },
      aiAccess: {
        async getUserAiAccess(userId: string) {
          return {
            ...currentAiAccess,
            userId,
          };
        },
      },
      modelPolicy: {
        async getPolicy() {
          return {
            id: "platform",
            enabledModels: [{ provider: "openai", model: "gpt-5.5" }],
            activeModel: { provider: "openai", model: "gpt-5.5" },
            createdAt: new Date("2026-07-12T08:00:00.000Z"),
            updatedAt: new Date("2026-07-12T08:00:00.000Z"),
          };
        },
      },
    } as any,
  });

  return app;
}

test("GET /admin/api/users/:userId/ai-access returns the stored ai access policy", async () => {
  const app = createAdminUserAccessApp();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      headers: ADMIN_AUTHORIZATION,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      aiAccess: AI_ACCESS_PAYLOAD,
      availableCredentials: AVAILABLE_CREDENTIALS,
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("PUT /admin/api/users/:userId/ai-access rejects legacy user model fields without writing", async () => {
  const app = createAdminUserAccessApp();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...ADMIN_AUTHORIZATION },
      body: JSON.stringify({
        enabled: true,
        provider: "codex_oauth",
        credentialId: "cred_codex_123",
        defaultModel: "gpt-5.4",
        allowedModels: ["gpt-5.4"],
      }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "user_model_policy_not_supported" });
    assert.equal(adminUserAccessUpsertCalls, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("PUT /admin/api/users/:userId/ai-access forwards authorized organization audit scope", async () => {
  const app = createAdminUserAccessApp();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...ADMIN_AUTHORIZATION },
      body: JSON.stringify({
        enabled: true,
        provider: "codex_oauth",
        credentialId: "cred_codex_123",
        organizationId: "org_1",
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(adminUserAccessOrganizationId, "org_1");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("admin user access rejects a provider that differs from the platform active model", async () => {
  let writes = 0;
  const service = createDefaultAdminService("http://den.example.test", {
    aiAccessRepository: {
      async getUserAiAccess() { return null; },
      async upsertUserAiAccess() { writes += 1; throw new Error("unexpected write"); },
    },
    credentialReadRepository: {
      async listAdminCredentials() {
        return [createCredential("cred_custom", { provider: "openai_compatible", state: "healthy" })];
      },
    },
    modelPolicyRepository: {
      async getPolicy() {
        return {
          id: "platform",
          enabledModels: [{ provider: "codex_oauth", model: "gpt-5.5" }],
          activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
          createdAt: new Date("2026-07-12T08:00:00.000Z"),
          updatedAt: new Date("2026-07-12T08:00:00.000Z"),
        };
      },
      async replacePolicy() { throw new Error("unused"); },
    },
  });

  await assert.rejects(
    service.upsertUserAiAccess("admin-token", "user_123", {
      enabled: true,
      provider: "openai_compatible",
      credentialId: "cred_custom",
    }),
    /ai_access_provider_mismatch/,
  );
  assert.equal(writes, 0);
});

test("admin user access rejects and filters a Codex credential that does not support the active model", async () => {
  let writes = 0;
  const credential = createCredential("cred_codex_limited");
  const modelCapabilities = createPlatformModelCapabilityVerifier({
    credentials: {
      async listAdminCredentials() { return [credential]; },
    } as never,
    secrets: {} as never,
    codexStatusProvider: {
      async getStatus() {
        return {
          available: true,
          source: "codex_exec_no_rate_limits",
          label: "Codex OK, limits unknown",
          unsupportedModels: ["gpt-5.5"],
          limits: { fiveHour: null, weekly: null },
        } as const;
      },
    },
    openAiCompatibleTransport: {} as never,
  });
  const service = createDefaultAdminService("http://den.example.test", {
    aiAccessRepository: {
      async getUserAiAccess() { return null; },
      async upsertUserAiAccess() { writes += 1; throw new Error("unexpected write"); },
    },
    credentialReadRepository: {
      async listAdminCredentials() { return [credential]; },
    },
    codexStatusProvider: {
      async getStatus() {
        return {
          available: true,
          source: "codex_exec_no_rate_limits",
          label: "Codex OK, limits unknown",
          unsupportedModels: ["gpt-5.5"],
          limits: { fiveHour: null, weekly: null },
        } as const;
      },
    },
    modelPolicyRepository: createCodexModelPolicyRepository(),
    modelCapabilities,
  } as never);

  await assert.rejects(
    service.upsertUserAiAccess("admin-token", "user_123", {
      enabled: true,
      provider: "codex_oauth",
      credentialId: credential.id,
    }),
    /incompatible_ai_access_credential_id/,
  );
  assert.equal(writes, 0);
  assert.deepEqual((await service.getUserAiAccess("admin-token", "user_123")).availableCredentials, []);
});

test("admin user access rejects and filters an OpenAI-compatible credential that omits the active model", async () => {
  let writes = 0;
  const credential = createCredential("cred_custom_limited", { provider: "openai_compatible" });
  const modelCapabilities = createPlatformModelCapabilityVerifier({
    credentials: {
      async listAdminCredentials() { return [credential]; },
      async getCredentialRecordById(id: string) {
        return {
          id,
          name: credential.name,
          ownerUserId: "platform:openai_compatible",
          provider: "openai_compatible",
          credentialType: "api_key",
          state: "healthy",
          secretRef: "secret_custom_limited",
          createdAt: new Date("2026-07-12T08:00:00.000Z"),
          updatedAt: new Date("2026-07-12T08:00:00.000Z"),
          lastFailureAt: null,
        };
      },
    } as never,
    secrets: {
      async get() {
        return { kind: "openai_compatible_api_key", apiKey: "test-key", baseUrl: "https://models.example.test/v1" };
      },
    } as never,
    codexStatusProvider: {} as never,
    openAiCompatibleTransport: {
      async chatCompletions() { throw new Error("unused"); },
      async listModels() { return { models: ["other-model"] }; },
    },
  });
  const service = createDefaultAdminService("http://den.example.test", {
    aiAccessRepository: {
      async getUserAiAccess() { return null; },
      async upsertUserAiAccess() { writes += 1; throw new Error("unexpected write"); },
    },
    credentialReadRepository: {
      async listAdminCredentials() { return [credential]; },
    },
    modelPolicyRepository: {
      async getPolicy() {
        return {
          id: "platform",
          enabledModels: [{ provider: "openai_compatible", model: "target-model" }],
          activeModel: { provider: "openai_compatible", model: "target-model" },
          createdAt: new Date("2026-07-12T08:00:00.000Z"),
          updatedAt: new Date("2026-07-12T08:00:00.000Z"),
        };
      },
      async replacePolicy() { throw new Error("unused"); },
    },
    modelCapabilities,
  } as never);

  await assert.rejects(
    service.upsertUserAiAccess("admin-token", "user_123", {
      enabled: true,
      provider: "openai_compatible",
      credentialId: credential.id,
    }),
    /incompatible_ai_access_credential_id/,
  );
  assert.equal(writes, 0);
  assert.deepEqual((await service.getUserAiAccess("admin-token", "user_123")).availableCredentials, []);
});

test("admin user access preserves transient capability failures as 5xx", async () => {
  let writes = 0;
  const credential = createCredential("cred_codex_transient");
  const service = createDefaultAdminService("http://den.example.test", {
    aiAccessRepository: {
      async getUserAiAccess() { return null; },
      async upsertUserAiAccess() { writes += 1; throw new Error("unexpected write"); },
    },
    credentialReadRepository: {
      async listAdminCredentials() { return [credential]; },
    },
    codexStatusProvider: {
      async getStatus() {
        return { available: true, source: "codex_exec_no_rate_limits", label: "available", limits: { fiveHour: null, weekly: null } } as const;
      },
    },
    modelPolicyRepository: createCodexModelPolicyRepository(),
    modelCapabilities: {
      async checkHealthyCredentialForModel() { return { status: "transient", reason: "capability_evidence_unavailable" }; },
      async checkCredentialForModel() { return { status: "transient", reason: "capability_evidence_unavailable" }; },
      async hasHealthyCredentialForModel() { return false; },
      invalidateCredential() {},
    },
  } as never);

  await assert.rejects(
    service.upsertUserAiAccess("admin-token", "user_123", {
      enabled: true,
      provider: "codex_oauth",
      credentialId: credential.id,
    }),
    (error: unknown) => error instanceof Error
      && error.message === "ai_access_credential_capability_unavailable"
      && (error as { status?: number }).status === 503,
  );
  assert.equal(writes, 0);
});

test("GET /admin/api/users/:userId/ai-access only returns eligible codex credentials", async () => {
  const app = createApp({
    admin: createDefaultAdminService("http://den.example.test", {
      denClient: {
        async startBrowserAuth() {
          throw new Error("unused");
        },
        async exchangeBrowserAuth() {
          throw new Error("unused");
        },
        async getSession() {
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
        async deleteUser() {
          return;
        },
      },
      aiAccessRepository: {
        async getUserAiAccess(userId: string) {
          return {
            id: "ai_access_user_123",
            userId,
            enabled: true,
            provider: "codex_oauth",
            credentialId: "cred_codex_ok",
            defaultModel: "gpt-5.4",
            allowedModels: ["gpt-5.4"],
            createdAt: new Date("2026-04-27T12:00:00.000Z"),
            updatedAt: new Date("2026-04-27T12:00:00.000Z"),
          };
        },
        async upsertUserAiAccess() {
          throw new Error("unused");
        },
      },
      modelPolicyRepository: createCodexModelPolicyRepository(),
      modelCapabilities: createSupportedModelCapabilities(),
      credentialReadRepository: {
        async listAdminCredentials() {
          return [
            createCredential("cred_openai_healthy", {
              provider: "openai",
              state: "healthy",
              activeLeases: 0,
            }),
            createCredential("cred_codex_revoked", {
              provider: "codex_oauth",
              state: "revoked",
              activeLeases: 0,
            }),
            createCredential("cred_codex_unavailable", {
              provider: "codex_oauth",
              state: "healthy",
              activeLeases: 0,
            }),
            createCredential("cred_codex_ok", {
              provider: "codex_oauth",
              state: "healthy",
              activeLeases: 1,
            }),
          ];
        },
      },
      codexStatusProvider: {
        async getStatus(input) {
          return {
            available: false,
            source: "unavailable",
            label: "Codex limits unavailable",
            detail: input.credentialId === "cred_codex_ok"
              ? "codex | OK | tokens used | 7,367"
              : "ERROR: Your access token could not be refreshed because your refresh token was already used.",
            checkedAt: "2026-04-27T12:00:00.000Z",
          };
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
    const body = await response.json();
    assert.deepEqual(body.availableCredentials, [
      { id: "cred_codex_ok", name: "Credential cred_codex_ok", provider: "codex_oauth" },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("GET /admin/api/users/:userId/ai-access repairs admin-assigned Codex credentials before returning", async () => {
  const upserts: unknown[] = [];
  const app = createApp({
    admin: createDefaultAdminService("http://den.example.test", {
      denClient: {
        async startBrowserAuth() {
          throw new Error("unused");
        },
        async exchangeBrowserAuth() {
          throw new Error("unused");
        },
        async getSession() {
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
        async deleteUser() {
          return;
        },
      },
      aiAccessRepository: {
        async getUserAiAccess(userId: string) {
          return {
            id: "ai_access_user_123",
            userId,
            enabled: true,
            provider: "codex_oauth",
            credentialId: "cred_old",
            assignmentOrigin: "admin_assigned",
            createdAt: new Date("2026-05-07T08:00:00.000Z"),
            updatedAt: new Date("2026-05-07T08:00:00.000Z"),
          };
        },
        async upsertUserAiAccess(input) {
          upserts.push(input);
          return {
            id: "ai_access_user_123",
            userId: input.userId,
            enabled: input.enabled,
            provider: input.provider,
            credentialId: input.credentialId,
            assignmentOrigin: input.assignmentOrigin,
            createdAt: new Date("2026-05-07T08:00:00.000Z"),
            updatedAt: new Date("2026-05-07T09:00:00.000Z"),
          };
        },
      },
      modelPolicyRepository: createCodexModelPolicyRepository(),
      modelCapabilities: createSupportedModelCapabilities(),
      credentialReadRepository: {
        async listAdminCredentials() {
          return [
            createCredential("cred_old", {
              provider: "codex_oauth",
              state: "unhealthy",
              activeLeases: 0,
            }),
            createCredential("cred_new", {
              provider: "codex_oauth",
              state: "healthy",
              activeLeases: 0,
            }),
          ];
        },
      },
      credentialWriteRepository: {
        async getCredentialRecordById(credentialId: string) {
          if (credentialId === "cred_old") {
            return createCredential("cred_old", {
              provider: "codex_oauth",
              state: "unhealthy",
              activeLeases: 0,
            });
          }
          if (credentialId === "cred_new") {
            return createCredential("cred_new", {
              provider: "codex_oauth",
              state: "healthy",
              activeLeases: 0,
            });
          }
          return null;
        },
        async listAdminCredentials() {
          return [
            createCredential("cred_old", {
              provider: "codex_oauth",
              state: "unhealthy",
              activeLeases: 0,
            }),
            createCredential("cred_new", {
              provider: "codex_oauth",
              state: "healthy",
              activeLeases: 0,
            }),
          ];
        },
      } as any,
      codexStatusProvider: {
        async getStatus(input) {
          return {
            available: input.credentialId === "cred_new",
            source: input.credentialId === "cred_new" ? "codex_exec_no_rate_limits" : "unavailable",
            label: input.credentialId === "cred_new" ? "Codex OK, limits unknown" : "Codex unavailable",
            detail: input.credentialId === "cred_new" ? null : "invalid_grant",
            checkedAt: "2026-05-07T09:00:00.000Z",
            limits: input.credentialId === "cred_new"
              ? {
                  fiveHour: null,
                  weekly: null,
                }
              : undefined,
          };
        },
      },
      auditRepository: {
        async recordEvent() {
          return;
        },
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
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      headers: ADMIN_AUTHORIZATION,
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.aiAccess.credentialId, "cred_new");
    assert.deepEqual(upserts, [
      {
        userId: "user_123",
        enabled: true,
        provider: "codex_oauth",
        credentialId: "cred_new",
        assignmentOrigin: "admin_assigned",
      },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("PUT /admin/api/users/:userId/ai-access rejects ineligible codex credentials", async () => {
  let upsertCalled = false;
  const app = createApp({
    admin: createDefaultAdminService("http://den.example.test", {
      denClient: {
        async startBrowserAuth() {
          throw new Error("unused");
        },
        async exchangeBrowserAuth() {
          throw new Error("unused");
        },
        async getSession() {
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
        async deleteUser() {
          return;
        },
      },
      aiAccessRepository: {
        async getUserAiAccess() {
          return null;
        },
        async upsertUserAiAccess() {
          upsertCalled = true;
          throw new Error("unexpected_ai_access_upsert");
        },
      },
      modelPolicyRepository: createCodexModelPolicyRepository(),
      credentialReadRepository: {
        async listAdminCredentials() {
          return [
            createCredential("cred_codex_revoked", {
              provider: "codex_oauth",
              state: "revoked",
              activeLeases: 0,
            }),
            createCredential("cred_codex_unavailable", {
              provider: "codex_oauth",
              state: "healthy",
              activeLeases: 0,
            }),
          ];
        },
      },
      codexStatusProvider: {
        async getStatus() {
          return {
            available: false,
            source: "unavailable",
            label: "Codex limits unavailable",
            detail: null,
            checkedAt: "2026-04-27T12:00:00.000Z",
          };
        },
      },
    }),
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...ADMIN_AUTHORIZATION,
      },
      body: JSON.stringify({
        enabled: true,
        provider: "codex_oauth",
        credentialId: "cred_codex_unavailable",
      }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "ineligible_ai_access_credential_id",
    });
    assert.equal(upsertCalled, false);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("PUT /admin/api/users/:userId/ai-access persists the admin managed policy", async () => {
  const app = createAdminUserAccessApp();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...ADMIN_AUTHORIZATION,
      },
      body: JSON.stringify({
        enabled: true,
        provider: "anthropic",
        credentialId: "cred_openai_123",
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      aiAccess: {
        ...AI_ACCESS_PAYLOAD,
        userId: "user_123",
        enabled: true,
        provider: "anthropic",
        credentialId: "cred_openai_123",
      },
      availableCredentials: AVAILABLE_CREDENTIALS,
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("PUT /admin/api/users/:userId/ai-access accepts codex_oauth provider", async () => {
  const app = createAdminUserAccessApp();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...ADMIN_AUTHORIZATION,
      },
      body: JSON.stringify({
        enabled: true,
        provider: "codex_oauth",
        credentialId: "cred_codex_123",
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      aiAccess: {
        ...AI_ACCESS_PAYLOAD,
        userId: "user_123",
        enabled: true,
        provider: "codex_oauth",
        credentialId: "cred_codex_123",
      },
      availableCredentials: AVAILABLE_CREDENTIALS,
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("GET /api/me/ai-access returns the signed-in user's effective ai access policy", async () => {
  const app = createAdminUserAccessApp();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/me/ai-access`, {
      headers: USER_AUTHORIZATION,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      aiAccess: {
        ...AI_ACCESS_PAYLOAD,
        effectiveModel: { provider: "openai", model: "gpt-5.5" },
      },
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("admin ai access updates flow through to the signed-in user's effective policy", async () => {
  const app = createAdminUserAccessApp();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const updateResponse = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...ADMIN_AUTHORIZATION,
      },
      body: JSON.stringify({
        enabled: false,
        provider: "anthropic",
        credentialId: "cred_openai_123",
      }),
    });

    assert.equal(updateResponse.status, 200);

    const effectivePolicyResponse = await fetch(`http://127.0.0.1:${port}/api/me/ai-access`, {
      headers: USER_AUTHORIZATION,
    });

    assert.equal(effectivePolicyResponse.status, 200);
    assert.deepEqual(await effectivePolicyResponse.json(), {
      aiAccess: {
        ...AI_ACCESS_PAYLOAD,
        userId: "user_123",
        enabled: false,
        provider: "anthropic",
        credentialId: "cred_openai_123",
        effectiveModel: { provider: "openai", model: "gpt-5.5" },
      },
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});
