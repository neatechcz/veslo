import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { createApp } from "../src/index.js";

test("GET /health returns service health payload", async () => {
  const app = createApp();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: "ai-gateway" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("GET /readiness reports unavailable when provider reachability fails", async () => {
  const app = createApp({
    readiness: {
      fetchImpl: async () => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("Connect Timeout Error"), {
            code: "UND_ERR_CONNECT_TIMEOUT",
          }),
        });
      },
      credentials: {
        async listHealthyCredentialRecordIds() {
          return ["cred_ready_1"];
        },
      },
      aiAccess: {
        async countEnabledPolicies() {
          return 1;
        },
      },
    },
  } as never);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/readiness`);

    assert.equal(response.status, 503);
    const payload = await response.json() as {
      ok: boolean;
      service: string;
      status: string;
      checks: {
        providerReachability: {
          ok: boolean;
          probes: Array<{ ok: boolean; reason?: string }>;
        };
        credentials: { ok: boolean; healthyCredentialCount: number };
        aiAccessPolicies: { ok: boolean; enabledPolicyCount: number };
      };
    };

    assert.equal(payload.ok, false);
    assert.equal(payload.service, "ai-gateway");
    assert.equal(payload.status, "not_ready");
    assert.equal(payload.checks.providerReachability.ok, false);
    assert.equal(payload.checks.providerReachability.probes[0]?.ok, false);
    assert.equal(payload.checks.providerReachability.probes[0]?.reason, "network_connect_timeout");
    assert.deepEqual(payload.checks.credentials, { ok: true, healthyCredentialCount: 1 });
    assert.deepEqual(payload.checks.aiAccessPolicies, { ok: true, enabledPolicyCount: 1 });
  } finally {
    server.close();
    await once(server, "close");
  }
});
