import assert from "node:assert/strict";
import test from "node:test";

import { deriveLocalVesloServerUrlFromOpencodeBaseUrl } from "./veslo-server.js";
import { createVesloServerClient } from "./veslo-server.js";

test("deriveLocalVesloServerUrlFromOpencodeBaseUrl rewrites local loopback hosts to Veslo port", () => {
  const derived = deriveLocalVesloServerUrlFromOpencodeBaseUrl("http://127.0.0.1:64792");
  assert.equal(derived, "http://127.0.0.1:8787");
});

test("deriveLocalVesloServerUrlFromOpencodeBaseUrl preserves private LAN host and strips path/query", () => {
  const derived = deriveLocalVesloServerUrlFromOpencodeBaseUrl("http://192.168.0.65:64792/v1?token=x#hash");
  assert.equal(derived, "http://192.168.0.65:8787");
});

test("deriveLocalVesloServerUrlFromOpencodeBaseUrl returns null for non-local hosts", () => {
  const derived = deriveLocalVesloServerUrlFromOpencodeBaseUrl("https://den-worker-dev-dev-cloud-worker-2.onrender.com");
  assert.equal(derived, null);
});

test("deriveLocalVesloServerUrlFromOpencodeBaseUrl accepts explicit target port", () => {
  const derived = deriveLocalVesloServerUrlFromOpencodeBaseUrl("http://localhost:64792", 9999);
  assert.equal(derived, "http://localhost:9999");
});

test("createVesloServerClient exposes getMyAiAccess", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const url = String(input);
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    }

    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      body,
    });

    if (url.endsWith("/ai-gateway/me/ai-access")) {
      return new Response(
        JSON.stringify({
          aiAccess: {
            id: "ai_access_123",
            userId: "user_123",
            enabled: true,
            provider: "openai",
            defaultModel: "gpt-4o-mini",
            allowedModels: ["gpt-4o-mini", "gpt-4.1"],
            updatedAt: "2026-04-08T12:00:00.000Z",
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (url.endsWith("/ai-gateway/providers/anthropic/credentials/cred_anthropic")) {
      return new Response(JSON.stringify({ credential: { id: "cred_anthropic", state: "revoked" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  try {
    const client = createVesloServerClient({
      baseUrl: "http://127.0.0.1:8787",
      token: "veslo-server-token",
      hostToken: "veslo-host-token",
    });

    assert.equal(typeof client.getMyAiAccess, "function");

    const response = await client.getMyAiAccess("den-user-token");

    assert.deepEqual(response, {
      aiAccess: {
        id: "ai_access_123",
        userId: "user_123",
        enabled: true,
        provider: "openai",
        defaultModel: "gpt-4o-mini",
        allowedModels: ["gpt-4o-mini", "gpt-4.1"],
        updatedAt: "2026-04-08T12:00:00.000Z",
      },
    });

    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:8787/ai-gateway/me/ai-access",
        method: "GET",
        headers: {
          authorization: "Bearer veslo-server-token",
          "content-type": "application/json",
          "x-veslo-gateway-authorization": "Bearer den-user-token",
          "x-veslo-host-token": "veslo-host-token",
        },
        body: null,
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
