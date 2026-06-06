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

test("automation requests encode workspace and automation ids", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method });
    return new Response(JSON.stringify({ items: [], updatedAt: "2026-06-05T10:00:00.000Z" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
    });

    await client.listAutomations("ws 1");
    await client.createAutomation("ws 1", {
      name: "Daily plan",
      prompt: "Plan the day",
      schedule: { kind: "daily", hour: 8, minute: 30 },
    });
    await client.updateAutomation("ws 1", "auto 1", { enabled: false, status: "paused" });
    await client.runAutomation("ws 1", "auto 1");
    await client.listAutomationRuns("ws 1", "auto 1");

    assert.deepEqual(
      calls.map((call) => ({ url: call.url, method: call.method ?? "GET" })),
      [
        { url: "https://veslo.example/workspace/ws%201/automations", method: "GET" },
        { url: "https://veslo.example/workspace/ws%201/automations", method: "POST" },
        { url: "https://veslo.example/workspace/ws%201/automations/auto%201", method: "PATCH" },
        { url: "https://veslo.example/workspace/ws%201/automations/auto%201/run", method: "POST" },
        { url: "https://veslo.example/workspace/ws%201/automations/auto%201/runs", method: "GET" },
      ],
    );
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

test("Soul read methods forward Den context headers", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string; headers: Headers; body: string | null }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body: typeof init?.body === "string" ? init.body : null,
    });
    return new Response(JSON.stringify({ organization: null, user: null, workspaces: [], versions: [], version: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
      hostToken: "host-token-123",
    });
    const den = {
      denApiBase: "https://api.veslo.work",
      denToken: "den-token",
      denOrgId: "org_1",
      denUserId: "user_1",
    };

    await client.getSoulOverview(den);
    await client.getOrganizationSoul(den);
    await client.getUserSoul(den);
    await client.listSoulVersions("organization", { ...den, cursor: "next/cursor", limit: 25 });
    await client.getSoulVersion("user", "version_1", den);

    assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${call.url}`), [
      "GET https://veslo.example/soul",
      "GET https://veslo.example/soul/organization",
      "GET https://veslo.example/soul/user",
      "GET https://veslo.example/soul/organization/versions?cursor=next%2Fcursor&limit=25",
      "GET https://veslo.example/soul/user/versions/version_1",
    ]);
    for (const call of calls) {
      assert.equal(call.headers.get("authorization"), "Bearer token-123");
      assert.equal(call.headers.get("x-veslo-host-token"), "host-token-123");
      assert.equal(call.headers.get("x-veslo-den-api-base"), "https://api.veslo.work");
      assert.equal(call.headers.get("x-veslo-den-token"), "den-token");
      assert.equal(call.headers.get("x-veslo-den-org-id"), "org_1");
      assert.equal(call.headers.get("x-veslo-den-user-id"), "user_1");
      assert.equal(call.body, null);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Soul workspace read methods include workspace routes and version query", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string; body: string | null }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : null,
    });
    return new Response(JSON.stringify({ workspaces: [], document: null, summary: null, versions: [], version: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
    });

    await client.listWorkspaceSouls();
    await client.getWorkspaceSoul("workspace 1");
    await client.listSoulVersions("workspace", { workspaceId: "workspace 1" });
    await client.getSoulVersion("workspace", "version 1", { workspaceId: "workspace 1" });

    assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${call.url}`), [
      "GET https://veslo.example/soul/workspaces",
      "GET https://veslo.example/workspace/workspace%201/soul",
      "GET https://veslo.example/soul/workspace/versions?workspaceId=workspace+1",
      "GET https://veslo.example/soul/workspace/versions/version%201?workspaceId=workspace+1",
    ]);
    assert.deepEqual(calls.map((call) => call.body), [null, null, null, null]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Soul mutation methods send exact bodies and Den context", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string; headers: Headers; body: string | null }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body: typeof init?.body === "string" ? init.body : null,
    });
    return new Response(JSON.stringify({ document: null, summary: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
    });
    const den = {
      denApiBase: "https://api.veslo.work",
      denToken: "den-token",
      denOrgId: "org_1",
      denUserId: "user_1",
    };

    await client.updateOrganizationSoul({
      ...den,
      content: "# Org",
      changeSummary: "Update org",
      baseVersionId: null,
    });
    await client.updateUserSoul({
      ...den,
      content: "# User",
      changeSummary: "Update user",
      baseVersionId: "user_v1",
    });
    await client.restoreOrganizationSoulVersion("org_v1", { ...den, changeSummary: "Restore org" });
    await client.restoreUserSoulVersion("user_v1", { ...den, changeSummary: "Restore user" });

    assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${call.url}`), [
      "PATCH https://veslo.example/soul/organization",
      "PATCH https://veslo.example/soul/user",
      "POST https://veslo.example/soul/organization/versions/org_v1/restore",
      "POST https://veslo.example/soul/user/versions/user_v1/restore",
    ]);
    assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
      content: "# Org",
      changeSummary: "Update org",
      baseVersionId: null,
    });
    assert.deepEqual(JSON.parse(calls[1]?.body ?? "{}"), {
      content: "# User",
      changeSummary: "Update user",
      baseVersionId: "user_v1",
    });
    assert.deepEqual(JSON.parse(calls[2]?.body ?? "{}"), { changeSummary: "Restore org" });
    assert.deepEqual(JSON.parse(calls[3]?.body ?? "{}"), { changeSummary: "Restore user" });
    for (const call of calls) {
      assert.equal(call.headers.get("x-veslo-den-api-base"), "https://api.veslo.work");
      assert.equal(call.headers.get("x-veslo-den-token"), "den-token");
      assert.equal(call.headers.get("x-veslo-den-org-id"), "org_1");
      assert.equal(call.headers.get("x-veslo-den-user-id"), "user_1");
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Soul workspace mutations send update restore and heartbeat bodies", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string; headers: Headers; body: string | null }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body: typeof init?.body === "string" ? init.body : null,
    });
    return new Response(JSON.stringify({ document: null, summary: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
    });

    await client.updateWorkspaceSoul("workspace 1", {
      content: "# Workspace",
      changeSummary: "Update workspace",
      baseVersionId: null,
    });
    await client.restoreWorkspaceSoulVersion("workspace 1", "workspace_v1", {
      changeSummary: "Restore workspace",
    });
    await client.setWorkspaceSoulHeartbeat("workspace 1", true, {
      denToken: "den-token",
      denOrgId: "org_1",
      denUserId: "user_1",
    });

    assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${call.url}`), [
      "PATCH https://veslo.example/workspace/workspace%201/soul",
      "POST https://veslo.example/workspace/workspace%201/soul/versions/workspace_v1/restore",
      "POST https://veslo.example/workspace/workspace%201/soul/heartbeat-toggle",
    ]);
    assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
      content: "# Workspace",
      changeSummary: "Update workspace",
      baseVersionId: null,
    });
    assert.deepEqual(JSON.parse(calls[1]?.body ?? "{}"), { changeSummary: "Restore workspace" });
    assert.deepEqual(JSON.parse(calls[2]?.body ?? "{}"), { enabled: true });
    assert.equal(calls[2]?.headers.get("x-veslo-den-token"), "den-token");
    assert.equal(calls[2]?.headers.get("x-veslo-den-org-id"), "org_1");
    assert.equal(calls[2]?.headers.get("x-veslo-den-user-id"), "user_1");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

