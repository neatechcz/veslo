import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

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
    defaultModel: "gpt-4o-mini",
    allowedModels: ["gpt-4o-mini"],
    createdAt: new Date("2026-04-08T10:00:00.000Z"),
    updatedAt: new Date("2026-04-08T10:05:00.000Z"),
    ...overrides,
  };
}

function createUserAiAccessApp(overrides: {
  session?: UserSession;
  aiAccess?: UserAiAccessPolicyRecord | null;
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
          return overrides.aiAccess ?? createAiAccessRecord();
        },
        async upsertUserAiAccess() {
          throw new Error("unused");
        },
      },
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
        defaultModel: "gpt-4o-mini",
        allowedModels: ["gpt-4o-mini"],
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
        defaultModel: "gpt-4o-mini",
        allowedModels: ["gpt-4o-mini"],
        updatedAt: "2026-04-08T10:05:00.000Z",
      },
    });
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
