import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { CredentialRecord } from "../src/credentials/repository.js";
import type { UpstreamAuth } from "../src/credentials/token-broker.js";
import type { BindingSelector } from "../src/leases/binding-selector.js";
import { DefaultBindingSelector } from "../src/leases/binding-selector.js";
import { LeaseBroker } from "../src/leases/lease-broker.js";
import type {
  CreateSessionLeaseInput,
  LeaseRepository,
  RebindSessionLeaseInput,
  ResolveLeaseInput,
  SessionLease,
} from "../src/leases/repository.js";
import { createApp, type AppDependencies } from "../src/index.js";

class InMemoryLeaseRepository implements LeaseRepository {
  private readonly leasesByKey = new Map<string, SessionLease>();
  private leaseIdCounter = 0;
  public createCalls = 0;
  public rebindCalls = 0;

  async getActiveLease(input: ResolveLeaseInput): Promise<SessionLease | null> {
    return this.leasesByKey.get(leaseKey(input)) ?? null;
  }

  async createLeaseIfMissing(input: CreateSessionLeaseInput): Promise<SessionLease> {
    const key = leaseKey(input);
    const existing = this.leasesByKey.get(key);
    if (existing) {
      return existing;
    }

    this.createCalls += 1;
    const created: SessionLease = {
      id: `lease_${++this.leaseIdCounter}`,
      ownerUserId: input.ownerUserId,
      provider: input.provider,
      sessionId: input.sessionId,
      activeBindingId: input.activeBindingId,
    };

    this.leasesByKey.set(key, created);
    return created;
  }

  async rebindLease(input: RebindSessionLeaseInput): Promise<SessionLease | null> {
    const key = leaseKey(input);
    const existing = this.leasesByKey.get(key);
    if (!existing || existing.activeBindingId !== input.expectedCurrentBindingId) {
      return null;
    }

    this.rebindCalls += 1;
    const rebound: SessionLease = {
      ...existing,
      activeBindingId: input.nextBindingId,
    };

    this.leasesByKey.set(key, rebound);
    return rebound;
  }
}

function leaseKey(input: ResolveLeaseInput): string {
  return `${input.ownerUserId}:${input.provider}:${input.sessionId}`;
}

function createFailureError(input: { message: string; statusCode: number; code?: string }): Error & {
  statusCode: number;
  code?: string;
} {
  const error = new Error(input.message) as Error & { statusCode: number; code?: string };
  error.statusCode = input.statusCode;
  error.code = input.code;
  return error;
}

async function withMutedConsoleError<T>(run: () => Promise<T>): Promise<T> {
  const originalConsoleError = console.error;
  const mutedConsoleError: typeof console.error = () => {};
  console.error = mutedConsoleError;

  try {
    return await run();
  } finally {
    console.error = originalConsoleError;
  }
}

const GATEWAY_AUTH_HEADER = {
  authorization: "Bearer gateway-access-token",
};

function createGatewaySessions() {
  return {
    async resolveSession(token: string) {
      assert.equal(token, "gateway-access-token");
      return {
        token,
        user: {
          id: "user_gateway",
          email: "gateway@example.test",
        },
      };
    },
  };
}

function createCredentialsByBindingId(records: Record<string, CredentialRecord>) {
  return {
    async getCredentialRecordById() {
      return null;
    },
    async listHealthyCredentialRecordIds() {
      return [];
    },
    async getCredentialRecordByBindingId(bindingId: string) {
      return records[bindingId] ?? null;
    },
    async markCredentialState() {},
  };
}

function createCredentialRecord(
  bindingId: string,
  provider: "openai" | "anthropic" | "codex_oauth",
  overrides: Partial<CredentialRecord> = {},
): CredentialRecord {
  return {
    id: `cred_${bindingId}`,
    ownerUserId: provider === "codex_oauth" ? "platform:codex_oauth" : "user_gateway",
    provider,
    credentialType: provider === "anthropic" ? "api_key" : "oauth",
    state: "healthy",
    secretRef: `secret_${bindingId}`,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    lastFailureAt: null,
    ...overrides,
  };
}

function createNoopUsageRepository() {
  return {
    async recordUsage() {},
  };
}

