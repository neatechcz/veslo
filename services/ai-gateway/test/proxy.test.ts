import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import type { UpstreamAuth } from "../src/credentials/token-broker.js";
import type {
  CreateSessionLeaseInput,
  LeaseRepository,
  RebindSessionLeaseInput,
  ResolveLeaseInput,
  SessionLease,
} from "../src/leases/repository.js";
import type { BindingSelector } from "../src/leases/binding-selector.js";
import { LeaseBroker } from "../src/leases/lease-broker.js";
import { createApp, type AppDependencies } from "../src/index.js";

class InMemoryLeaseRepository implements LeaseRepository {
  private readonly leasesByKey = new Map<string, SessionLease>();
  private leaseIdCounter = 0;
  public createCalls = 0;

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

  async rebindLease(_input: RebindSessionLeaseInput): Promise<SessionLease | null> {
    return null;
  }
}

function leaseKey(input: ResolveLeaseInput): string {
  return `${input.ownerUserId}:${input.provider}:${input.sessionId}`;
}

test("POST /v1/chat/completions creates and reuses session lease and fetches auth via token broker", async () => {
  const leases = new InMemoryLeaseRepository();
  const selectorCalls = { initial: 0 };

  const selector: BindingSelector = {
    async selectInitialBinding() {
      selectorCalls.initial += 1;
      return "binding_alpha";
    },
    async selectReplacementBinding() {
      return "binding_beta";
    },
  };

  const leaseBroker = new LeaseBroker(leases, selector);
  const tokenBrokerCalls: Array<{ bindingId: string }> = [];
  const transportCalls: Array<{ upstreamAuth: UpstreamAuth; body: unknown }> = [];

  const appDependencies: AppDependencies = {
    proxy: {
      leaseBroker,
      tokenBroker: {
        async getUpstreamAuth(input: { bindingId: string }) {
          tokenBrokerCalls.push(input);
          return { kind: "api-key", value: `secret_for_${input.bindingId}` };
        },
      },
      transport: {
        async chatCompletions(input: { upstreamAuth: UpstreamAuth; body: unknown }) {
          transportCalls.push(input);
          return {
            status: 200,
            body: { id: "cmpl_123", object: "chat.completion", model: "gpt-test" },
          };
        },
      },
    },
  };

  const app = createApp(appDependencies);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/v1/chat/completions`;
    const requestBody = { model: "gpt-test", messages: [{ role: "user", content: "Hello" }] };

    const first = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-veslo-session-id": "session_proxy_1",
      },
      body: JSON.stringify(requestBody),
    });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
      id: "cmpl_123",
      object: "chat.completion",
      model: "gpt-test",
    });

    const second = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-veslo-session-id": "session_proxy_1",
      },
      body: JSON.stringify(requestBody),
    });
    assert.equal(second.status, 200);

    assert.equal(leases.createCalls, 1);
    assert.equal(selectorCalls.initial, 1);
    assert.deepEqual(tokenBrokerCalls, [
      { bindingId: "binding_alpha" },
      { bindingId: "binding_alpha" },
    ]);
    assert.equal(transportCalls.length, 2);
    assert.deepEqual(transportCalls[0]?.upstreamAuth, {
      kind: "api-key",
      value: "secret_for_binding_alpha",
    });
    assert.deepEqual(transportCalls[0]?.body, requestBody);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("POST /v1/chat/completions returns 400 when x-veslo-session-id is missing", async () => {
  const leases = new InMemoryLeaseRepository();
  const selector: BindingSelector = {
    async selectInitialBinding() {
      return "binding_alpha";
    },
    async selectReplacementBinding() {
      return "binding_beta";
    },
  };

  const leaseBroker = new LeaseBroker(leases, selector);
  const app = createApp({
    proxy: {
      leaseBroker,
      tokenBroker: {
        async getUpstreamAuth() {
          return { kind: "api-key", value: "unused" };
        },
      },
      transport: {
        async chatCompletions() {
          return { status: 200, body: { ok: true } };
        },
      },
    },
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", messages: [] }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "missing_session_id" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("POST /v1/chat/completions returns 502 on transport failure", async () => {
  const leases = new InMemoryLeaseRepository();
  const selector: BindingSelector = {
    async selectInitialBinding() {
      return "binding_alpha";
    },
    async selectReplacementBinding() {
      return "binding_beta";
    },
  };

  const leaseBroker = new LeaseBroker(leases, selector);
  const app = createApp({
    proxy: {
      leaseBroker,
      tokenBroker: {
        async getUpstreamAuth() {
          return { kind: "oauth", value: "oauth_token" };
        },
      },
      transport: {
        async chatCompletions() {
          throw new Error("upstream failed");
        },
      },
    },
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-veslo-session-id": "session_proxy_fail",
      },
      body: JSON.stringify({ model: "gpt-test", messages: [] }),
    });

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "proxy_request_failed" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("POST /v1/chat/completions passes upstream headers through", async () => {
  const leases = new InMemoryLeaseRepository();
  const selector: BindingSelector = {
    async selectInitialBinding() {
      return "binding_alpha";
    },
    async selectReplacementBinding() {
      return "binding_beta";
    },
  };

  const leaseBroker = new LeaseBroker(leases, selector);
  const app = createApp({
    proxy: {
      leaseBroker,
      tokenBroker: {
        async getUpstreamAuth() {
          return { kind: "api-key", value: "api_key" };
        },
      },
      transport: {
        async chatCompletions() {
          return {
            status: 200,
            body: { ok: true },
            headers: {
              "x-upstream-request-id": "req_abc",
              "x-provider": "mock",
            },
          };
        },
      },
    },
  });

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-veslo-session-id": "session_proxy_headers",
      },
      body: JSON.stringify({ model: "gpt-test", messages: [] }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-upstream-request-id"), "req_abc");
    assert.equal(response.headers.get("x-provider"), "mock");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("default app mounts proxy route in runtime startup mode", async () => {
  const app = createApp();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-veslo-session-id": "session_runtime_default",
      },
      body: JSON.stringify({ model: "gpt-test", messages: [] }),
    });

    assert.notEqual(response.status, 404);
  } finally {
    server.close();
    await once(server, "close");
  }
});
