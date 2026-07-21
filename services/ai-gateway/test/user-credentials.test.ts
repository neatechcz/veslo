import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { AutomaticUserAiAccessInfrastructureError } from "../src/access/automatic-user-access.js";
import type { UserAiAccessPolicyRecord } from "../src/access/repository.js";
import type { CredentialRecord } from "../src/credentials/repository.js";
import { createApp } from "../src/index.js";

type UserSession = {
  token: string;
  user: {
    id: string;
    email?: string;
    name?: string;
  };
};

class TestCredentialRepository {
  async getCredentialRecordById(): Promise<CredentialRecord | null> {
    return null;
  }

  async listHealthyCredentialRecordIds(): Promise<string[]> {
    return [];
  }

  async createUserCredential(input: {
    ownerUserId: string;
    provider: string;
    credentialType: "api_key" | "oauth";
    secretRef: string;
  }): Promise<CredentialRecord> {
    const createdAt = new Date("2026-04-08T12:00:00.000Z");
    return {
      id: "cred_1",
      ownerUserId: input.ownerUserId,
      provider: input.provider,
      credentialType: input.credentialType,
      state: "healthy",
      secretRef: input.secretRef,
      createdAt,
      updatedAt: createdAt,
      lastFailureAt: null,
    };
  }

  async listUserCredentials(input: {
    ownerUserId: string;
    provider: string;
  }): Promise<CredentialRecord[]> {
    const createdAt = new Date("2026-04-08T12:00:00.000Z");
    return [{
      id: `cred_${input.provider}`,
      ownerUserId: input.ownerUserId,
      provider: input.provider,
      credentialType: input.provider === "openai" ? "oauth" : "api_key",
      state: "healthy",
      secretRef: `secret_${input.provider}`,
      createdAt,
      updatedAt: createdAt,
      lastFailureAt: null,
    }];
  }

  async revokeUserCredential(input: {
    ownerUserId: string;
    provider: string;
    credentialId: string;
  }): Promise<CredentialRecord | null> {
    const updatedAt = new Date("2026-04-08T13:00:00.000Z");
    return {
      id: input.credentialId,
      ownerUserId: input.ownerUserId,
      provider: input.provider,
      credentialType: input.provider === "openai" ? "oauth" : "api_key",
      state: "revoked",
      secretRef: `secret_${input.provider}`,
      createdAt: new Date("2026-04-08T12:00:00.000Z"),
      updatedAt,
      lastFailureAt: updatedAt,
    };
  }

  async markCredentialState(): Promise<void> {}
}

function createAiAccessRecord(overrides: Partial<UserAiAccessPolicyRecord> = {}): UserAiAccessPolicyRecord {
  return {
    id: "ai_access_user_123",
    userId: "user_123",
    enabled: true,
    provider: "openai",
    credentialId: null,
    defaultModel: "gpt-4o-mini",
    allowedModels: ["gpt-4o-mini"],
    assignmentOrigin: "admin_assigned",
    createdAt: new Date("2026-04-08T10:00:00.000Z"),
    updatedAt: new Date("2026-04-08T10:05:00.000Z"),
    ...overrides,
  };
}