function createCodexAiAccess(
  credentialId = "cred_codex_assigned",
  assignmentOrigin: "auto_assigned" | "admin_assigned" = "admin_assigned",
): {
  getUserAiAccess(userId: string): Promise<{
    id: string;
    userId: string;
    enabled: boolean;
    provider: "codex_oauth";
    credentialId: string;
    defaultModel: string;
    allowedModels: string[];
    assignmentOrigin: "auto_assigned" | "admin_assigned";
    createdAt: Date;
    updatedAt: Date;
  }>;
} {
  return {
    async getUserAiAccess(userId: string) {
      return {
        id: "ai_access_codex_user_gateway",
        userId,
        enabled: true,
        provider: "codex_oauth",
        credentialId,
        defaultModel: "gpt-5.4",
        allowedModels: ["gpt-5.4"],
        assignmentOrigin,
        createdAt: new Date("2026-04-10T10:00:00.000Z"),
        updatedAt: new Date("2026-04-10T10:00:00.000Z"),
      };
    },
  };
}

function createCodexCredentialRepository() {
  const listEligibleBindingsCalls: Array<{ ownerUserId: string; provider: string; excludeBindingId?: string }> = [];
  const assignedBinding = {
    id: "binding_codex_assigned",
    ownerUserId: "platform:codex_oauth",
    provider: "codex_oauth",
    credentialRecordId: "cred_codex_assigned",
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
  };
  const fallbackBinding = {
    id: "binding_codex_fallback",
    ownerUserId: "platform:codex_oauth",
    provider: "codex_oauth",
    credentialRecordId: "cred_codex_fallback",
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
  };
  const bindingByCredentialId = new Map([
    ["cred_codex_assigned", assignedBinding],
    ["cred_codex_fallback", fallbackBinding],
  ]);
  const recordByBindingId: Record<string, CredentialRecord> = {
    binding_codex_assigned: createCredentialRecord("binding_codex_assigned", "codex_oauth", {
      id: "cred_codex_assigned",
    }),
    binding_codex_fallback: createCredentialRecord("binding_codex_fallback", "codex_oauth", {
      id: "cred_codex_fallback",
    }),
  };

  return {
    async getCredentialRecordById(credentialRecordId: string) {
      return Object.values(recordByBindingId).find((record) => record.id === credentialRecordId) ?? null;
    },
    async listHealthyCredentialRecordIds() {
      return Object.values(recordByBindingId).map((record) => record.id);
    },
    async listEligibleBindings(input: { ownerUserId: string; provider: string; excludeBindingId?: string }) {
      listEligibleBindingsCalls.push(input);
      assert.equal(input.ownerUserId, "platform:codex_oauth");
      assert.equal(input.provider, "codex_oauth");
      return [fallbackBinding, assignedBinding].filter((binding) => binding.id !== input.excludeBindingId);
    },
    async listRecentCredentialUsage() {
      return [];
    },
    async getCredentialRecordByBindingId(bindingId: string) {
      return recordByBindingId[bindingId] ?? null;
    },
    async getBindingByCredentialId(credentialId: string) {
      return bindingByCredentialId.get(credentialId) ?? null;
    },
    async markCredentialState() {},
    listEligibleBindingsCalls,
  };
}

function createCodexSecrets(secretAuthJson = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    refresh_token: "proxy-refresh-token",
    account_id: "acct_proxy",
  },
})) {
  return {
    async get(secretRef: string) {
      assert.match(secretRef, /^secret_binding_codex_/);
      return {
        kind: "codex_auth_json",
        authJson: secretAuthJson,
      };
    },
  };
}

