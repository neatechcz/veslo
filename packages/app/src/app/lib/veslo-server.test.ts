import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVesloBundleInviteUrl,
  buildVesloConnectInviteUrl,
  createVesloServerClient,
  DEFAULT_VESLO_CONNECT_APP_URL,
  deriveLocalVesloServerUrlFromOpencodeBaseUrl,
  requestManagedAiAccessBundle,
  resolveSessionArchiveClientOptions,
} from "./veslo-server.js";

const LOCAL_SESSION_ARCHIVE_OWNER_KEY = "local:desktop";

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

test("Veslo connect invite defaults to the owned web app", () => {
  assert.equal(DEFAULT_VESLO_CONNECT_APP_URL, "https://app.veslo.work");

  const url = buildVesloConnectInviteUrl({
    workspaceUrl: "https://worker.example.test",
    token: "token_123",
  });

  assert.equal(new URL(url).origin, "https://app.veslo.work");
});

test("Veslo bundle invite defaults to the owned web app", () => {
  const url = buildVesloBundleInviteUrl({
    bundleUrl: "https://share.example.test/b/bundle_123",
  });

  assert.equal(new URL(url).origin, "https://app.veslo.work");
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

test("resolveSessionArchiveClientOptions allows local archive state without a cloud account", () => {
  const resolved = resolveSessionArchiveClientOptions({
    accountId: null,
    activeBaseUrl: "http://127.0.0.1:8787",
    activeToken: " local-client-token ",
    settingsUrl: "https://veslo.example",
    settingsToken: "remote-token",
  });

  assert.deepEqual(resolved, {
    baseUrl: "http://127.0.0.1:8787",
    token: "local-client-token",
    accountId: LOCAL_SESSION_ARCHIVE_OWNER_KEY,
  });
});

test("resolveSessionArchiveClientOptions rejects remote archive state without a cloud account", () => {
  const resolved = resolveSessionArchiveClientOptions({
    accountId: null,
    activeBaseUrl: "https://veslo.example",
    activeToken: "remote-token",
    settingsUrl: "https://settings.veslo.example",
    settingsToken: "settings-token",
  });

  assert.equal(resolved, null);
});

test("resolveSessionArchiveClientOptions does not fall back to local settings after a remote archive endpoint without an account", () => {
  const resolved = resolveSessionArchiveClientOptions({
    accountId: null,
    activeBaseUrl: "https://veslo.example",
    activeToken: "remote-token",
    settingsUrl: "http://127.0.0.1:8787",
    settingsToken: "local-client-token",
  });

  assert.equal(resolved, null);
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

test("requestManagedAiAccessBundle fetches the raw managed gateway bundle with the DEN bearer token", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string; headers: Headers; body: string | null }> = [];

  globalThis.fetch = async (input, init) => {
    const body = init?.body;
    calls.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body: typeof body === "string" ? body : null,
    });
    return new Response(
      JSON.stringify({
        accessToken: "gateway-access-token",
        aiAccess: {
          id: "ai_access_123",
          userId: "user_123",
          enabled: true,
          provider: "codex_oauth",
          defaultModel: "gpt-5.4",
          allowedModels: ["gpt-5.4"],
          updatedAt: "2026-04-24T08:00:00.000Z",
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const response = await requestManagedAiAccessBundle(
      "https://veslo-ai-gateway-dev.onrender.com",
      "den-user-token",
    );

    assert.deepEqual(response, {
      accessToken: "gateway-access-token",
      aiAccess: {
        id: "ai_access_123",
        userId: "user_123",
        enabled: true,
        provider: "codex_oauth",
        defaultModel: "gpt-5.4",
        allowedModels: ["gpt-5.4"],
        updatedAt: "2026-04-24T08:00:00.000Z",
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://veslo-ai-gateway-dev.onrender.com/api/me/ai-access");
    assert.equal(calls[0]?.method, "GET");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer den-user-token");
    assert.equal(calls[0]?.headers.get("content-type"), "application/json");
    assert.equal(calls[0]?.body, null);
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

test("listHubMcp forwards den auth context headers when provided", async () => {
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

    await client.listHubMcp({
      denToken: "den-token",
      denOrgId: "org_123",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://veslo.example/hub/mcp");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer token-123");
    assert.equal(calls[0]?.headers.get("x-veslo-den-token"), "den-token");
    assert.equal(calls[0]?.headers.get("x-veslo-den-org-id"), "org_123");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("installHubMcp forwards den auth context headers when provided", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Headers; method?: string }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers as HeadersInit | undefined),
    });
    return new Response(JSON.stringify({ ok: true, name: "demo", path: "opencode.json" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
    });

    await client.installHubMcp("workspace-1", "catalog-item", {
      denToken: "den-token",
      denOrgId: "org_123",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://veslo.example/workspace/workspace-1/mcp/hub/catalog-item");
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer token-123");
    assert.equal(calls[0]?.headers.get("x-veslo-den-token"), "den-token");
    assert.equal(calls[0]?.headers.get("x-veslo-den-org-id"), "org_123");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("createVesloServerClient exposes getMyAiAccess", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const timeoutDelays: number[] = [];

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
          accessToken: "managed-gateway-token",
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
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    timeoutDelays.push(Number(timeout));
    return originalSetTimeout(handler, timeout, ...args);
  }) as typeof setTimeout;

  try {
    const client = createVesloServerClient({
      baseUrl: "http://127.0.0.1:8787",
      token: "veslo-server-token",
      hostToken: "veslo-host-token",
    });

    assert.equal(typeof client.getMyAiAccess, "function");

    const response = await client.getMyAiAccess("den-user-token");

    assert.deepEqual(response, {
      accessToken: "managed-gateway-token",
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
    assert.equal(timeoutDelays[0], 30_000);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});
