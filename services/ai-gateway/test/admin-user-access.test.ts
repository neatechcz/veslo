import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createDefaultAdminService, type CredentialRecord } from "../src/http/admin.js";
import { createApp } from "../src/index.js";

const ADMIN_AUTHORIZATION = { authorization: "Bearer admin-token" };
const USER_AUTHORIZATION = { authorization: "Bearer den-user-token" };

const AI_ACCESS_PAYLOAD = {
  id: "ai_access_user_123",
  userId: "user_123",
  enabled: true,
  provider: "openai",
  credentialId: "cred_openai_123",
  defaultModel: "gpt-4o-mini",
  allowedModels: ["gpt-4o-mini", "gpt-4.1-mini"],
  updatedAt: "2026-04-08T10:00:00.000Z",
};

const AVAILABLE_CREDENTIALS = [
  { id: "cred_codex_123", name: "Shared Codex A" },
  { id: "cred_codex_456", name: "Shared Codex B" },
];

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

function createAdminUserAccessApp() {
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
      async upsertUserAiAccess(_token: string, userId: string, input: Record<string, unknown>) {
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
            available: input.credentialId === "cred_codex_ok",
            source: input.credentialId === "cred_codex_ok" ? "codex_exec_rate_limits" : "unavailable",
            label: input.credentialId === "cred_codex_ok" ? "Codex limits available" : "Codex limits unavailable",
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
      headers: ADMIN_AUTHORIZATION,
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.availableCredentials, [
      { id: "cred_codex_ok", name: "Credential cred_codex_ok" },
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
        defaultModel: "gpt-5.4",
        allowedModels: ["gpt-5.4"],
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
        defaultModel: "claude-3-7-sonnet",
        allowedModels: ["claude-3-7-sonnet", "claude-3-5-sonnet"],
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
        defaultModel: "claude-3-7-sonnet",
        allowedModels: ["claude-3-7-sonnet", "claude-3-5-sonnet"],
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
        defaultModel: "gpt-5.4",
        allowedModels: ["gpt-5.4"],
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
        defaultModel: "gpt-5.4",
        allowedModels: ["gpt-5.4"],
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
      aiAccess: AI_ACCESS_PAYLOAD,
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
        defaultModel: "claude-3-7-sonnet",
        allowedModels: ["claude-3-7-sonnet"],
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
        defaultModel: "claude-3-7-sonnet",
        allowedModels: ["claude-3-7-sonnet"],
      },
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});