function createUserAiAccessApp(overrides: {
  session?: UserSession;
  aiAccess?: UserAiAccessPolicyRecord | null;
  getAiAccess?: (userId: string) => Promise<UserAiAccessPolicyRecord | null>;
  getModelPolicy?: () => Promise<unknown>;
  getOrCreateAiAccess?: (userId: string) => Promise<UserAiAccessPolicyRecord>;
} = {}) {
  const session = overrides.session ?? {
    token: "den_token_123",
    user: {
      id: "user_123",
      email: "user@example.test",
    },
  };

  const app = createApp({
    userCredentials: {
      sessionResolver: {
        async resolveSession(token: string) {
          assert.equal(token, session.token);
          return session;
        },
      },
      aiAccess: {
        async getUserAiAccess(userId: string) {
          assert.equal(userId, session.user.id);
          if (overrides.getAiAccess) {
            return overrides.getAiAccess(userId);
          }
          return Object.hasOwn(overrides, "aiAccess")
            ? overrides.aiAccess ?? null
            : createAiAccessRecord();
        },
        async upsertUserAiAccess() {
          throw new Error("unused");
        },
      },
      automaticUserAiAccess: overrides.getOrCreateAiAccess
        ? {
            async resolveUserAiAccess(userId: string) {
              return {
                aiAccess: await overrides.getOrCreateAiAccess!(userId),
                platformPolicy: overrides.getModelPolicy
                  ? await overrides.getModelPolicy() as never
                  : null,
              };
            },
            getOrCreateUserAiAccess: overrides.getOrCreateAiAccess,
            async buildEnabledUpdate() { throw new Error("unused"); },
          }
        : undefined,
      modelPolicy: overrides.getModelPolicy
        ? { getPolicy: overrides.getModelPolicy }
        : undefined,
      openAiOAuth: {
        async startAuthorization() {
          return { authorizeUrl: "https://openai.example.test/authorize" };
        },
        async exchangeCode() {
          return {
            accessToken: "openai_access_token",
            refreshToken: "openai_refresh_token",
            expiresAt: "2026-04-09T00:00:00.000Z",
          };
        },
        async refreshToken() {
          throw new Error("unused");
        },
      },
      credentials: new TestCredentialRepository(),
      secrets: {
        async put() {
          return { secretRef: "secret_ref_1" };
        },
        async get() {
          return null;
        },
        async delete() {},
      },
    } as never,
  });

  return {
    app,
    authHeader: { authorization: `Bearer ${session.token}` },
  };
}

