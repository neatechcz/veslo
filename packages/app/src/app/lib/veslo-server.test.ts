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

test("createVesloServerClient exposes startOpenAiOAuth, finishOpenAiOAuth, saveAnthropicApiKey, listGatewayCredentials, revokeGatewayCredential", async () => {
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

    if (url.endsWith("/ai-gateway/providers/openai/oauth/start")) {
      return new Response(JSON.stringify({ authorizeUrl: "https://openai.example.test/oauth" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/ai-gateway/providers/openai/oauth/callback")) {
      return new Response(JSON.stringify({ credential: { id: "cred_openai" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/ai-gateway/providers/anthropic/api-keys")) {
      return new Response(JSON.stringify({ credential: { id: "cred_anthropic" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/ai-gateway/providers/anthropic/credentials")) {
      return new Response(JSON.stringify({ credentials: [{ id: "cred_anthropic" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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

    assert.equal(typeof client.startOpenAiOAuth, "function");
    assert.equal(typeof client.finishOpenAiOAuth, "function");
    assert.equal(typeof client.saveAnthropicApiKey, "function");
    assert.equal(typeof client.listGatewayCredentials, "function");
    assert.equal(typeof client.revokeGatewayCredential, "function");

    await client.startOpenAiOAuth("den-user-token");
    await client.finishOpenAiOAuth("den-user-token", "oauth-code-123");
    await client.saveAnthropicApiKey("den-user-token", "sk-ant-secret");
    await client.listGatewayCredentials("den-user-token", "anthropic");
    await client.revokeGatewayCredential("den-user-token", "anthropic", "cred_anthropic");

    assert.deepEqual(calls, [
      {
        url: "http://127.0.0.1:8787/ai-gateway/providers/openai/oauth/start",
        method: "POST",
        headers: {
          authorization: "Bearer veslo-server-token",
          "content-type": "application/json",
          "x-veslo-gateway-authorization": "Bearer den-user-token",
          "x-veslo-host-token": "veslo-host-token",
        },
        body: {},
      },
      {
        url: "http://127.0.0.1:8787/ai-gateway/providers/openai/oauth/callback",
        method: "POST",
        headers: {
          authorization: "Bearer veslo-server-token",
          "content-type": "application/json",
          "x-veslo-gateway-authorization": "Bearer den-user-token",
          "x-veslo-host-token": "veslo-host-token",
        },
        body: { code: "oauth-code-123" },
      },
      {
        url: "http://127.0.0.1:8787/ai-gateway/providers/anthropic/api-keys",
        method: "POST",
        headers: {
          authorization: "Bearer veslo-server-token",
          "content-type": "application/json",
          "x-veslo-gateway-authorization": "Bearer den-user-token",
          "x-veslo-host-token": "veslo-host-token",
        },
        body: { apiKey: "sk-ant-secret" },
      },
      {
        url: "http://127.0.0.1:8787/ai-gateway/providers/anthropic/credentials",
        method: "GET",
        headers: {
          authorization: "Bearer veslo-server-token",
          "content-type": "application/json",
          "x-veslo-gateway-authorization": "Bearer den-user-token",
          "x-veslo-host-token": "veslo-host-token",
        },
        body: null,
      },
      {
        url: "http://127.0.0.1:8787/ai-gateway/providers/anthropic/credentials/cred_anthropic",
        method: "DELETE",
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
