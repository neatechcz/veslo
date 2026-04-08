import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { getPlatformCredentialOwnerUserId } from "../src/credentials/platform-owner.js";
import { createDefaultAdminService, type AdminSessionSnapshot } from "../src/http/admin.js";
import { createApp } from "../src/index.js";

const AUTHORIZATION = { authorization: "Bearer admin-token" };

function createSession(): AdminSessionSnapshot {
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

function createAdminCredentialCreateApp() {
  const calls = {
    secrets: [] as Array<{ kind: string; apiKey: string }>,
    credentials: [] as Array<{
      ownerUserId: string;
      provider: string;
      credentialType: "api_key" | "oauth";
      secretRef: string;
      name: string;
    }>,
  };

  const service = createDefaultAdminService("http://den.example.test", {
    denClient: {
      async startBrowserAuth() {
        throw new Error("unused");
      },
      async exchangeBrowserAuth() {
        throw new Error("unused");
      },
      async getSession() {
        return createSession();
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
    credentialReadRepository: {
      async listAdminCredentials() {
        return [];
      },
    },
    credentialActionRepository: {
      async revokeCredential() {
        return false;
      },
      async drainCredential() {
        return false;
      },
      async rotateCredential() {
        return false;
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
    usageRepository: {
      async recordUsage() {
        return;
      },
      async aggregateUsage() {
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
    },
    secretStore: {
      async put(secret: { kind: "api_key"; apiKey: string }) {
        calls.secrets.push(secret);
        return { secretRef: "secret_admin_1" };
      },
      async get() {
        throw new Error("unused");
      },
      async replace() {
        throw new Error("unused");
      },
    },
    credentialWriteRepository: {
      async createPlatformCredential(input: {
        ownerUserId: string;
        provider: string;
        credentialType: "api_key" | "oauth";
        secretRef: string;
        name: string;
      }) {
        calls.credentials.push(input);
        const createdAt = new Date("2026-04-08T14:00:00.000Z");
        return {
          id: "cred_platform_openai_1",
          ownerUserId: input.ownerUserId,
          provider: input.provider,
          credentialType: input.credentialType,
          state: "healthy",
          secretRef: input.secretRef,
          name: input.name,
          createdAt,
          updatedAt: createdAt,
          lastFailureAt: null,
        };
      },
    },
  } as any);

  return {
    app: createApp({ admin: service }),
    calls,
  };
}

test("POST /admin/api/credentials creates a platform OpenAI credential", async () => {
  const runtime = createAdminCredentialCreateApp();
  const server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials`, {
      method: "POST",
      headers: {
        ...AUTHORIZATION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "openai",
        name: "Shared OpenAI key",
        secret: "sk-live-openai",
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      credential: {
        id: "cred_platform_openai_1",
        name: "Shared OpenAI key",
        provider: "openai",
        type: "api_key",
        state: "healthy",
        scope: getPlatformCredentialOwnerUserId("openai"),
        activeLeases: 0,
        alertCount: 0,
        lastRefreshAt: "2026-04-08T14:00:00.000Z",
        lastFailureAt: null,
        totalTokens: 0,
        nextRotationAt: null,
        linkedAlertIds: [],
      },
    });
    assert.deepEqual(runtime.calls.secrets, [{ kind: "api_key", apiKey: "sk-live-openai" }]);
    assert.deepEqual(runtime.calls.credentials, [
      {
        ownerUserId: getPlatformCredentialOwnerUserId("openai"),
        provider: "openai",
        credentialType: "api_key",
        secretRef: "secret_admin_1",
        name: "Shared OpenAI key",
      },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("POST /admin/api/credentials rejects empty secrets", async () => {
  const runtime = createAdminCredentialCreateApp();
  const server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials`, {
      method: "POST",
      headers: {
        ...AUTHORIZATION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "anthropic",
        name: "Shared Anthropic key",
        secret: "",
      }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_credential_secret" });
  } finally {
    server.close();
    await once(server, "close");
  }
});