test("POST /providers/openai/v1/chat/completions forwards with sticky openai lease", async () => {
  const leases = new InMemoryLeaseRepository();
  const selectorCalls = { initial: 0, replacement: 0 };
  const selector: BindingSelector = {
    async selectInitialBinding() {
      selectorCalls.initial += 1;
      return "binding_openai_alpha";
    },
    async selectReplacementBinding() {
      selectorCalls.replacement += 1;
      return "binding_openai_beta";
    },
  };

  const tokenBrokerCalls: Array<{ bindingId: string }> = [];
  const openAiCalls: Array<{ upstreamAuth: UpstreamAuth; body: unknown }> = [];
  const leaseBroker = new LeaseBroker(leases, selector);
  const app = createApp({
    proxy: {
      gatewaySessions: createGatewaySessions(),
      credentials: createCredentialsByBindingId({
        binding_openai_alpha: createCredentialRecord("binding_openai_alpha", "openai"),
      }),
      usageRepository: createNoopUsageRepository(),
      leaseBroker,
      tokenBroker: {
        async getUpstreamAuth(input: { bindingId: string }) {
          tokenBrokerCalls.push(input);
          return { kind: "oauth", value: `oauth_for_${input.bindingId}` };
        },
      },
      openAiTransport: {
        async chatCompletions(input: { upstreamAuth: UpstreamAuth; body: unknown }) {
          openAiCalls.push(input);
          return {
            status: 200,
            headers: {
              "x-upstream-request-id": "openai_req_123",
            },
            body: {
              id: "cmpl_123",
              object: "chat.completion",
              model: "gpt-test",
            },
          };
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("anthropic transport should not be used for openai routes");
        },
      },
    } as NonNullable<AppDependencies["proxy"]>,
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/providers/openai/v1/chat/completions`;
    const requestBody = {
      model: "gpt-test",
      messages: [{ role: "user", content: "Hello" }],
    };

    const first = await fetch(url, {
      method: "POST",
      headers: {
        ...GATEWAY_AUTH_HEADER,
        "content-type": "application/json",
        "x-veslo-session-id": "session_openai_1",
      },
      body: JSON.stringify(requestBody),
    });

    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-upstream-request-id"), "openai_req_123");
    assert.deepEqual(await first.json(), {
      id: "cmpl_123",
      object: "chat.completion",
      model: "gpt-test",
    });

    const second = await fetch(url, {
      method: "POST",
      headers: {
        ...GATEWAY_AUTH_HEADER,
        "content-type": "application/json",
        "x-veslo-session-id": "session_openai_1",
      },
      body: JSON.stringify(requestBody),
    });

    assert.equal(second.status, 200);
    assert.equal(leases.createCalls, 1);
    assert.equal(selectorCalls.initial, 1);
    assert.equal(selectorCalls.replacement, 0);
    assert.deepEqual(tokenBrokerCalls, [
      { bindingId: "binding_openai_alpha" },
      { bindingId: "binding_openai_alpha" },
    ]);
    assert.equal(openAiCalls.length, 2);
    assert.deepEqual(openAiCalls[0]?.upstreamAuth, {
      kind: "oauth",
      value: "oauth_for_binding_openai_alpha",
    });
    assert.deepEqual(openAiCalls[0]?.body, requestBody);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("POST /providers/anthropic/v1/messages forwards with sticky anthropic lease", async () => {
  const leases = new InMemoryLeaseRepository();
  const selectorCalls = { initial: 0 };
  const selector: BindingSelector = {
    async selectInitialBinding() {
      selectorCalls.initial += 1;
      return "binding_anthropic_alpha";
    },
    async selectReplacementBinding() {
      return "binding_anthropic_beta";
    },
  };

  const tokenBrokerCalls: Array<{ bindingId: string }> = [];
  const anthropicCalls: Array<{ upstreamAuth: UpstreamAuth; body: unknown }> = [];
  const leaseBroker = new LeaseBroker(leases, selector);
  const app = createApp({
    proxy: {
      gatewaySessions: createGatewaySessions(),
      credentials: createCredentialsByBindingId({
        binding_anthropic_alpha: createCredentialRecord("binding_anthropic_alpha", "anthropic"),
      }),
      usageRepository: createNoopUsageRepository(),
      leaseBroker,
      tokenBroker: {
        async getUpstreamAuth(input: { bindingId: string }) {
          tokenBrokerCalls.push(input);
          return { kind: "api-key", value: `api_key_for_${input.bindingId}` };
        },
      },
      openAiTransport: {
        async chatCompletions() {
          assert.fail("openai transport should not be used for anthropic routes");
        },
      },
      anthropicTransport: {
        async messages(input: { upstreamAuth: UpstreamAuth; body: unknown }) {
          anthropicCalls.push(input);
          return {
            status: 200,
            body: {
              id: "msg_123",
              type: "message",
              model: "claude-test",
            },
          };
        },
      },
    } as NonNullable<AppDependencies["proxy"]>,
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/providers/anthropic/v1/messages`;
    const requestBody = {
      model: "claude-test",
      max_tokens: 64,
      messages: [{ role: "user", content: "Hello" }],
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...GATEWAY_AUTH_HEADER,
        "content-type": "application/json",
        "x-veslo-session-id": "session_anthropic_1",
      },
      body: JSON.stringify(requestBody),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      id: "msg_123",
      type: "message",
      model: "claude-test",
    });
    assert.equal(leases.createCalls, 1);
    assert.equal(selectorCalls.initial, 1);
    assert.deepEqual(tokenBrokerCalls, [{ bindingId: "binding_anthropic_alpha" }]);
    assert.equal(anthropicCalls.length, 1);
    assert.deepEqual(anthropicCalls[0]?.upstreamAuth, {
      kind: "api-key",
      value: "api_key_for_binding_anthropic_alpha",
    });
    assert.deepEqual(anthropicCalls[0]?.body, requestBody);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("permanent credential failures call handleUpstreamFailure and retry once", async () => {
  const leases = new InMemoryLeaseRepository();
  const selector: BindingSelector = {
    async selectInitialBinding() {
      return "binding_openai_alpha";
    },
    async selectReplacementBinding() {
      return "binding_openai_beta";
    },
  };

  const leaseBroker = new LeaseBroker(leases, selector);
  const failureCalls: Array<{
    ownerUserId: string;
    provider: string;
    sessionId: string;
    currentBindingId: string;
    failure: unknown;
  }> = [];
  const originalHandleUpstreamFailure = leaseBroker.handleUpstreamFailure.bind(leaseBroker);
  leaseBroker.handleUpstreamFailure = async (input) => {
    failureCalls.push(input);
    return originalHandleUpstreamFailure(input);
  };

  const tokenBrokerCalls: Array<{ bindingId: string }> = [];
  const transportCalls: Array<{ upstreamAuth: UpstreamAuth; body: unknown }> = [];
  const app = createApp({
    proxy: {
      gatewaySessions: createGatewaySessions(),
      credentials: createCredentialsByBindingId({
        binding_openai_primary: createCredentialRecord("binding_openai_primary", "openai"),
        binding_openai_failover: createCredentialRecord("binding_openai_failover", "openai"),
      }),
      usageRepository: createNoopUsageRepository(),
      leaseBroker,
      tokenBroker: {
        async getUpstreamAuth(input: { bindingId: string }) {
          tokenBrokerCalls.push(input);
          return { kind: "oauth", value: `oauth_for_${input.bindingId}` };
        },
      },
      openAiTransport: {
        async chatCompletions(input: { upstreamAuth: UpstreamAuth; body: unknown }) {
          transportCalls.push(input);
          if (transportCalls.length === 1) {
            throw createFailureError({
              message: "invalid api key",
              statusCode: 401,
              code: "invalid_api_key",
            });
          }

          return {
            status: 200,
            body: {
              id: "cmpl_retry",
              object: "chat.completion",
              model: "gpt-test",
            },
          };
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("anthropic transport should not be used for openai routes");
        },
      },
    } as NonNullable<AppDependencies["proxy"]>,
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${port}/providers/openai/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          ...GATEWAY_AUTH_HEADER,
          "content-type": "application/json",
          "x-veslo-session-id": "session_rebind_1",
        },
        body: JSON.stringify({ model: "gpt-test", messages: [] }),
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      id: "cmpl_retry",
      object: "chat.completion",
      model: "gpt-test",
    });
    assert.equal(leases.rebindCalls, 1);
    assert.equal(failureCalls.length, 1);
    assert.deepEqual(tokenBrokerCalls, [
      { bindingId: "binding_openai_alpha" },
      { bindingId: "binding_openai_beta" },
    ]);
    assert.equal(transportCalls.length, 2);
    assert.deepEqual(transportCalls[0]?.upstreamAuth, {
      kind: "oauth",
      value: "oauth_for_binding_openai_alpha",
    });
    assert.deepEqual(transportCalls[1]?.upstreamAuth, {
      kind: "oauth",
      value: "oauth_for_binding_openai_beta",
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("transient upstream failures do not rebind", async () => {
  const leases = new InMemoryLeaseRepository();
  const selector: BindingSelector = {
    async selectInitialBinding() {
      return "binding_openai_alpha";
    },
    async selectReplacementBinding() {
      return "binding_openai_beta";
    },
  };

  const leaseBroker = new LeaseBroker(leases, selector);
  const failureCalls: Array<unknown> = [];
  const originalHandleUpstreamFailure = leaseBroker.handleUpstreamFailure.bind(leaseBroker);
  leaseBroker.handleUpstreamFailure = async (input) => {
    failureCalls.push(input);
    return originalHandleUpstreamFailure(input);
  };

  let transportCalls = 0;
  const app = createApp({
    proxy: {
      gatewaySessions: createGatewaySessions(),
      credentials: createCredentialsByBindingId({
        binding_openai_alpha: createCredentialRecord("binding_openai_alpha", "openai"),
      }),
      usageRepository: createNoopUsageRepository(),
      leaseBroker,
      tokenBroker: {
        async getUpstreamAuth() {
          return { kind: "oauth", value: "oauth_for_binding_openai_alpha" };
        },
      },
      openAiTransport: {
        async chatCompletions() {
          transportCalls += 1;
          throw createFailureError({
            message: "upstream unavailable",
            statusCode: 503,
          });
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("anthropic transport should not be used for openai routes");
        },
      },
    } as NonNullable<AppDependencies["proxy"]>,
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    await withMutedConsoleError(async () => {
      const response = await fetch(
        `http://127.0.0.1:${port}/providers/openai/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            ...GATEWAY_AUTH_HEADER,
            "content-type": "application/json",
            "x-veslo-session-id": "session_transient_1",
          },
          body: JSON.stringify({ model: "gpt-test", messages: [] }),
        },
      );

      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: "proxy_request_failed" });
    });
    assert.equal(transportCalls, 1);
    assert.equal(leases.rebindCalls, 0);
    assert.equal(failureCalls.length, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("POST /providers/codex_oauth/v1/chat/completions routes through the assigned shared credential", async () => {
  const leases = new InMemoryLeaseRepository();
  const credentials = createCodexCredentialRepository();
  const leaseBroker = new LeaseBroker(leases, new DefaultBindingSelector(credentials as never));
  const recordUsageCalls: Array<Record<string, unknown>> = [];
  const transportBodies: unknown[] = [];
  const transportAuthJson: Array<string | null | undefined> = [];
  const secretAuthJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      refresh_token: "proxy-refresh-token",
      account_id: "acct_proxy",
    },
  });

  const app = createApp({
    proxy: {
      aiAccess: createCodexAiAccess(),
      gatewaySessions: createGatewaySessions(),
      credentials: credentials as never,
      secrets: createCodexSecrets(secretAuthJson) as never,
      usageRepository: {
        async recordUsage(input: Record<string, unknown>) {
          recordUsageCalls.push(input);
        },
      },
      leaseBroker,
      tokenBroker: {
        async getUpstreamAuth() {
          assert.fail("token broker should not run for codex worker routes");
        },
      },
      openAiTransport: {
        async chatCompletions() {
          assert.fail("openai transport should not be used for codex routes");
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("anthropic transport should not be used for codex routes");
        },
      },
      codexOAuthTransport: {
        async chatCompletions(input: { body: unknown; authJson?: string | null }) {
          transportBodies.push(input.body);
          transportAuthJson.push(input.authJson);
          return {
            status: 200,
            headers: {
              "x-request-id": "codex_req_assigned_1",
            },
            body: {
              id: "chatcmpl_codex_assigned_1",
              object: "chat.completion",
              model: "gpt-5.4",
              choices: [],
              usage: null,
            },
          };
        },
      },
    } as NonNullable<AppDependencies["proxy"]>,
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/providers/codex_oauth/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...GATEWAY_AUTH_HEADER,
        "content-type": "application/json",
        "x-veslo-session-id": "session_codex_assigned_1",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      id: "chatcmpl_codex_assigned_1",
      object: "chat.completion",
      model: "gpt-5.4",
      choices: [],
      usage: null,
    });
    assert.deepEqual(transportBodies, [
      {
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
      },
    ]);
    assert.deepEqual(transportAuthJson, [secretAuthJson]);
    assert.deepEqual(recordUsageCalls, [
      {
        requestId: "codex_req_assigned_1",
        ownerUserId: "user_gateway",
        provider: "codex_oauth",
        sessionId: "session_codex_assigned_1",
        credentialId: "cred_codex_assigned",
        bindingId: "binding_codex_assigned",
        model: "gpt-5.4",
        inputTokens: undefined,
        outputTokens: undefined,
        cachedTokens: 0,
        totalTokens: undefined,
      },
    ]);
    assert.deepEqual(credentials.listEligibleBindingsCalls, []);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("POST /providers/codex_oauth/v1/chat/completions records an admin alert on upstream network failure", async () => {
  const leases = new InMemoryLeaseRepository();
  const credentials = createCodexCredentialRepository();
  const leaseBroker = new LeaseBroker(leases, new DefaultBindingSelector(credentials as never));
  const alertCalls: Array<Record<string, unknown>> = [];

  const app = createApp({
    proxy: {
      aiAccess: createCodexAiAccess(),
      gatewaySessions: createGatewaySessions(),
      credentials: credentials as never,
      secrets: createCodexSecrets() as never,
      usageRepository: createNoopUsageRepository(),
      leaseBroker,
      tokenBroker: {
        async getUpstreamAuth() {
          assert.fail("token broker should not run for codex worker routes");
        },
      },
      openAiTransport: {
        async chatCompletions() {
          assert.fail("openai transport should not be used for codex routes");
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("anthropic transport should not be used for codex routes");
        },
      },
      codexOAuthTransport: {
        async chatCompletions() {
          const cause = Object.assign(new Error("Connect Timeout Error"), {
            code: "UND_ERR_CONNECT_TIMEOUT",
          });
          throw Object.assign(new TypeError("fetch failed"), { cause });
        },
      },
      alertRepository: {
        async listAlerts() {
          return [];
        },
        async recordProviderFailure(input: Record<string, unknown>) {
          alertCalls.push(input);
        },
      },
    } as NonNullable<AppDependencies["proxy"]>,
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await withMutedConsoleError(async () =>
      fetch(`http://127.0.0.1:${port}/providers/codex_oauth/v1/chat/completions`, {
        method: "POST",
        headers: {
          ...GATEWAY_AUTH_HEADER,
          "content-type": "application/json",
          "x-veslo-session-id": "session_codex_network_1",
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "proxy_request_failed" });
    assert.equal(alertCalls.length, 1);
    assert.deepEqual(alertCalls[0], {
      credentialId: "cred_codex_assigned",
      provider: "codex_oauth",
      sessionId: "session_codex_network_1",
      reason: "network_connect_timeout",
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("POST /providers/codex_oauth/v1/chat/completions repairs assigned access before resolving the binding", async () => {
  const leases = new InMemoryLeaseRepository();
  const credentials = createCodexCredentialRepository();
  const leaseBroker = new LeaseBroker(leases, new DefaultBindingSelector(credentials as never));
  const repairCalls: Array<{ credentialId: string | null }> = [];
  const recordUsageCalls: Array<Record<string, unknown>> = [];
  const transportAuthJson: Array<string | null | undefined> = [];

  const app = createApp({
    proxy: {
      aiAccess: createCodexAiAccess("cred_codex_assigned", "admin_assigned"),
      autoAssignedCodexCredentialRotation: {
        async repairCodexAccess(input: { aiAccess: { credentialId: string | null } }) {
          repairCalls.push(input.aiAccess);
          return {
            ...(await createCodexAiAccess("cred_codex_fallback", "admin_assigned").getUserAiAccess("user_gateway")),
          };
        },
      },
      gatewaySessions: createGatewaySessions(),
      credentials: credentials as never,
      secrets: {
        async get(secretRef: string) {
          return {
            kind: "codex_auth_json",
            authJson: secretRef === "secret_binding_codex_fallback" ? "fallback-auth-json" : "assigned-auth-json",
          };
        },
      } as never,
      usageRepository: {
        async recordUsage(input: Record<string, unknown>) {
          recordUsageCalls.push(input);
        },
      },
      leaseBroker,
      tokenBroker: {
        async getUpstreamAuth() {
          assert.fail("token broker should not run for codex worker routes");
        },
      },
      openAiTransport: {
        async chatCompletions() {
          assert.fail("openai transport should not be used for codex routes");
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("anthropic transport should not be used for codex routes");
        },
      },
      codexOAuthTransport: {
        async chatCompletions(input: { body: unknown; authJson?: string | null }) {
          transportAuthJson.push(input.authJson);
          return {
            status: 200,
            headers: {
              "x-request-id": "codex_req_repaired_1",
            },
            body: {
              id: "chatcmpl_codex_repaired_1",
              object: "chat.completion",
              model: "gpt-5.4",
              choices: [],
              usage: null,
            },
          };
        },
      },
    } as NonNullable<AppDependencies["proxy"]>,
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/providers/codex_oauth/v1/chat/completions`, {
      method: "POST",
      headers: {
        ...GATEWAY_AUTH_HEADER,
        "content-type": "application/json",
        "x-veslo-session-id": "session_codex_repaired_1",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(repairCalls.length, 1);
    assert.equal(repairCalls[0]?.credentialId, "cred_codex_assigned");
    assert.deepEqual(transportAuthJson, ["fallback-auth-json"]);
    assert.deepEqual(recordUsageCalls, [
      {
        requestId: "codex_req_repaired_1",
        ownerUserId: "user_gateway",
        provider: "codex_oauth",
        sessionId: "session_codex_repaired_1",
        credentialId: "cred_codex_fallback",
        bindingId: "binding_codex_fallback",
        model: "gpt-5.4",
        inputTokens: undefined,
        outputTokens: undefined,
        cachedTokens: 0,
        totalTokens: undefined,
      },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("POST /providers/codex_oauth/v1/chat/completions fails when the assigned credential is unavailable", async () => {
  const app = createApp({
    proxy: {
      aiAccess: createCodexAiAccess("cred_codex_missing"),
      gatewaySessions: createGatewaySessions(),
      credentials: {
        async getCredentialRecordById() {
          return null;
        },
        async listHealthyCredentialRecordIds() {
          return [];
        },
        async getCredentialRecordByBindingId() {
          return null;
        },
        async getBindingByCredentialId() {
          return null;
        },
        async markCredentialState() {},
      } as never,
      secrets: {
        async get() {
          assert.fail("secret store should not run when the assigned credential is unavailable");
        },
      } as never,
      usageRepository: createNoopUsageRepository(),
      leaseBroker: {
        async getOrCreateActiveLease() {
          assert.fail("lease broker should not run when the assigned credential is unavailable");
        },
      } as never,
      tokenBroker: {
        async getUpstreamAuth() {
          assert.fail("token broker should not run for codex worker routes");
        },
      },
      openAiTransport: {
        async chatCompletions() {
          assert.fail("openai transport should not be used for codex routes");
        },
      },
      anthropicTransport: {
        async messages() {
          assert.fail("anthropic transport should not be used for codex routes");
        },
      },
      codexOAuthTransport: {
        async chatCompletions() {
          assert.fail("codex transport should not run when the assigned credential is unavailable");
        },
      },
    } as NonNullable<AppDependencies["proxy"]>,
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await withMutedConsoleError(async () =>
      fetch(`http://127.0.0.1:${port}/providers/codex_oauth/v1/chat/completions`, {
        method: "POST",
        headers: {
          ...GATEWAY_AUTH_HEADER,
          "content-type": "application/json",
          "x-veslo-session-id": "session_codex_missing_1",
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "assigned_credential_unavailable" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("POST /providers/openai/v1/chat/completions returns 400 when x-veslo-session-id is missing", async () => {
  const leases = new InMemoryLeaseRepository();
  const selector: BindingSelector = {
    async selectInitialBinding() {
      return "binding_openai_alpha";
    },
    async selectReplacementBinding() {
      return "binding_openai_beta";
    },
  };

  const app = createApp({
    proxy: {
      gatewaySessions: createGatewaySessions(),
      credentials: createCredentialsByBindingId({
        binding_openai_alpha: createCredentialRecord("binding_openai_alpha", "openai"),
      }),
      usageRepository: createNoopUsageRepository(),
      leaseBroker: new LeaseBroker(leases, selector),
      tokenBroker: {
        async getUpstreamAuth() {
          return { kind: "oauth", value: "unused" };
        },
      },
      openAiTransport: {
        async chatCompletions() {
          return { status: 200, body: { ok: true } };
        },
      },
      anthropicTransport: {
        async messages() {
          return { status: 200, body: { ok: true } };
        },
      },
    } as NonNullable<AppDependencies["proxy"]>,
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${port}/providers/openai/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          ...GATEWAY_AUTH_HEADER,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-test", messages: [] }),
      },
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "missing_session_id" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("default app mounts provider proxy routes in runtime startup mode", async () => {
  const app = createApp();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    await withMutedConsoleError(async () => {
      const response = await fetch(
        `http://127.0.0.1:${port}/providers/openai/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-veslo-session-id": "session_runtime_default",
          },
          body: JSON.stringify({ model: "gpt-test", messages: [] }),
        },
      );

      assert.notEqual(response.status, 404);
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});
