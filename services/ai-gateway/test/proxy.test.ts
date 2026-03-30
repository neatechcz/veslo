import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import type { LeaseRepository, RebindSessionLeaseInput, SessionLease } from "../src/leases/repository.js";
import { LeaseBroker, type BindingSelector } from "../src/leases/lease-broker.js";
import { createApp, type AppDependencies } from "../src/index.js";

class InMemoryLeaseRepository implements LeaseRepository {
  private readonly leasesBySession = new Map<string, SessionLease>();
  private leaseIdCounter = 0;
  public createCalls = 0;

  async getActiveLeaseBySessionId(sessionId: string): Promise<SessionLease | null> {
    return this.leasesBySession.get(sessionId) ?? null;
  }

  async createSessionLeaseIfMissing(input: { sessionId: string; activeBindingId: string }): Promise<SessionLease> {
    const existing = this.leasesBySession.get(input.sessionId);
    if (existing) {
      return existing;
    }

    this.createCalls += 1;
    const created: SessionLease = {
      id: `lease_${++this.leaseIdCounter}`,
      sessionId: input.sessionId,
      activeBindingId: input.activeBindingId,
    };
    this.leasesBySession.set(input.sessionId, created);
    return created;
  }

  async rebindSessionLease(_input: RebindSessionLeaseInput): Promise<SessionLease | null> {
    return null;
  }
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
  const transportCalls: Array<{ authValue: string; body: unknown }> = [];

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
        async chatCompletions(input: { authValue: string; body: unknown }) {
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
    assert.equal(transportCalls[0]?.authValue, "secret_for_binding_alpha");
    assert.deepEqual(transportCalls[0]?.body, requestBody);
  } finally {
    server.close();
    await once(server, "close");
  }
});
