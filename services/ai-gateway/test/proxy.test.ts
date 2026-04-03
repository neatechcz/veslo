import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { CredentialRecord } from "../src/credentials/repository.js";
import type { UpstreamAuth } from "../src/credentials/token-broker.js";
import type { BindingSelector } from "../src/leases/binding-selector.js";
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

function createCredentialRecord(bindingId: string, provider: "openai" | "anthropic"): CredentialRecord {
  return {
    id: `cred_${bindingId}`,
    ownerUserId: "user_gateway",
    provider,
    credentialType: provider === "openai" ? "oauth" : "api_key",
    state: "healthy",
    secretRef: `secret_${bindingId}`,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    lastFailureAt: null,
  };
}

function createNoopUsageRepository() {
  return {
    async recordUsage() {},
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