const registrySkill = (overrides: Record<string, unknown> = {}) => ({
  id: "skill_research",
  slug: "research",
  name: "research",
  description: "Research assistant",
  tags: ["automation"],
  visibility: "personal",
  reviewStatus: "approved",
  createdAt: "2026-05-26T10:00:00.000Z",
  updatedAt: "2026-05-26T10:01:00.000Z",
  latestVersion: {
    id: "version_research_1",
    version: "1.0.0",
    packageSha256: "a".repeat(64),
    createdAt: "2026-05-26T10:00:00.000Z",
  },
  ...overrides,
});

test("searchRegistrySkills encodes supported filters and normalizes scored results", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Headers }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers as HeadersInit | undefined),
    });
    return new Response(
      JSON.stringify({
        query: "agent workflows",
        skills: [
          registrySkill({
            score: 0.86,
            matchedFields: ["name", "metadata.trigger"],
          }),
        ],
        nextCursor: "next/cursor",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example/",
      token: "token-123",
      hostToken: "host-token-123",
    });

    const result = await client.searchRegistrySkills({
      q: " agent workflows ",
      workspaceId: " workspace_a ",
      owner: "user",
      approvalStatus: "approved",
      includeDeleted: true,
      language: " cs ",
      cursor: " next/cursor ",
      limit: 25,
    });

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.url,
      "https://veslo.example/v1/skills/search?q=agent+workflows&workspaceId=workspace_a&ownerScope=user&reviewStatus=approved&includeDeleted=true&language=cs&cursor=next%2Fcursor&limit=25",
    );
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer token-123");
    assert.equal(calls[0]?.headers.get("x-veslo-host-token"), "host-token-123");
    assert.deepEqual(result, {
      query: "agent workflows",
      skills: [
        {
          id: "skill_research",
          slug: "research",
          name: "research",
          description: "Research assistant",
          tags: ["automation"],
          visibility: "personal",
          reviewStatus: "approved",
          createdAt: "2026-05-26T10:00:00.000Z",
          updatedAt: "2026-05-26T10:01:00.000Z",
          latestVersion: {
            id: "version_research_1",
            version: "1.0.0",
            packageSha256: "a".repeat(64),
            createdAt: "2026-05-26T10:00:00.000Z",
          },
          score: 0.86,
          matchedFields: ["name", "metadata.trigger"],
        },
      ],
      nextCursor: "next/cursor",
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("searchRegistrySkills accepts scope and reviewStatus aliases", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string }> = [];

  globalThis.fetch = async (input) => {
    calls.push({ url: String(input) });
    return new Response(JSON.stringify({ query: "approval", skills: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
    });

    await client.searchRegistrySkills({
      q: "approval",
      scope: "org",
      reviewStatus: "pending_review",
      includeDeleted: false,
    });

    assert.equal(
      calls[0]?.url,
      "https://veslo.example/v1/skills/search?q=approval&ownerScope=org&reviewStatus=pending_review&includeDeleted=false",
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("searchRegistrySkills rejects invalid registry search payloads", async () => {
  const previousFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        query: "agent",
        skills: [
          registrySkill({
            visibility: "public",
          }),
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
    });

    await assert.rejects(
      () => client.searchRegistrySkills({ q: "agent" }),
      (error) => {
        assert.equal((error as { code?: unknown }).code, "skill_registry_invalid_payload");
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("registry mutation helpers call local server with host auth and Den context", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string; headers: Headers; body?: string | null }> = [];

  const responses = [
    {
      skill: registrySkill({ id: "skill_demo", slug: "demo", name: "demo" }),
    },
    {
      version: {
        id: "version_demo_1",
        version: "1.0.0",
        packageSha256: "a".repeat(64),
        createdAt: "2026-05-26T10:00:00.000Z",
      },
    },
    {
      installation: {
        installationId: "installation_demo_1",
        skillId: "skill_demo",
        versionId: "version_demo_1",
        enabled: true,
        source: "workspace",
        installedAt: "2026-05-26T10:01:00.000Z",
      },
    },
  ];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    });
    return new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
      hostToken: "host-token-123",
    });

    await client.createRegistrySkill({
      scope: "workspace",
      name: "demo",
      workspaceId: "workspace_1",
      denToken: "den-token",
      denOrgId: "org_1",
      denUserId: "user_1",
    });
    await client.createRegistrySkillVersion("skill_demo", {
      package: { schemaVersion: 1, entrypoint: "SKILL.md" },
      denToken: "den-token",
      denOrgId: "org_1",
      denUserId: "user_1",
    });
    await client.createRegistrySkillInstallation({
      scope: "workspace",
      skillId: "skill_demo",
      versionId: "version_demo_1",
      workspaceId: "workspace_1",
      updatePolicy: "pinned",
      denToken: "den-token",
      denOrgId: "org_1",
      denUserId: "user_1",
    });

    assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${call.url}`), [
      "POST https://veslo.example/v1/skills",
      "POST https://veslo.example/v1/skills/skill_demo/versions",
      "POST https://veslo.example/v1/skill-installations",
    ]);
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer token-123");
    assert.equal(calls[0]?.headers.get("x-veslo-host-token"), "host-token-123");
    assert.equal(calls[0]?.headers.get("x-veslo-den-token"), "den-token");
    assert.equal(calls[0]?.headers.get("x-veslo-den-org-id"), "org_1");
    assert.equal(calls[0]?.headers.get("x-veslo-den-user-id"), "user_1");
    assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
      scope: "workspace",
      name: "demo",
      workspaceId: "workspace_1",
    });
    assert.deepEqual(JSON.parse(calls[1]?.body ?? "{}"), {
      package: { schemaVersion: 1, entrypoint: "SKILL.md" },
    });
    assert.deepEqual(JSON.parse(calls[2]?.body ?? "{}"), {
      scope: "workspace",
      skillId: "skill_demo",
      versionId: "version_demo_1",
      workspaceId: "workspace_1",
      updatePolicy: "pinned",
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("registry version and installation helpers call local server mutation routes", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string; headers: Headers; body?: string | null }> = [];
  const responses = [
    {
      versions: [
        {
          id: "version_demo_2",
          version: "2.0.0",
          packageSha256: "b".repeat(64),
          createdAt: "2026-05-26T10:00:00.000Z",
        },
      ],
      nextCursor: null,
    },
    {
      installation: {
        installationId: "installation_demo_1",
        skillId: "skill_demo",
        versionId: "version_demo_2",
        enabled: false,
        source: "workspace",
        installedAt: "2026-05-26T10:01:00.000Z",
      },
    },
    {
      installation: {
        installationId: "installation_demo_1",
        skillId: "skill_demo",
        versionId: "version_demo_2",
        enabled: false,
        source: "workspace",
        installedAt: "2026-05-26T10:01:00.000Z",
      },
    },
    {
      installation: {
        installationId: "installation_demo_1",
        skillId: "skill_demo",
        versionId: "version_demo_2",
        enabled: true,
        source: "workspace",
        installedAt: "2026-05-26T10:01:00.000Z",
      },
    },
    {
      requestId: "review_1",
      skillId: "skill_demo",
      status: "pending_review",
      createdAt: "2026-05-26T10:02:00.000Z",
    },
    {
      workspaceId: "workspace_1",
      skillSetId: "set_1",
      revision: "rev_2",
      skills: [],
    },
    {
      requestId: "review_1",
      skillId: "skill_demo",
      status: "approved",
      createdAt: "2026-05-26T10:02:00.000Z",
    },
    {
      requestId: "review_2",
      skillId: "skill_demo",
      status: "rejected",
      createdAt: "2026-05-26T10:02:00.000Z",
    },
  ];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    });
    return new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
      hostToken: "host-token-123",
    });

    await client.listRegistrySkillVersions("skill_demo", {
      cursor: "next/cursor",
      limit: 10,
      denOrgId: "org_1",
    });
    await client.updateRegistrySkillInstallation("installation_demo_1", {
      enabled: false,
      versionId: "version_demo_2",
      releaseChannel: null,
      denOrgId: "org_1",
    });
    await client.deleteRegistrySkillInstallation("installation_demo_1", { denOrgId: "org_1" });
    await client.restoreRegistrySkillInstallation("installation_demo_1", {
      workspaceId: "workspace_1",
      versionId: "version_demo_2",
      denOrgId: "org_1",
    });
    await client.createRegistrySkillReviewRequest("skill_demo", {
      scope: "org",
      versionId: "version_demo_2",
      orgId: "org_1",
      reason: "Ready",
      denOrgId: "org_1",
    });
    await client.replaceRegistryWorkspaceSkillSet("workspace_1", {
      orgId: "org_1",
      releaseChannel: "stable",
      skills: [{ installationId: "installation_demo_1", desiredVersionId: "version_demo_2" }],
      denOrgId: "org_1",
    });
    await client.approveRegistrySkillReviewRequest("review_1", {
      reviewerNote: "Approved",
      releaseChannel: "stable",
      denOrgId: "org_1",
    });
    await client.rejectRegistrySkillReviewRequest("review_2", {
      reviewerNote: "Needs docs",
      denOrgId: "org_1",
    });

    assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${call.url}`), [
      "GET https://veslo.example/v1/skills/skill_demo/versions?cursor=next%2Fcursor&limit=10",
      "PATCH https://veslo.example/v1/skill-installations/installation_demo_1",
      "DELETE https://veslo.example/v1/skill-installations/installation_demo_1",
      "POST https://veslo.example/v1/skill-installations/installation_demo_1/restore",
      "POST https://veslo.example/v1/skills/skill_demo/review-requests",
      "PATCH https://veslo.example/v1/workspaces/workspace_1/skill-set",
      "POST https://veslo.example/v1/skill-review-requests/review_1/approve",
      "POST https://veslo.example/v1/skill-review-requests/review_2/reject",
    ]);
    assert.equal(calls[0]?.headers.get("x-veslo-den-org-id"), "org_1");
    assert.deepEqual(JSON.parse(calls[1]?.body ?? "{}"), {
      enabled: false,
      versionId: "version_demo_2",
      releaseChannel: null,
    });
    assert.deepEqual(JSON.parse(calls[3]?.body ?? "{}"), {
      workspaceId: "workspace_1",
      versionId: "version_demo_2",
    });
    assert.deepEqual(JSON.parse(calls[4]?.body ?? "{}"), {
      scope: "org",
      versionId: "version_demo_2",
      orgId: "org_1",
      reason: "Ready",
    });
    assert.deepEqual(JSON.parse(calls[5]?.body ?? "{}"), {
      orgId: "org_1",
      releaseChannel: "stable",
      skills: [{ installationId: "installation_demo_1", desiredVersionId: "version_demo_2" }],
    });
    assert.deepEqual(JSON.parse(calls[6]?.body ?? "{}"), {
      reviewerNote: "Approved",
      releaseChannel: "stable",
    });
    assert.deepEqual(JSON.parse(calls[7]?.body ?? "{}"), {
      reviewerNote: "Needs docs",
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("rollout policy helpers call local server routes with host auth and Den context", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string; headers: Headers; body?: string | null }> = [];
  const policy = {
    id: "rollout_1",
    skillId: "skill_demo",
    versionId: "version_demo_1",
    target: "user-global",
    audience: "user",
    catalogScope: "organization",
    orgId: "org_1",
    userId: "user_1",
    enabled: true,
    updatePolicy: "pinned",
    removalPolicy: "locked",
    createdAt: "2026-05-30T10:00:00.000Z",
    updatedAt: "2026-05-30T10:01:00.000Z",
  };
  const responses = [
    {
      policies: [policy],
      nextCursor: null,
    },
    {
      policy,
    },
    {
      policy: {
        ...policy,
        enabled: false,
        versionId: null,
        updatePolicy: "release_channel",
        releaseChannel: "stable",
      },
    },
    {
      policy: {
        ...policy,
        enabled: false,
      },
    },
  ];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    });
    return new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
      hostToken: "host-token-123",
    });

    await client.listRegistrySkillRolloutPolicies({
      target: "user-global",
      audience: "user",
      workspaceId: "workspace_1",
      cursor: "next/cursor",
      limit: 25,
      denToken: "den-token",
      denOrgId: "org_1",
      denUserId: "user_1",
    });
    await client.createRegistrySkillRolloutPolicy({
      skillId: "skill_demo",
      versionId: "version_demo_1",
      target: "user-global",
      audience: "user",
      userId: "user_1",
      catalogScope: "organization",
      orgId: "org_1",
      enabled: false,
      updatePolicy: "pinned",
      removalPolicy: "locked",
      denToken: "den-token",
      denOrgId: "org_1",
      denUserId: "user_1",
    });
    await client.updateRegistrySkillRolloutPolicy("rollout_1", {
      enabled: false,
      versionId: null,
      updatePolicy: "release_channel",
      releaseChannel: "stable",
      denToken: "den-token",
      denOrgId: "org_1",
      denUserId: "user_1",
    });
    await client.deleteRegistrySkillRolloutPolicy("rollout_1", {
      denToken: "den-token",
      denOrgId: "org_1",
      denUserId: "user_1",
    });

    assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${call.url}`), [
      "GET https://veslo.example/v1/skill-rollout-policies?cursor=next%2Fcursor&limit=25&target=user-global&audience=user&workspaceId=workspace_1",
      "POST https://veslo.example/v1/skill-rollout-policies",
      "PATCH https://veslo.example/v1/skill-rollout-policies/rollout_1",
      "DELETE https://veslo.example/v1/skill-rollout-policies/rollout_1",
    ]);
    assert.equal(calls[1]?.headers.get("authorization"), "Bearer token-123");
    assert.equal(calls[1]?.headers.get("x-veslo-host-token"), "host-token-123");
    assert.equal(calls[1]?.headers.get("x-veslo-den-token"), "den-token");
    assert.equal(calls[1]?.headers.get("x-veslo-den-org-id"), "org_1");
    assert.equal(calls[1]?.headers.get("x-veslo-den-user-id"), "user_1");
    assert.deepEqual(JSON.parse(calls[1]?.body ?? "{}"), {
      skillId: "skill_demo",
      versionId: "version_demo_1",
      target: "user-global",
      audience: "user",
      catalogScope: "organization",
      orgId: "org_1",
      userId: "user_1",
      enabled: false,
      updatePolicy: "pinned",
      removalPolicy: "locked",
    });
    assert.deepEqual(JSON.parse(calls[2]?.body ?? "{}"), {
      enabled: false,
      versionId: null,
      updatePolicy: "release_channel",
      releaseChannel: "stable",
    });
    assert.equal(calls[3]?.body, null);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("skill materialization helpers call workspace and global status and sync endpoints", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; headers: Headers; body: string | null }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body: typeof init?.body === "string" ? init.body : null,
    });
    const url = new URL(String(input));
    if (url.pathname === "/skills/materialization") {
      return new Response(
        JSON.stringify({
          scope: "personal-global",
          status: "current",
          registryConfigured: true,
          rootDir: "/home/user/.config/opencode/skills/veslo-managed",
          materializedSkills: [
            {
              name: "veslo-automations",
              packageSha256: "b".repeat(64),
              source: "platform",
              removalPolicy: "locked",
            },
          ],
          platformManaged: {
            enabled: true,
            synced: false,
            desiredSkills: [
              {
                installationId: "platform_install_veslo_automations",
                skillId: "platform_skill_veslo_automations",
                name: "veslo-automations",
                versionId: "platform_version_veslo_automations_v1",
                packageSha256: "b".repeat(64),
                source: "platform",
                removalPolicy: "locked",
                target: "personal-global",
              },
            ],
          },
          reloadRequired: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname === "/skills/materialization/sync-global") {
      return new Response(
        JSON.stringify({
          scope: "personal-global",
          status: "synced",
          registryConfigured: true,
          rootDir: "/home/user/.config/opencode/skills/veslo-managed",
          materializedSkills: [],
          synced: true,
          reloadRequired: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname.endsWith("/sync")) {
      return new Response(
        JSON.stringify({
          workspaceId: "workspace-a",
          status: "pending",
          registryConfigured: true,
          materializedSkills: [],
          synced: false,
          reloadRequired: true,
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        workspaceId: "workspace-a",
        status: "current",
        registryConfigured: true,
        rootDir: "/workspace/.opencode/skills/veslo-managed",
        materializedSkills: [
          {
            name: "research",
            packageSha256: "a".repeat(64),
          },
        ],
        reloadRequired: false,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
      hostToken: "host-token-123",
    });

    const globalStatus = await client.getGlobalSkillMaterializationStatus();
    const globalSync = await client.syncGlobalSkillMaterialization({
      denToken: "den-token",
      denOrgId: "org_123",
      denUserId: "user_123",
    });
    const status = await client.getWorkspaceSkillMaterializationStatus("workspace-a");
    const sync = await client.syncWorkspaceSkillMaterialization("workspace-a", {
      activeRun: true,
      denToken: "den-token",
      denOrgId: "org_123",
      denUserId: "user_123",
    });
    await client.getSkill("workspace-a", "research", {
      includeGlobal: true,
      path: "/workspace/.opencode/skills/category/research/SKILL.md",
    });
    await client.deleteSkill("workspace-a", "research", {
      path: "/workspace/.opencode/skills/category/research/SKILL.md",
    });

    assert.equal(globalStatus.scope, "personal-global");
    assert.deepEqual(globalStatus.platformManaged, {
      enabled: true,
      synced: false,
      desiredSkills: [
        {
          installationId: "platform_install_veslo_automations",
          skillId: "platform_skill_veslo_automations",
          name: "veslo-automations",
          versionId: "platform_version_veslo_automations_v1",
          packageSha256: "b".repeat(64),
          source: "platform",
          removalPolicy: "locked",
          target: "personal-global",
        },
      ],
    });
    assert.equal(globalStatus.platformManaged?.desiredSkills[0]?.name, "veslo-automations");
    assert.equal(globalStatus.platformManaged?.desiredSkills[0]?.source, "platform");
    assert.equal(globalStatus.platformManaged?.desiredSkills[0]?.removalPolicy, "locked");
    assert.equal(globalStatus.materializedSkills[0]?.source, "platform");
    assert.equal(globalStatus.materializedSkills[0]?.removalPolicy, "locked");
    assert.equal(globalSync.status, "synced");
    assert.equal(status.status, "current");
    assert.equal(sync.status, "pending");
    assert.deepEqual(calls.map((call) => ({ url: call.url, method: call.method, body: call.body })), [
      {
        url: "https://veslo.example/skills/materialization",
        method: "GET",
        body: null,
      },
      {
        url: "https://veslo.example/skills/materialization/sync-global",
        method: "POST",
        body: null,
      },
      {
        url: "https://veslo.example/workspace/workspace-a/skills/materialization",
        method: "GET",
        body: null,
      },
      {
        url: "https://veslo.example/workspace/workspace-a/skills/materialization/sync",
        method: "POST",
        body: JSON.stringify({ activeRun: true }),
      },
      {
        url: "https://veslo.example/workspace/workspace-a/skills/research?includeGlobal=true&path=%2Fworkspace%2F.opencode%2Fskills%2Fcategory%2Fresearch%2FSKILL.md",
        method: "GET",
        body: null,
      },
      {
        url: "https://veslo.example/workspace/workspace-a/skills/research?path=%2Fworkspace%2F.opencode%2Fskills%2Fcategory%2Fresearch%2FSKILL.md",
        method: "DELETE",
        body: null,
      },
    ]);
    assert.equal(calls[1]?.headers.get("authorization"), "Bearer token-123");
    assert.equal(calls[1]?.headers.get("x-veslo-host-token"), "host-token-123");
    assert.equal(calls[1]?.headers.get("x-veslo-den-token"), "den-token");
    assert.equal(calls[1]?.headers.get("x-veslo-den-org-id"), "org_123");
    assert.equal(calls[1]?.headers.get("x-veslo-den-user-id"), "user_123");
    assert.equal(calls[3]?.headers.get("x-veslo-den-token"), "den-token");
    assert.equal(calls[3]?.headers.get("x-veslo-den-org-id"), "org_123");
    assert.equal(calls[3]?.headers.get("x-veslo-den-user-id"), "user_123");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("skill removal helpers call local server routes with host and client auth", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; headers: Headers; body: string | null }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body: typeof init?.body === "string" ? init.body : null,
    });
    const url = new URL(String(input));
    if (url.pathname === "/skill-removals") {
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "removal_1",
              name: "legacy-helper",
              scope: "user-global",
              path: "/Users/example/.config/opencode/skills/legacy-helper/SKILL.md",
              reason: "cleanup",
              status: "removed",
              removedAt: "2026-05-31T10:00:00.000Z",
              canRestore: true,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname.endsWith("/restore")) {
      return new Response(
        JSON.stringify({
          ok: true,
          path: "/Users/example/.config/opencode/skills/legacy-helper/SKILL.md",
          reloadRequired: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname === "/skills/batch-remove") {
      return new Response(
        JSON.stringify({
          ok: false,
          succeeded: 1,
          failed: 1,
          results: [
            {
              id: "workspace",
              index: 0,
              ok: true,
              name: "workspace-helper",
              scope: "workspace",
              path: "/workspace/.opencode/skills/workspace-helper",
              removalId: "removal_workspace",
            },
            {
              id: "missing",
              index: 1,
              ok: false,
              code: "skill_not_found",
              message: "Skill not found: missing-helper",
              status: 404,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        ok: true,
        name: "legacy-helper",
        path: "/Users/example/.config/opencode/skills/legacy-helper",
        removalId: "removal_1",
        reloadRequired: true,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example/",
      token: "token-123",
      hostToken: "host-token-123",
    });

    await client.deleteGlobalSkill("legacy-helper", {
      path: "/Users/example/.config/opencode/skills/legacy-helper/SKILL.md",
      reason: "cleanup",
    });
    const batch = await client.batchRemoveSkills({
      items: [
        {
          id: "workspace",
          scope: "workspace",
          workspaceId: "workspace-a",
          name: "workspace-helper",
          path: "/workspace/.opencode/skills/workspace-helper/SKILL.md",
          reason: "cleanup",
        },
        {
          id: "missing",
          scope: "workspace",
          workspaceId: "workspace-a",
          name: "missing-helper",
        },
      ],
    });
    const removals = await client.listSkillRemovals({
      scope: "user-global",
      workspaceId: "workspace-a",
      includeRestored: true,
    });
    await client.restoreSkillRemoval("removal_1");

    assert.equal(removals.items[0]?.id, "removal_1");
    assert.equal(removals.items[0]?.path, "/Users/example/.config/opencode/skills/legacy-helper/SKILL.md");
    assert.equal(batch.ok, false);
    assert.equal(batch.succeeded, 1);
    assert.equal(batch.failed, 1);
    assert.equal(batch.results[1]?.ok, false);
    assert.deepEqual(calls.map((call) => ({ url: call.url, method: call.method, body: call.body })), [
      {
        url: "https://veslo.example/skills/user-global/legacy-helper?path=%2FUsers%2Fexample%2F.config%2Fopencode%2Fskills%2Flegacy-helper%2FSKILL.md&reason=cleanup",
        method: "DELETE",
        body: null,
      },
      {
        url: "https://veslo.example/skills/batch-remove",
        method: "POST",
        body: JSON.stringify({
          items: [
            {
              id: "workspace",
              scope: "workspace",
              workspaceId: "workspace-a",
              name: "workspace-helper",
              path: "/workspace/.opencode/skills/workspace-helper/SKILL.md",
              reason: "cleanup",
            },
            {
              id: "missing",
              scope: "workspace",
              workspaceId: "workspace-a",
              name: "missing-helper",
            },
          ],
        }),
      },
      {
        url: "https://veslo.example/skill-removals?scope=user-global&workspaceId=workspace-a&includeRestored=true",
        method: "GET",
        body: null,
      },
      {
        url: "https://veslo.example/skill-removals/removal_1/restore",
        method: "POST",
        body: null,
      },
    ]);
    for (const call of calls) {
      assert.equal(call.headers.get("authorization"), "Bearer token-123");
      assert.equal(call.headers.get("x-veslo-host-token"), "host-token-123");
    }
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