test("GET /api/me/ai-access returns the signed-in user's admin-managed ai access", async () => {
  const runtime = createUserAiAccessApp({});
  const server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/me/ai-access`, {
      headers: runtime.authHeader,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      aiAccess: {
        id: "ai_access_user_123",
        userId: "user_123",
        enabled: true,
        provider: "openai",
        credentialId: null,
        defaultModel: "gpt-4o-mini",
        allowedModels: [],
        selectableModels: [],
        effectiveModel: { provider: "openai", model: "gpt-4o-mini" },
        updatedAt: "2026-04-08T10:05:00.000Z",
      },
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("GET /ai-gateway/me/ai-access returns the signed-in user's admin-managed ai access", async () => {
  const runtime = createUserAiAccessApp({});
  const server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/ai-gateway/me/ai-access`, {
      headers: runtime.authHeader,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      aiAccess: {
        id: "ai_access_user_123",
        userId: "user_123",
        enabled: true,
        provider: "openai",
        credentialId: null,
        defaultModel: "gpt-4o-mini",
        allowedModels: [],
        selectableModels: [],
        effectiveModel: { provider: "openai", model: "gpt-4o-mini" },
        updatedAt: "2026-04-08T10:05:00.000Z",
      },
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("GET explicit user AI access routes return the same policy as /me", async () => {
  const runtime = createUserAiAccessApp({});
  const server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    const meResponse = await fetch(`${baseUrl}/api/me/ai-access`, { headers: runtime.authHeader });

    assert.equal(meResponse.status, 200);
    const expected = await meResponse.json();
    for (const path of [
      "/api/users/user_123/ai-access",
      "/ai-gateway/users/user_123/ai-access",
    ]) {
      const response = await fetch(`${baseUrl}${path}`, { headers: runtime.authHeader });
      assert.equal(response.status, 200, path);
      assert.deepEqual(await response.json(), expected, path);
    }
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("GET explicit user AI access rejects a different user identity before policy lookup", async () => {
  let aiAccessReads = 0;
  let modelPolicyReads = 0;
  const runtime = createUserAiAccessApp({
    getAiAccess: async () => {
      aiAccessReads += 1;
      return createAiAccessRecord();
    },
    getModelPolicy: async () => {
      modelPolicyReads += 1;
      throw new Error("model policy lookup must not run for a mismatched user");
    },
  });
  const server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    for (const path of [
      "/api/users/user_456/ai-access",
      "/ai-gateway/users/user_456/ai-access",
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: runtime.authHeader });
      assert.equal(response.status, 403, path);
      assert.deepEqual(await response.json(), { error: "user_identity_mismatch" }, path);
    }
    assert.equal(aiAccessReads, 0);
    assert.equal(modelPolicyReads, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("GET explicit user AI access requires bearer authentication", async () => {
  const runtime = createUserAiAccessApp({});
  const server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/users/user_123/ai-access`);

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("GET explicit user AI access aliases lazily return the same server-derived policy", async () => {
  const initializedUsers: string[] = [];
  const runtime = createUserAiAccessApp({
    aiAccess: null,
    getOrCreateAiAccess: async (userId) => {
      initializedUsers.push(userId);
      return createAiAccessRecord({ userId, assignmentOrigin: "auto_assigned" });
    },
  });
  const server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    for (const path of [
      "/api/me/ai-access",
      "/api/users/user_123/ai-access",
      "/ai-gateway/me/ai-access",
      "/ai-gateway/users/user_123/ai-access",
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: runtime.authHeader });
      assert.equal(response.status, 200, path);
      assert.equal((await response.json()).aiAccess.assignmentOrigin, undefined, path);
    }
    assert.deepEqual(initializedUsers, ["user_123", "user_123", "user_123", "user_123"]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("GET self and explicit AI access aliases map missing automatic infrastructure to stable 503", async () => {
  const runtime = createUserAiAccessApp({
    aiAccess: null,
    getOrCreateAiAccess: async () => {
      throw new AutomaticUserAiAccessInfrastructureError("gateway_platform_model_policy_unavailable");
    },
  });
  const server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    for (const path of [
      "/api/me/ai-access",
      "/api/users/user_123/ai-access",
      "/ai-gateway/me/ai-access",
      "/ai-gateway/users/user_123/ai-access",
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: runtime.authHeader });
      assert.equal(response.status, 503, path);
      assert.deepEqual(
        await response.json(),
        { error: "gateway_platform_model_policy_unavailable" },
        path,
      );
    }
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("GET /api/me/ai-access publishes an empty roster without platform policy", async () => {
  const runtime = createUserAiAccessApp({
    aiAccess: createAiAccessRecord({
      defaultModel: "gpt-4.1",
      allowedModels: ["gpt-4.1", "gpt-4.1-mini"],
    }),
  });
  const server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/me/ai-access`, { headers: runtime.authHeader });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.aiAccess.defaultModel, "gpt-4.1");
    assert.deepEqual(body.aiAccess.allowedModels, []);
    assert.deepEqual(body.aiAccess.selectableModels, []);
    assert.deepEqual(body.aiAccess.effectiveModel, { provider: "openai", model: "gpt-4.1" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("GET /api/me/ai-access exposes only the global active model and no selectable alternatives", async () => {
  const runtime = createUserAiAccessApp({
    aiAccess: createAiAccessRecord({
      provider: "openai",
      defaultModel: "historical-user-model",
      allowedModels: ["historical-user-model", "global-active", "global-alternative"],
    }),
    getModelPolicy: async () => ({
      id: "platform",
      activeModel: { provider: "openai", model: "global-active" },
      enabledModels: [
        { provider: "openai", model: "global-active" },
        { provider: "openai", model: "global-alternative" },
      ],
      createdAt: new Date("2026-07-21T08:00:00.000Z"),
      updatedAt: new Date("2026-07-21T09:00:00.000Z"),
    }),
  });
  const server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/me/ai-access`, { headers: runtime.authHeader });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.aiAccess.provider, "openai");
    assert.equal(body.aiAccess.defaultModel, "global-active");
    assert.deepEqual(body.aiAccess.allowedModels, ["global-active"]);
    assert.deepEqual(body.aiAccess.selectableModels, []);
    assert.deepEqual(body.aiAccess.effectiveModel, { provider: "openai", model: "global-active" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("GET /api/me/ai-access does not repair Codex credentials on the authorization read path", async () => {
  let repairCalls = 0;
  const runtime = createUserAiAccessApp({
    aiAccess: createAiAccessRecord({
      provider: "codex_oauth",
      credentialId: "cred_codex",
      defaultModel: "gpt-5.6-sol",
      allowedModels: [],
      selectableModels: [],
    }),
  });
  const app = createApp({
    userCredentials: {
      sessionResolver: {
        async resolveSession(token: string) {
          assert.equal(token, "den_token_123");
          return {
            token,
            user: { id: "user_123", email: "user@example.test" },
          };
        },
      },
      aiAccess: {
        async getUserAiAccess() {
          return createAiAccessRecord({
            provider: "codex_oauth",
            credentialId: "cred_codex",
            defaultModel: "gpt-5.6-sol",
            allowedModels: ["gpt-5.6-sol"],
          });
        },
        async upsertUserAiAccess() {
          throw new Error("unused");
        },
      },
      autoAssignedCodexCredentialRotation: {
        async repairCodexAccess() {
          repairCalls += 1;
          throw new Error("credential repair must not run while reading access");
        },
      },
    } as never,
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/me/ai-access`, {
      headers: runtime.authHeader,
    });

    assert.equal(response.status, 200);
    assert.equal(repairCalls, 0);
    assert.deepEqual((await response.json()).aiAccess, {
      id: "ai_access_user_123",
      userId: "user_123",
      enabled: true,
      provider: "codex_oauth",
      credentialId: "cred_codex",
      defaultModel: "gpt-5.6-sol",
      allowedModels: [],
      selectableModels: [],
      effectiveModel: { provider: "codex_oauth", model: "gpt-5.6-sol" },
      updatedAt: "2026-04-08T10:05:00.000Z",
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("GET /api/me/ai-access returns bounded JSON when session lookup throws", async () => {
  const app = createApp({
    userCredentials: {
      sessionResolver: {
        async resolveSession() {
          throw new Error("den lookup failed");
        },
      },
      aiAccess: {
        async getUserAiAccess() {
          assert.fail("ai access lookup should not run when session lookup throws");
        },
        async upsertUserAiAccess() {
          throw new Error("unused");
        },
      },
    } as never,
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/me/ai-access`, {
      headers: { authorization: "Bearer den_token_throws" },
    });

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "user_session_lookup_failed" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("legacy user BYOK credential routes are no longer exposed", async () => {
  const runtime = createUserAiAccessApp({});
  const server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const cases = [
      {
        method: "POST",
        path: "/api/providers/openai/oauth/start",
        body: {},
      },
      {
        method: "POST",
        path: "/api/providers/openai/oauth/callback",
        body: { code: "oauth_code_123" },
      },
      {
        method: "POST",
        path: "/api/providers/anthropic/api-keys",
        body: { apiKey: "sk-ant-secret" },
      },
      {
        method: "GET",
        path: "/api/providers/anthropic/credentials",
      },
      {
        method: "DELETE",
        path: "/api/providers/anthropic/credentials/cred_1",
      },
    ] as const;

    for (const entry of cases) {
      const response = await fetch(`http://127.0.0.1:${port}${entry.path}`, {
        method: entry.method,
        headers: {
          ...runtime.authHeader,
          ...(entry.method === "GET" || entry.method === "DELETE"
            ? {}
            : { "content-type": "application/json" }),
        },
        body: entry.body ? JSON.stringify(entry.body) : undefined,
      });

      assert.equal(response.status, 404, `${entry.method} ${entry.path} should return 404`);
    }
  } finally {
    server.close();
    await once(server, "close");
  }
});
