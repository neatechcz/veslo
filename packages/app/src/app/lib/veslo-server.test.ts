import assert from "node:assert/strict";
import test from "node:test";

import {
  createVesloServerClient,
  deriveLocalVesloServerUrlFromOpencodeBaseUrl,
  resolveSessionArchiveClientOptions,
} from "./veslo-server.js";

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

test("resolveSessionArchiveClientOptions prefers active server credentials", () => {
  const resolved = resolveSessionArchiveClientOptions({
    accountId: " usr_123 ",
    activeBaseUrl: "active.veslo.example/ ",
    activeToken: " active-token ",
    settingsUrl: "settings.veslo.example",
    settingsToken: "settings-token",
    cloudUrl: "cloud.veslo.example",
    cloudToken: "cloud-token",
  });

  assert.deepEqual(resolved, {
    baseUrl: "http://active.veslo.example",
    token: "active-token",
    accountId: "usr_123",
  });
});

test("resolveSessionArchiveClientOptions falls back to stored settings when active auth is unavailable", () => {
  const resolved = resolveSessionArchiveClientOptions({
    accountId: "usr_123",
    activeBaseUrl: "http://127.0.0.1:8787",
    activeToken: " ",
    settingsUrl: "settings.veslo.example/",
    settingsToken: "settings-token",
    cloudUrl: "cloud.veslo.example",
    cloudToken: "cloud-token",
  });

  assert.deepEqual(resolved, {
    baseUrl: "http://settings.veslo.example",
    token: "settings-token",
    accountId: "usr_123",
  });
});

test("session archive requests include the account id header", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Headers }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers as HeadersInit | undefined),
    });
    return new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
      accountId: "usr_123",
    });

    await client.listSessionArchives();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://veslo.example/session-archives");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer token-123");
    assert.equal(calls[0]?.headers.get("x-veslo-account-id"), "usr_123");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("non-archive requests do not include the account id header", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Headers }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers as HeadersInit | undefined),
    });
    return new Response(JSON.stringify({ items: [], activeId: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
      accountId: "usr_123",
    });

    await client.listWorkspaces();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://veslo.example/workspaces");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer token-123");
    assert.equal(calls[0]?.headers.has("x-veslo-account-id"), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("listHubSkills forwards den auth context headers when provided", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Headers }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers as HeadersInit | undefined),
    });
    return new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
    });

    await client.listHubSkills({
      denToken: "den-token",
      denOrgId: "org_123",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://veslo.example/hub/skills");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer token-123");
    assert.equal(calls[0]?.headers.get("x-veslo-den-token"), "den-token");
    assert.equal(calls[0]?.headers.get("x-veslo-den-org-id"), "org_123");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
