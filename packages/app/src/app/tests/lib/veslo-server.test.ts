import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVesloBundleInviteUrl,
  buildVesloConnectInviteUrl,
  createVesloServerClient,
  DEFAULT_VESLO_CONNECT_APP_URL,
  clearVesloServerSettings,
  requestManagedAiAccessBundle,
  readVesloServerSettings,
  resolveOpencodeProxyAuthHeaders,
  resolveSessionArchiveClientOptions,
  VesloServerError,
  writeVesloServerSettings,
} from "../../lib/veslo-server.js";

const LOCAL_SESSION_ARCHIVE_OWNER_KEY = "local:desktop";

function createMemoryStorage(seed: Record<string, string> = {}): Storage {
  const entries = new Map(Object.entries(seed));
  return {
    get length() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    getItem(key: string) {
      return entries.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(entries.keys())[index] ?? null;
    },
    removeItem(key: string) {
      entries.delete(key);
    },
    setItem(key: string, value: string) {
      entries.set(key, value);
    },
  };
}

async function withDenAuthStorage(run: () => Promise<void>) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: createMemoryStorage(),
      sessionStorage: createMemoryStorage({
        "veslo.den.auth": JSON.stringify({
          denApiBase: "https://api.veslo.test",
          token: "den-token",
          orgId: "org_123",
          user: { id: "user_123" },
          org: { id: "org_123" },
        }),
      }),
    },
  });

  try {
    await run();
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
}

function withBrowserStorage<T>(seed: Record<string, string>, run: () => T): T {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: createMemoryStorage(seed),
      sessionStorage: createMemoryStorage(),
    },
  });

  try {
    return run();
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
}

test("Veslo server settings read write and clear canonicalize storage keys", () => {
  withBrowserStorage(
    {
      "openwork.server.urlOverride": "legacy.example.test/path/",
      "openwork.server.port": "not-a-number",
      "openwork.server.token": " legacy-token ",
    },
    () => {
      assert.deepEqual(readVesloServerSettings(), {
        urlOverride: "http://legacy.example.test/path",
        token: "legacy-token",
      });

      const written = writeVesloServerSettings({
        urlOverride: "veslo.example.test/",
        portOverride: 8788,
        token: " next-token ",
      });

      assert.deepEqual(written, {
        urlOverride: "http://veslo.example.test",
        portOverride: 8788,
        token: "next-token",
      });
      assert.equal(window.localStorage.getItem("openwork.server.urlOverride"), null);
      assert.equal(window.localStorage.getItem("openwork.server.port"), null);
      assert.equal(window.localStorage.getItem("openwork.server.token"), null);

      clearVesloServerSettings();
      assert.deepEqual(readVesloServerSettings(), {});
    },
  );
});

test("opencode proxy auth uses settings token only for non-local proxy URLs", () => {
  assert.deepEqual(
    resolveOpencodeProxyAuthHeaders({
      baseUrl: "https://remote.example/w/ws-123/opencode",
      settingsToken: " remote-token ",
      isTauriRuntime: false,
    }),
    { Authorization: "Bearer remote-token" },
  );
  assert.equal(
    resolveOpencodeProxyAuthHeaders({
      baseUrl: "http://127.0.0.1:8787/opencode",
      settingsToken: "remote-token",
      isTauriRuntime: true,
    }),
    undefined,
  );
  assert.equal(
    resolveOpencodeProxyAuthHeaders({
      baseUrl: "http://127.0.0.1:8787",
      settingsToken: "remote-token",
      isTauriRuntime: false,
    }),
    undefined,
  );
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

test("deleteSessionArchive includes workspace scope when provided", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string | undefined }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
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

    await client.deleteSessionArchive("shared-session", {
      workspaceId: "workspace-a",
      workspaceIdentity: "local:/workspace/a",
    });

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.url,
      "https://veslo.example/session-archives/shared-session?workspaceId=workspace-a&workspaceIdentity=local%3A%2Fworkspace%2Fa",
    );
    assert.equal(calls[0]?.method, "DELETE");
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

test("runConversation includes the optional send trace id header", async () => {
  const previousFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const calls: Array<{ url: string; method?: string; headers: Headers; body: string | null }> = [];
  const timeoutDelays: number[] = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body: typeof init?.body === "string" ? init.body : null,
    });
    return new Response(
      JSON.stringify({
        ok: true,
        workspaceId: "ws_1",
        conversationId: "conv_1",
        opencodeSessionId: "sess_1",
        runId: "run_1",
        status: "submitted",
        kind: "prompt_async",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    timeoutDelays.push(Number(timeout));
    return originalSetTimeout(handler, timeout, ...args);
  }) as typeof setTimeout;

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
    });

    await client.runConversation(
      "ws_1",
      "conv_1",
      { kind: "prompt_async", parts: [{ type: "text", text: "Hello" }] },
      { sendTraceId: "send-trace-123" },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://veslo.example/workspace/ws_1/conversations/conv_1/runs");
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.headers.get("x-veslo-send-trace-id"), "send-trace-123");
    assert.equal(timeoutDelays[0], 90_000);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("submitConversation posts to the server-owned submit endpoint", async () => {
  const previousFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const calls: Array<{ url: string; method?: string; headers: Headers; body: unknown }> = [];
  const timeoutDelays: number[] = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    return new Response(
      JSON.stringify({
        status: "dry_run",
        workspaceId: "ws_1",
        clientMessageId: "msg_1",
        requestHash: "a".repeat(64),
        draftDisposition: "keep",
        target: { directory: "src" },
        debugTrace: [{ source: "server", event: "implicit_skill_resolution_failed" }],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    timeoutDelays.push(Number(timeout));
    return originalSetTimeout(handler, timeout, ...args);
  }) as typeof setTimeout;

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
    });

    const result = await client.submitConversation(
      "ws_1",
      {
        clientMessageId: "msg_1",
        origin: "session:normal",
        source: "enter",
        target: { directory: "src" },
        draft: {
          mode: "prompt",
          text: "Hello",
          parts: [{ type: "text", text: "Hello" }],
        },
        options: { dryRun: true },
      },
      { sendTraceId: "submit-trace-123" },
    );

    assert.equal(result.status, "dry_run");
    assert.deepEqual(result.debugTrace, [{ source: "server", event: "implicit_skill_resolution_failed" }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://veslo.example/workspace/ws_1/conversations/submit");
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.headers.get("x-veslo-send-trace-id"), "submit-trace-123");
    assert.deepEqual(calls[0]?.body, {
      clientMessageId: "msg_1",
      origin: "session:normal",
      source: "enter",
      target: { directory: "src" },
      draft: {
        mode: "prompt",
        text: "Hello",
        parts: [{ type: "text", text: "Hello" }],
      },
      options: { dryRun: true },
    });
    assert.equal(timeoutDelays[0], 90_000);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("submitConversation accepts a materialized first-session result", async () => {
  const previousFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        status: "materialized",
        workspaceId: "ws_1",
        conversationId: "conv_1",
        opencodeSessionId: "sess_1",
        clientMessageId: "msg_1",
        pendingClientSessionId: "pending_1",
        materializedSession: {
          id: "sess_1",
          title: "Hello",
          conversationId: "conv_1",
          opencodeSessionId: "sess_1",
        },
        draftDisposition: "keep",
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

    const result = await client.submitConversation("ws_1", {
      clientMessageId: "msg_1",
      origin: "session:normal",
      target: { directory: "src", pendingClientSessionId: "pending_1" },
      draft: {
        mode: "prompt",
        text: "Hello",
        parts: [{ type: "text", text: "Hello" }],
      },
    });

    assert.equal(result.status, "materialized");
    assert.equal(result.conversationId, "conv_1");
    assert.equal(result.opencodeSessionId, "sess_1");
    assert.equal(result.pendingClientSessionId, "pending_1");
    assert.deepEqual(result.materializedSession, {
      id: "sess_1",
      title: "Hello",
      conversationId: "conv_1",
      opencodeSessionId: "sess_1",
    });
    assert.equal(result.draftDisposition, "keep");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("OpenCode Router client methods use the server-owned /opencode-router namespace", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: unknown }> = [];

  globalThis.fetch = async (input, init) => {
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    }
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body,
    });
    return new Response(
      JSON.stringify({
        ok: true,
        status: "ok",
        channels: { telegram: true, slack: true },
        items: [],
        bindings: [],
        applied: true,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
      hostToken: "host-token-123",
    });

    await client.opencodeRouterHealth();
    await client.opencodeRouterBindings({ channel: "telegram", identityId: "identity 1" });
    await client.opencodeRouterTelegramIdentities();
    await client.opencodeRouterSlackIdentities();
    await client.setOpenCodeRouterTelegramToken("workspace 1", "tg-token", 3005);
    await client.setOpenCodeRouterSlackTokens("workspace 1", "xoxb-token", "xapp-token", 3005);
    await client.getOpenCodeRouterTelegram("workspace 1");
    await client.getOpenCodeRouterTelegramIdentities("workspace 1", { healthPort: 3005 });
    await client.upsertOpenCodeRouterTelegramIdentity(
      "workspace 1",
      { id: "private", token: "tg-token", enabled: true, access: "private", pairingCode: "123456" },
      { healthPort: 3005 },
    );
    await client.deleteOpenCodeRouterTelegramIdentity("workspace 1", "identity/1", { healthPort: 3005 });
    await client.getOpenCodeRouterSlackIdentities("workspace 1", { healthPort: 3005 });
    await client.upsertOpenCodeRouterSlackIdentity(
      "workspace 1",
      { id: "slack", botToken: "xoxb-token", appToken: "xapp-token", enabled: false },
      { healthPort: 3005 },
    );
    await client.deleteOpenCodeRouterSlackIdentity("workspace 1", "slack/1", { healthPort: 3005 });
    await client.getOpenCodeRouterBindings("workspace 1", {
      channel: "slack",
      identityId: "slack 1",
      healthPort: 3005,
    });
    await client.setOpenCodeRouterBinding(
      "workspace 1",
      { channel: "slack", identityId: "slack", peerId: "C123", directory: "/tmp/workspace" },
      { healthPort: 3005 },
    );
    await client.sendOpenCodeRouterMessage(
      "workspace 1",
      { channel: "telegram", text: "hi", identityId: "identity", peerId: "peer", directory: "/tmp/workspace", autoBind: true },
      { healthPort: 3005 },
    );
    await client.setOpenCodeRouterTelegramEnabled("workspace 1", false, { clearToken: true, healthPort: 3005 });

    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.url}`),
      [
        "GET https://veslo.example/opencode-router/health",
        "GET https://veslo.example/opencode-router/bindings?channel=telegram&identityId=identity+1",
        "GET https://veslo.example/opencode-router/identities/telegram",
        "GET https://veslo.example/opencode-router/identities/slack",
        "POST https://veslo.example/workspace/workspace%201/opencode-router/telegram-token",
        "POST https://veslo.example/workspace/workspace%201/opencode-router/slack-tokens",
        "GET https://veslo.example/workspace/workspace%201/opencode-router/telegram",
        "GET https://veslo.example/workspace/workspace%201/opencode-router/identities/telegram?healthPort=3005",
        "POST https://veslo.example/workspace/workspace%201/opencode-router/identities/telegram",
        "DELETE https://veslo.example/workspace/workspace%201/opencode-router/identities/telegram/identity%2F1?healthPort=3005",
        "GET https://veslo.example/workspace/workspace%201/opencode-router/identities/slack?healthPort=3005",
        "POST https://veslo.example/workspace/workspace%201/opencode-router/identities/slack",
        "DELETE https://veslo.example/workspace/workspace%201/opencode-router/identities/slack/slack%2F1?healthPort=3005",
        "GET https://veslo.example/workspace/workspace%201/opencode-router/bindings?channel=slack&identityId=slack+1&healthPort=3005",
        "POST https://veslo.example/workspace/workspace%201/opencode-router/bindings",
        "POST https://veslo.example/workspace/workspace%201/opencode-router/send",
        "POST https://veslo.example/workspace/workspace%201/opencode-router/telegram-enabled",
      ],
    );
    assert.equal(calls.some((call) => call.url.includes("/veslo-code-router")), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("messaging identities domain facade uses the server-owned /opencode-router namespace", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: unknown }> = [];

  globalThis.fetch = async (input, init) => {
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    }
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body,
    });
    return new Response(
      JSON.stringify({
        ok: true,
        status: "ok",
        channels: { telegram: true, slack: true },
        items: [],
        bindings: [],
        applied: true,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
      hostToken: "host-token-123",
    });

    await client.identities.health();
    await client.identities.bindings({ channel: "telegram", identityId: "identity 1" });
    await client.identities.telegramIdentities();
    await client.identities.slackIdentities();
    await client.identities.setTelegramToken("workspace 1", "tg-token", 3005);
    await client.identities.setSlackTokens("workspace 1", "xoxb-token", "xapp-token", 3005);
    await client.identities.getTelegram("workspace 1");
    await client.identities.getTelegramIdentities("workspace 1", { healthPort: 3005 });
    await client.identities.upsertTelegramIdentity(
      "workspace 1",
      { id: "private", token: "tg-token", enabled: true, access: "private", pairingCode: "123456" },
      { healthPort: 3005 },
    );
    await client.identities.deleteTelegramIdentity("workspace 1", "identity/1", { healthPort: 3005 });
    await client.identities.getSlackIdentities("workspace 1", { healthPort: 3005 });
    await client.identities.upsertSlackIdentity(
      "workspace 1",
      { id: "slack", botToken: "xoxb-token", appToken: "xapp-token", enabled: false },
      { healthPort: 3005 },
    );
    await client.identities.deleteSlackIdentity("workspace 1", "slack/1", { healthPort: 3005 });
    await client.identities.getBindings("workspace 1", {
      channel: "slack",
      identityId: "slack 1",
      healthPort: 3005,
    });
    await client.identities.setBinding(
      "workspace 1",
      { channel: "slack", identityId: "slack", peerId: "C123", directory: "/tmp/workspace" },
      { healthPort: 3005 },
    );
    await client.identities.sendMessage(
      "workspace 1",
      { channel: "telegram", text: "hi", identityId: "identity", peerId: "peer", directory: "/tmp/workspace", autoBind: true },
      { healthPort: 3005 },
    );
    await client.identities.setTelegramEnabled("workspace 1", false, { clearToken: true, healthPort: 3005 });

    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.url}`),
      [
        "GET https://veslo.example/opencode-router/health",
        "GET https://veslo.example/opencode-router/bindings?channel=telegram&identityId=identity+1",
        "GET https://veslo.example/opencode-router/identities/telegram",
        "GET https://veslo.example/opencode-router/identities/slack",
        "POST https://veslo.example/workspace/workspace%201/opencode-router/telegram-token",
        "POST https://veslo.example/workspace/workspace%201/opencode-router/slack-tokens",
        "GET https://veslo.example/workspace/workspace%201/opencode-router/telegram",
        "GET https://veslo.example/workspace/workspace%201/opencode-router/identities/telegram?healthPort=3005",
        "POST https://veslo.example/workspace/workspace%201/opencode-router/identities/telegram",
        "DELETE https://veslo.example/workspace/workspace%201/opencode-router/identities/telegram/identity%2F1?healthPort=3005",
        "GET https://veslo.example/workspace/workspace%201/opencode-router/identities/slack?healthPort=3005",
        "POST https://veslo.example/workspace/workspace%201/opencode-router/identities/slack",
        "DELETE https://veslo.example/workspace/workspace%201/opencode-router/identities/slack/slack%2F1?healthPort=3005",
        "GET https://veslo.example/workspace/workspace%201/opencode-router/bindings?channel=slack&identityId=slack+1&healthPort=3005",
        "POST https://veslo.example/workspace/workspace%201/opencode-router/bindings",
        "POST https://veslo.example/workspace/workspace%201/opencode-router/send",
        "POST https://veslo.example/workspace/workspace%201/opencode-router/telegram-enabled",
      ],
    );
    assert.equal(calls.some((call) => call.url.includes("/veslo-code-router")), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("OpenCode Router send fallback uses mounted /opencode-router paths", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
    });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ code: "not_found", message: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, sent: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example/w/workspace%201",
      token: "token-123",
      hostToken: "host-token-123",
    });

    await client.sendOpenCodeRouterMessage("workspace 1", { channel: "telegram", text: "hi" });

    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.url}`),
      [
        "POST https://veslo.example/w/workspace%201/workspace/workspace%201/opencode-router/send",
        "POST https://veslo.example/w/workspace%201/opencode-router/send",
      ],
    );
    assert.equal(calls.some((call) => call.url.includes("/veslo-code-router")), false);
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

test("workspace not found 404 maps to workspace_registry_unsynced", async () => {
  const previousFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://veslo.example/workspace/ws-missing/config");
    return new Response(JSON.stringify({ error: "workspace not found" }), {
      status: 404,
      statusText: "Not Found",
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
    });

    await assert.rejects(
      () => client.getConfig("ws-missing"),
      (error) => {
        assert.ok(error instanceof VesloServerError);
        assert.equal(error.status, 404);
        assert.equal(error.code, "workspace_registry_unsynced");
        assert.equal(error.message, "workspace not found");
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("transport errors preserve status code message details and auth headers", async () => {
  const previousFetch = globalThis.fetch;
  let capturedHeaders: Headers | null = null;

  globalThis.fetch = async (_input, init) => {
    capturedHeaders = new Headers(init?.headers as HeadersInit | undefined);
    return new Response(
      JSON.stringify({
        code: "forbidden_action",
        message: "Forbidden action",
        details: { reason: "policy" },
      }),
      {
        status: 403,
        statusText: "Forbidden",
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
      hostToken: "host-token-123",
    });

    await assert.rejects(
      () => client.status(),
      (error) => {
        assert.ok(error instanceof VesloServerError);
        assert.equal(error.status, 403);
        assert.equal(error.code, "forbidden_action");
        assert.equal(error.message, "Forbidden action");
        assert.deepEqual(error.details, { reason: "policy" });
        return true;
      },
    );
    const headers = capturedHeaders as Headers | null;
    assert.ok(headers);
    assert.equal(headers.get("authorization"), "Bearer token-123");
    assert.equal(headers.get("x-veslo-host-token"), "host-token-123");
    assert.equal(headers.get("content-type"), "application/json");
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
    const status = await client.getWorkspaceSkillMaterializationStatus("workspace-a", {
      denToken: "den-token",
      denOrgId: "org_123",
      denUserId: "user_123",
    });
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
    assert.equal(calls[2]?.headers.get("x-veslo-den-token"), "den-token");
    assert.equal(calls[2]?.headers.get("x-veslo-den-org-id"), "org_123");
    assert.equal(calls[2]?.headers.get("x-veslo-den-user-id"), "user_123");
    assert.equal(calls[3]?.headers.get("x-veslo-den-token"), "den-token");
    assert.equal(calls[3]?.headers.get("x-veslo-den-org-id"), "org_123");
    assert.equal(calls[3]?.headers.get("x-veslo-den-user-id"), "user_123");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("user-global skill store helpers call local server store and sync routes", async () => {
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
    if (url.pathname === "/skills/user-global-store") {
      if ((init?.method ?? "GET") === "POST") {
        return new Response(
          JSON.stringify({
            ok: true,
            action: "updated",
            item: {
              name: "portable-helper",
              path: "veslo-user-store://portable-helper",
              description: "Portable helper",
              scope: "user-global",
              source: "veslo-user-store",
              hash: "a".repeat(64),
              enabled: true,
              createdAt: "2026-06-18T10:00:00.000Z",
              updatedAt: "2026-06-18T10:01:00.000Z",
            },
            reloadRequired: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          items: [
            {
              name: "portable-helper",
              path: "veslo-user-store://portable-helper",
              description: "Portable helper",
              scope: "user-global",
              source: "veslo-user-store",
              hash: "a".repeat(64),
              enabled: true,
              createdAt: "2026-06-18T10:00:00.000Z",
              updatedAt: "2026-06-18T10:01:00.000Z",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname === "/skills/user-global-store/portable-helper") {
      if ((init?.method ?? "GET") === "DELETE") {
        return new Response(
          JSON.stringify({
            ok: true,
            name: "portable-helper",
            path: "veslo-user-store://portable-helper",
            reloadRequired: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          item: {
            name: "portable-helper",
            path: "veslo-user-store://portable-helper",
            description: "Portable helper",
            scope: "user-global",
            source: "veslo-user-store",
            hash: "a".repeat(64),
            enabled: true,
            createdAt: "2026-06-18T10:00:00.000Z",
            updatedAt: "2026-06-18T10:01:00.000Z",
          },
          content: "---\nname: portable-helper\ndescription: Portable helper\n---\n",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname === "/workspace/workspace-a/skills/user-global-store/sync") {
      return new Response(
        JSON.stringify({
          workspaceId: "workspace-a",
          status: "synced",
          synced: true,
          reloadRequired: true,
          rootDir: "/workspace/.opencode/skills/veslo-user",
          materializedSkills: [],
          removedSkillNames: [],
          conflicts: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
      hostToken: "host-token-123",
    });

    const list = await client.listUserGlobalSkillStore();
    const detail = await client.getUserGlobalSkillStoreSkill("portable-helper");
    const upsert = await client.upsertUserGlobalSkillStoreSkill({
      name: "portable-helper",
      content: "# Portable helper\n",
      enabled: true,
    });
    const sync = await client.syncUserGlobalSkillStore("workspace-a");
    const deleted = await client.deleteUserGlobalSkillStoreSkill("portable-helper");

    assert.equal(list.items[0]?.name, "portable-helper");
    assert.equal(detail.content.includes("portable-helper"), true);
    assert.equal(upsert.action, "updated");
    assert.equal(sync.rootDir, "/workspace/.opencode/skills/veslo-user");
    assert.equal(deleted.name, "portable-helper");
    assert.deepEqual(calls.map((call) => ({ url: call.url, method: call.method, body: call.body })), [
      {
        url: "https://veslo.example/skills/user-global-store",
        method: "GET",
        body: null,
      },
      {
        url: "https://veslo.example/skills/user-global-store/portable-helper",
        method: "GET",
        body: null,
      },
      {
        url: "https://veslo.example/skills/user-global-store",
        method: "POST",
        body: JSON.stringify({
          name: "portable-helper",
          content: "# Portable helper\n",
          enabled: true,
        }),
      },
      {
        url: "https://veslo.example/workspace/workspace-a/skills/user-global-store/sync",
        method: "POST",
        body: null,
      },
      {
        url: "https://veslo.example/skills/user-global-store/portable-helper",
        method: "DELETE",
        body: null,
      },
    ]);
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer token-123");
    assert.equal(calls[0]?.headers.get("x-veslo-host-token"), "host-token-123");
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

test("skill enabled override helpers call disabled list and patch routes", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; headers: Headers; body: string | null }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body: typeof init?.body === "string" ? init.body : null,
    });
    return new Response(
      JSON.stringify({
        items: [
          {
            id: "disabled-platform",
            name: "platform-helper",
            scope: "platform",
            path: "/Users/example/.config/opencode/skills/veslo-managed/platform-helper/SKILL.md",
            disabledAt: "2026-06-06T10:00:00.000Z",
          },
        ],
        ok: true,
        enabled: false,
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

    const disabled = await client.listDisabledSkills({ workspaceId: "workspace a" });
    const result = await client.setSkillEnabledState({
      enabled: false,
      target: {
        name: "platform-helper",
        scope: "platform",
        path: "/Users/example/.config/opencode/skills/veslo-managed/platform-helper/SKILL.md",
        registry: {
          policyId: "policy_platform_helper",
          source: "platform",
        },
      },
    });

    assert.equal(disabled.items[0]?.scope, "platform");
    assert.equal(result.enabled, false);
    assert.deepEqual(calls.map((call) => ({ url: call.url, method: call.method, body: call.body })), [
      {
        url: "https://veslo.example/skills/disabled?workspaceId=workspace+a",
        method: "GET",
        body: null,
      },
      {
        url: "https://veslo.example/skills/enabled-state",
        method: "PATCH",
        body: JSON.stringify({
          enabled: false,
          target: {
            name: "platform-helper",
            scope: "platform",
            path: "/Users/example/.config/opencode/skills/veslo-managed/platform-helper/SKILL.md",
            registry: {
              policyId: "policy_platform_helper",
              source: "platform",
            },
          },
        }),
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
      denApiBase: "https://api.veslo.test",
      denToken: "den-token",
      denOrgId: "org_123",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://veslo.example/hub/mcp");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer token-123");
    assert.equal(calls[0]?.headers.get("x-veslo-den-api-base"), "https://api.veslo.test");
    assert.equal(calls[0]?.headers.get("x-veslo-den-token"), "den-token");
    assert.equal(calls[0]?.headers.get("x-veslo-den-org-id"), "org_123");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("listHubMcp preserves platform connector metadata", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Headers }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers as HeadersInit | undefined),
    });
    return new Response(
      JSON.stringify({
        items: [
          {
            id: "google-drive",
            name: "Google Drive",
            description: "Find Drive files.",
            config: {
              type: "remote",
              url: "https://api.veslo.work/v1/orgs/org_123/integrations/google/google-drive/mcp",
              oauth: false,
              headers: {
                "X-Veslo-Connector": "google-drive",
              },
            },
            authorization: {
              type: "veslo-server-oauth",
              provider: "google",
              connectorId: "google-drive",
              scopes: [
                "https://www.googleapis.com/auth/drive.readonly",
                "https://www.googleapis.com/auth/drive.file",
              ],
              startPath: "/v1/orgs/org_123/integrations/google/google-drive/oauth/start",
              runtimeTokenPath: "/v1/orgs/org_123/integrations/google/google-drive/runtime-token",
              statusPath: "/v1/orgs/org_123/integrations/google/connections",
              disconnectPath: "/v1/orgs/org_123/integrations/google/google-drive/connection",
            },
            connection: {
              connectorId: "google-drive",
              name: "Google Drive",
              connected: true,
              state: "connected",
              scopes: ["https://www.googleapis.com/auth/drive.readonly"],
              connectedAt: "2026-07-08T12:00:00.000Z",
              revokedAt: null,
              accessTokenExpiresAt: "2030-06-19T12:00:00.000Z",
            },
            source: { scope: "platform" },
            provider: { id: "google", group: "Google" },
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
    });

    const result = await client.listHubMcp({
      denToken: "den-token",
      denOrgId: "org_123",
    });

    assert.equal(calls.length, 1);
    assert.equal(result.items[0]?.source.scope, "platform");
    assert.equal(result.items[0]?.provider?.id, "google");
    assert.equal(result.items[0]?.config.oauth, false);
    assert.deepEqual(result.items[0]?.config.headers, { "X-Veslo-Connector": "google-drive" });
    assert.equal(result.items[0]?.authorization?.type, "veslo-server-oauth");
    assert.equal(result.items[0]?.connection?.connected, true);
    assert.equal(
      result.items[0]?.authorization?.runtimeTokenPath,
      "/v1/orgs/org_123/integrations/google/google-drive/runtime-token",
    );
    assert.doesNotMatch(JSON.stringify(result), /VESLO_GOOGLE_MCP_CLIENT_SECRET|clientSecret/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("refreshHubMcp preserves platform connector metadata in card state", async () => {
  const { createRoot } = await import("solid-js");
  const { createExtensionsStore } = await import("../../context/extensions.js");

  await withDenAuthStorage(async () => {
    await createRoot(async (dispose) => {
      const store = createExtensionsStore({
        client: () => null,
        projectDir: () => "/workspaces/alpha",
        activeWorkspaceId: () => "ws-alpha",
        activeWorkspaceRoot: () => "/workspaces/alpha",
        workspaceType: () => "local",
        vesloServerClient: () =>
          ({
            mcp: {
              listHub: async () => ({
                items: [
                  {
                    id: "google-drive",
                    name: "Google Drive",
                    description: "Find Drive files.",
                    config: {
                      type: "remote",
                      url: "https://api.veslo.work/v1/orgs/org_123/integrations/google/google-drive/mcp",
                      oauth: false,
                      headers: {
                        "X-Veslo-Connector": "google-drive",
                      },
                    },
                    authorization: {
                      type: "veslo-server-oauth",
                      provider: "google",
                      connectorId: "google-drive",
                      scopes: [
                        "https://www.googleapis.com/auth/drive.readonly",
                        "https://www.googleapis.com/auth/drive.file",
                      ],
                      startPath: "/v1/orgs/org_123/integrations/google/google-drive/oauth/start",
                      runtimeTokenPath: "/v1/orgs/org_123/integrations/google/google-drive/runtime-token",
                      statusPath: "/v1/orgs/org_123/integrations/google/connections",
                      disconnectPath: "/v1/orgs/org_123/integrations/google/google-drive/connection",
                    },
                    connection: {
                      connectorId: "google-drive",
                      name: "Google Drive",
                      connected: true,
                      state: "connected",
                      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
                      connectedAt: "2026-07-08T12:00:00.000Z",
                      revokedAt: null,
                      accessTokenExpiresAt: "2030-06-19T12:00:00.000Z",
                    },
                    source: { scope: "platform" },
                    provider: { id: "google", group: "Google" },
                  },
                ],
              }),
            },
          }) as any,
        vesloServerStatus: () => "connected",
        vesloServerCapabilities: () => ({
          skills: { read: true, write: true, source: "veslo" },
          hub: { mcp: { read: true, install: true } },
          plugins: { read: true, write: true },
          mcp: { read: true, write: true },
          commands: { read: true, write: true },
          config: { read: true, write: true },
        }),
        vesloServerWorkspaceId: () => "workspace-1",
        setBusy: () => {},
        setBusyLabel: () => {},
        setBusyStartedAt: () => {},
        setError: () => {},
      });

      try {
        await store.refreshHubMcp({ force: true });
        const card = store.hubMcpCards()[0];
        assert.equal(card?.source?.scope, "platform");
        assert.equal(card?.provider?.id, "google");
        assert.equal(card?.oauth, false);
        assert.deepEqual(card?.headers, { "X-Veslo-Connector": "google-drive" });
        assert.equal(card?.authorization?.type, "veslo-server-oauth");
        assert.equal(card?.connection?.connected, true);
        assert.equal(
          card?.authorization?.runtimeTokenPath,
          "/v1/orgs/org_123/integrations/google/google-drive/runtime-token",
        );
      } finally {
        dispose();
      }
    });
  });
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
      denApiBase: "https://api.veslo.test",
      denToken: "den-token",
      denOrgId: "org_123",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://veslo.example/workspace/workspace-1/mcp/hub/catalog-item");
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer token-123");
    assert.equal(calls[0]?.headers.get("x-veslo-den-api-base"), "https://api.veslo.test");
    assert.equal(calls[0]?.headers.get("x-veslo-den-token"), "den-token");
    assert.equal(calls[0]?.headers.get("x-veslo-den-org-id"), "org_123");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("refreshMcpRuntimeToken forwards den auth context headers when provided", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Headers; method?: string }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers as HeadersInit | undefined),
    });
    return new Response(JSON.stringify({
      ok: true,
      name: "google-gmail",
      action: "updated",
      expiresAt: "2030-06-19T12:00:00.000Z",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
    });

    await client.refreshMcpRuntimeToken("workspace-1", "google-gmail", {
      denApiBase: "https://api.veslo.test",
      denToken: "den-token",
      denOrgId: "org_123",
    });

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.url,
      "https://veslo.example/workspace/workspace-1/mcp/google-gmail/runtime-token/refresh",
    );
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer token-123");
    assert.equal(calls[0]?.headers.get("x-veslo-den-api-base"), "https://api.veslo.test");
    assert.equal(calls[0]?.headers.get("x-veslo-den-token"), "den-token");
    assert.equal(calls[0]?.headers.get("x-veslo-den-org-id"), "org_123");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("logoutMcpAuth forwards den auth context headers when provided", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Headers; method?: string }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers as HeadersInit | undefined),
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
    });

    await client.logoutMcpAuth("workspace-1", "google-gmail", {
      denApiBase: "https://api.veslo.test",
      denToken: "den-token",
      denOrgId: "org_123",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://veslo.example/workspace/workspace-1/mcp/google-gmail/auth");
    assert.equal(calls[0]?.method, "DELETE");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer token-123");
    assert.equal(calls[0]?.headers.get("x-veslo-den-api-base"), "https://api.veslo.test");
    assert.equal(calls[0]?.headers.get("x-veslo-den-token"), "den-token");
    assert.equal(calls[0]?.headers.get("x-veslo-den-org-id"), "org_123");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("createVesloServerClient exposes workspace automation endpoints", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
  const automation = {
    id: "auto-1",
    workspaceId: "ws 1",
    name: "Daily",
    enabled: true,
    status: "active",
    schedule: { kind: "daily", hour: 9, minute: 0 },
    prompt: "Run",
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
  };
  const run = {
    id: "run-1",
    automationId: "auto-1",
    scheduledFor: "2026-06-15T09:00:00.000Z",
    status: "queued",
    createdSession: false,
  };

  globalThis.fetch = async (input, init) => {
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    }
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body,
    });
    return new Response(
      JSON.stringify({
        items: [],
        updatedAt: "2026-06-14T00:00:00.000Z",
        automation,
        run,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
      hostToken: "host-token-123",
    });

    await client.listAutomations("ws 1");
    await client.createAutomation("ws 1", {
      name: "Daily",
      schedule: { kind: "daily", hour: 9, minute: 0 },
      prompt: "Run",
      enabled: true,
    });
    await client.updateAutomation("ws 1", "auto/1", { enabled: false });
    await client.deleteAutomation("ws 1", "auto/1");
    await client.runAutomation("ws 1", "auto/1");
    await client.listAutomationRuns("ws 1", "auto/1");

    assert.deepEqual(
      calls.map((call) => ({ url: call.url, method: call.method })),
      [
        { url: "https://veslo.example/workspace/ws%201/automations", method: "GET" },
        { url: "https://veslo.example/workspace/ws%201/automations", method: "POST" },
        { url: "https://veslo.example/workspace/ws%201/automations/auto%2F1", method: "PATCH" },
        { url: "https://veslo.example/workspace/ws%201/automations/auto%2F1", method: "DELETE" },
        { url: "https://veslo.example/workspace/ws%201/automations/auto%2F1/run", method: "POST" },
        { url: "https://veslo.example/workspace/ws%201/automations/auto%2F1/runs", method: "GET" },
      ],
    );
    assert.deepEqual(calls[1]?.body, {
      name: "Daily",
      schedule: { kind: "daily", hour: 9, minute: 0 },
      prompt: "Run",
      enabled: true,
    });
    assert.deepEqual(calls[2]?.body, { enabled: false });
    for (const call of calls) {
      assert.equal(call.headers.get("authorization"), "Bearer token-123");
      assert.equal(call.headers.get("x-veslo-host-token"), "host-token-123");
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("automations domain facade exposes workspace automation endpoints", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
  const automation = {
    id: "auto-1",
    workspaceId: "ws 1",
    name: "Daily",
    enabled: true,
    status: "active",
    schedule: { kind: "daily", hour: 9, minute: 0 },
    prompt: "Run",
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
  };
  const run = {
    id: "run-1",
    automationId: "auto-1",
    scheduledFor: "2026-06-15T09:00:00.000Z",
    status: "queued",
    createdSession: false,
  };

  globalThis.fetch = async (input, init) => {
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    }
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body,
    });
    return new Response(
      JSON.stringify({
        items: [],
        updatedAt: "2026-06-14T00:00:00.000Z",
        automation,
        run,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
      hostToken: "host-token-123",
    });

    await client.automations.list("ws 1");
    await client.automations.create("ws 1", {
      name: "Daily",
      schedule: { kind: "daily", hour: 9, minute: 0 },
      prompt: "Run",
      enabled: true,
    });
    await client.automations.update("ws 1", "auto/1", { enabled: false });
    await client.automations.delete("ws 1", "auto/1");
    await client.automations.run("ws 1", "auto/1");
    await client.automations.listRuns("ws 1", "auto/1");

    assert.deepEqual(
      calls.map((call) => ({ url: call.url, method: call.method })),
      [
        { url: "https://veslo.example/workspace/ws%201/automations", method: "GET" },
        { url: "https://veslo.example/workspace/ws%201/automations", method: "POST" },
        { url: "https://veslo.example/workspace/ws%201/automations/auto%2F1", method: "PATCH" },
        { url: "https://veslo.example/workspace/ws%201/automations/auto%2F1", method: "DELETE" },
        { url: "https://veslo.example/workspace/ws%201/automations/auto%2F1/run", method: "POST" },
        { url: "https://veslo.example/workspace/ws%201/automations/auto%2F1/runs", method: "GET" },
      ],
    );
    assert.deepEqual(calls[1]?.body, {
      name: "Daily",
      schedule: { kind: "daily", hour: 9, minute: 0 },
      prompt: "Run",
      enabled: true,
    });
    assert.deepEqual(calls[2]?.body, { enabled: false });
    for (const call of calls) {
      assert.equal(call.headers.get("authorization"), "Bearer token-123");
      assert.equal(call.headers.get("x-veslo-host-token"), "host-token-123");
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("plugins domain facade exposes workspace plugin endpoints", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];

  globalThis.fetch = async (input, init) => {
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    }
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body,
    });
    return new Response(
      JSON.stringify({
        items: [],
        loadOrder: [],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
      hostToken: "host-token-123",
    });

    await client.plugins.list("ws 1", { includeGlobal: true });
    await client.plugins.add("ws 1", "veslo/example-plugin");
    await client.plugins.remove("ws 1", "plugin/name");

    assert.deepEqual(
      calls.map((call) => ({ url: call.url, method: call.method })),
      [
        { url: "https://veslo.example/workspace/ws%201/plugins?includeGlobal=true", method: "GET" },
        { url: "https://veslo.example/workspace/ws%201/plugins", method: "POST" },
        { url: "https://veslo.example/workspace/ws%201/plugins/plugin%2Fname", method: "DELETE" },
      ],
    );
    assert.deepEqual(calls[1]?.body, { spec: "veslo/example-plugin" });
    for (const call of calls) {
      assert.equal(call.headers.get("authorization"), "Bearer token-123");
      assert.equal(call.headers.get("x-veslo-host-token"), "host-token-123");
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("plugins domain facade exposes plugin policy endpoints", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];

  globalThis.fetch = async (input, init) => {
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    }
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body,
    });

    const url = String(input);
    if (url.endsWith("/materialization/sync")) {
      return new Response(
        JSON.stringify({
          ok: true,
          conflicts: [],
          project: {
            config: {
              manifestPath: "/workspace/.opencode/.veslo-plugin-specs.json",
              addedSpecs: [],
              removedSpecs: [],
              desiredSpecs: ["superpowers@git+https://github.com/obra/superpowers.git"],
            },
            files: {
              rootDir: "/workspace/.opencode/plugins",
              materializedPolicyIds: [],
              removedPolicyIds: [],
            },
          },
          user: {
            config: {
              manifestPath: "/data/plugins/.veslo-plugin-specs.json",
              addedSpecs: [],
              removedSpecs: [],
              desiredSpecs: [],
            },
            files: {
              rootDir: "/data/plugins",
              materializedPolicyIds: ["platform.superpowers"],
              removedPolicyIds: [],
            },
          },
          reloadRequired: true,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (
      url.endsWith("/platform.superpowers/enabled") ||
      url.endsWith("/platform.superpowers/restore") ||
      (init?.method === "DELETE" && url.endsWith("/platform.superpowers"))
    ) {
      return new Response(
        JSON.stringify({
          item: {
            id: "platform.superpowers",
            spec: "superpowers@git+https://github.com/obra/superpowers.git",
            displayName: "Superpowers",
            owner: { kind: "platform", id: "veslo-platform", label: "Veslo" },
            scope: "platform",
            target: "user",
            source: "policy.platform",
            visibility: "visible",
            enabled: true,
            lifecycle: "active",
            removalPolicy: "user-removable",
            enabledPolicy: "user-toggleable",
            managed: true,
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({
        items: [{ spec: "veslo/example-plugin", source: "config", scope: "project" }],
        inventory: [
          {
            id: "platform.superpowers",
            spec: "superpowers@git+https://github.com/obra/superpowers.git",
            displayName: "Superpowers",
            owner: { kind: "platform", id: "veslo-platform", label: "Veslo" },
            scope: "platform",
            target: "user",
            source: "policy.platform",
            visibility: "visible",
            enabled: true,
            lifecycle: "active",
            removalPolicy: "user-removable",
            enabledPolicy: "user-toggleable",
            managed: true,
          },
        ],
        loadOrder: [],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
      hostToken: "host-token-123",
    });

    const list = await client.plugins.list("ws 1", { includeGlobal: true, debug: true });
    const sync = await client.plugins.syncMaterialization("ws 1");
    const enabled = await client.plugins.setEnabled("ws 1", "platform.superpowers", false);
    const removedLegacy = await client.plugins.remove("ws 1", "veslo/example-plugin");
    const removedManaged = await client.plugins.removeManaged("ws 1", "platform.superpowers");
    const restored = await client.plugins.restore("ws 1", "platform.superpowers");
    await client.plugins.add("ws 1", "veslo/example-plugin");

    assert.equal(list.inventory?.[0]?.id, "platform.superpowers");
    assert.equal(sync.reloadRequired, true);
    assert.equal(enabled.item.lifecycle, "active");
    assert.deepEqual(removedLegacy.items.map((item) => item.spec), ["veslo/example-plugin"]);
    assert.equal(removedManaged.item.managed, true);
    assert.equal(restored.item.removalPolicy, "user-removable");

    assert.deepEqual(
      calls.map((call) => ({ url: call.url, method: call.method })),
      [
        { url: "https://veslo.example/workspace/ws%201/plugins?includeGlobal=true&debug=true", method: "GET" },
        { url: "https://veslo.example/workspace/ws%201/plugins/materialization/sync", method: "POST" },
        { url: "https://veslo.example/workspace/ws%201/plugins/platform.superpowers/enabled", method: "POST" },
        { url: "https://veslo.example/workspace/ws%201/plugins/veslo%2Fexample-plugin", method: "DELETE" },
        { url: "https://veslo.example/workspace/ws%201/plugins/platform.superpowers", method: "DELETE" },
        { url: "https://veslo.example/workspace/ws%201/plugins/platform.superpowers/restore", method: "POST" },
        { url: "https://veslo.example/workspace/ws%201/plugins", method: "POST" },
      ],
    );
    assert.deepEqual(calls[2]?.body, { enabled: false });
    assert.deepEqual(calls[6]?.body, { spec: "veslo/example-plugin" });
    for (const call of calls) {
      assert.equal(call.headers.get("authorization"), "Bearer token-123");
      assert.equal(call.headers.get("x-veslo-host-token"), "host-token-123");
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("commands domain facade exposes workspace command endpoints", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];

  globalThis.fetch = async (input, init) => {
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    }
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body,
    });
    return new Response(
      JSON.stringify({
        ok: true,
        items: [],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
      hostToken: "host-token-123",
    });

    await client.commands.list("ws 1", "global");
    await client.commands.upsert("ws 1", {
      name: "ship",
      description: "Ship it",
      template: "pnpm test",
      agent: "build",
      model: "gpt-5.1",
      subtask: true,
    });
    await client.commands.delete("ws 1", "command/name");

    assert.deepEqual(
      calls.map((call) => ({ url: call.url, method: call.method })),
      [
        { url: "https://veslo.example/workspace/ws%201/commands?scope=global", method: "GET" },
        { url: "https://veslo.example/workspace/ws%201/commands", method: "POST" },
        { url: "https://veslo.example/workspace/ws%201/commands/command%2Fname", method: "DELETE" },
      ],
    );
    assert.deepEqual(calls[1]?.body, {
      name: "ship",
      description: "Ship it",
      template: "pnpm test",
      agent: "build",
      model: "gpt-5.1",
      subtask: true,
    });
    for (const call of calls) {
      assert.equal(call.headers.get("authorization"), "Bearer token-123");
      assert.equal(call.headers.get("x-veslo-host-token"), "host-token-123");
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("mcp domain facade exposes hub and workspace mcp endpoints", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];

  globalThis.fetch = async (input, init) => {
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    }
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body,
    });
    return new Response(
      JSON.stringify({
        ok: true,
        items: [],
        name: "google-gmail",
        path: "/workspace/.opencode/mcp/google-gmail.json",
        action: "updated",
        written: 1,
        skipped: 0,
        expiresAt: null,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
      hostToken: "host-token-123",
    });

    const denContext = {
      denApiBase: "https://api.veslo.test",
      denToken: "den-token",
      denOrgId: "org-123",
    };

    await client.mcp.listHub(denContext);
    await client.mcp.installHub("ws 1", "google/gmail", denContext);
    await client.mcp.list("ws 1");
    await client.mcp.add("ws 1", { name: "local", config: { type: "local", command: ["node", "server.js"] } });
    await client.mcp.remove("ws 1", "local/name");
    await client.mcp.refreshRuntimeToken("ws 1", "google-gmail", denContext);
    await client.mcp.logoutAuth("ws 1", "google-gmail", denContext);

    assert.deepEqual(
      calls.map((call) => ({ url: call.url, method: call.method })),
      [
        { url: "https://veslo.example/hub/mcp", method: "GET" },
        { url: "https://veslo.example/workspace/ws%201/mcp/hub/google%2Fgmail", method: "POST" },
        { url: "https://veslo.example/workspace/ws%201/mcp", method: "GET" },
        { url: "https://veslo.example/workspace/ws%201/mcp", method: "POST" },
        { url: "https://veslo.example/workspace/ws%201/mcp/local%2Fname", method: "DELETE" },
        { url: "https://veslo.example/workspace/ws%201/mcp/google-gmail/runtime-token/refresh", method: "POST" },
        { url: "https://veslo.example/workspace/ws%201/mcp/google-gmail/auth", method: "DELETE" },
      ],
    );
    assert.deepEqual(calls[3]?.body, {
      name: "local",
      config: { type: "local", command: ["node", "server.js"] },
    });
    for (const call of calls) {
      assert.equal(call.headers.get("authorization"), "Bearer token-123");
      assert.equal(call.headers.get("x-veslo-host-token"), "host-token-123");
    }
    for (const index of [0, 1, 5, 6]) {
      assert.equal(calls[index]?.headers.get("x-veslo-den-api-base"), "https://api.veslo.test");
      assert.equal(calls[index]?.headers.get("x-veslo-den-token"), "den-token");
      assert.equal(calls[index]?.headers.get("x-veslo-den-org-id"), "org-123");
    }
    for (const index of [2, 3, 4]) {
      assert.equal(calls[index]?.headers.has("x-veslo-den-api-base"), false);
      assert.equal(calls[index]?.headers.has("x-veslo-den-token"), false);
      assert.equal(calls[index]?.headers.has("x-veslo-den-org-id"), false);
    }
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

test("Soul mutation helpers forward active workspace ids and expose materialization sync", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string; headers: Headers; body: string | null }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body: typeof init?.body === "string" ? init.body : null,
    });
    return new Response(JSON.stringify({ ok: true, status: "pending", pending: true, files: [] }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
      hostToken: "host-token-123",
    });

    await client.updateUserSoul({
      content: "# User",
      changeSummary: "Update user",
      baseVersionId: "user_v1",
      activeWorkspaceIds: ["workspace-a", "workspace-a", "workspace-b"],
    });
    await client.restoreWorkspaceSoulVersion("workspace a", "workspace_v1", {
      changeSummary: "Restore workspace",
      activeWorkspaceIds: ["workspace-a"],
    });
    await client.syncWorkspaceSoulMaterialization("workspace a", { activeRun: true });

    assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${call.url}`), [
      "PATCH https://veslo.example/soul/user",
      "POST https://veslo.example/workspace/workspace%20a/soul/versions/workspace_v1/restore",
      "POST https://veslo.example/workspace/workspace%20a/soul/materialization/sync",
    ]);
    assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
      content: "# User",
      changeSummary: "Update user",
      baseVersionId: "user_v1",
      activeWorkspaceIds: ["workspace-a", "workspace-b"],
    });
    assert.deepEqual(JSON.parse(calls[1]?.body ?? "{}"), {
      changeSummary: "Restore workspace",
      activeWorkspaceIds: ["workspace-a"],
    });
    assert.deepEqual(JSON.parse(calls[2]?.body ?? "{}"), { activeRun: true });
    for (const call of calls) {
      assert.equal(call.headers.get("authorization"), "Bearer token-123");
      assert.equal(call.headers.get("x-veslo-host-token"), "host-token-123");
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("provisionWorkspaceSystem forwards Den context for Soul materialization", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string; headers: Headers }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers as HeadersInit | undefined),
    });
    return new Response(JSON.stringify({
      ok: true,
      workspaceId: "workspace a",
      version: "1",
      status: "unchanged",
      written: 0,
      unchanged: 1,
      soulMaterialization: { ok: true, status: "current", pending: false, files: [] },
    }), {
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

    await client.provisionWorkspaceSystem("workspace a", {
      denApiBase: "https://den.example",
      denToken: "den-token",
      denOrgId: "org_1",
      denUserId: "user_1",
    });

    assert.deepEqual(calls.map((call) => `${call.method ?? "GET"} ${call.url}`), [
      "POST https://veslo.example/workspace/workspace%20a/system/provision",
    ]);
    const headers = calls[0]!.headers;
    assert.equal(headers.get("authorization"), "Bearer token-123");
    assert.equal(headers.get("x-veslo-host-token"), "host-token-123");
    assert.equal(headers.get("x-veslo-den-api-base"), "https://den.example");
    assert.equal(headers.get("x-veslo-den-token"), "den-token");
    assert.equal(headers.get("x-veslo-den-org-id"), "org_1");
    assert.equal(headers.get("x-veslo-den-user-id"), "user_1");
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

    if (url.endsWith("/ai-gateway/me/runtime-authorization/clear")) {
      return new Response(JSON.stringify({ ok: true }), {
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
    assert.equal(typeof client.clearMyAiGatewayRuntimeAuthorization, "function");

    const response = await client.getMyAiAccess("den-user-token");
    const clearResponse = await client.clearMyAiGatewayRuntimeAuthorization();

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
    assert.deepEqual(clearResponse, { ok: true });

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
      {
        url: "http://127.0.0.1:8787/ai-gateway/me/runtime-authorization/clear",
        method: "POST",
        headers: {
          authorization: "Bearer veslo-server-token",
          "content-type": "application/json",
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

test("files domain facade exposes file session, workspace file and artifact endpoints", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: unknown }> = [];

  globalThis.fetch = async (input, init) => {
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    }
    calls.push({ url: String(input), method: init?.method ?? "GET", body });
    return new Response(JSON.stringify({ ok: true, items: [], session: {} }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": "attachment; filename=\"artifact.txt\"",
      },
    });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
      hostToken: "host-token-123",
    });

    await client.files.createSession("ws 1", { ttlSeconds: 60, write: true });
    await client.files.getCatalogSnapshot("session/1", { prefix: "src", includeDirs: true, limit: 50 });
    await client.files.readWorkspaceFile("ws 1", "src/index.ts");
    await client.files.writeWorkspaceFile("ws 1", { path: "src/index.ts", content: "export {};" });
    await client.files.listArtifacts("ws 1");
    await client.files.downloadArtifact("ws 1", "artifact/1");

    assert.deepEqual(
      calls.map((call) => ({ url: call.url, method: call.method })),
      [
        { url: "https://veslo.example/workspace/ws%201/files/sessions", method: "POST" },
        {
          url: "https://veslo.example/files/sessions/session%2F1/catalog/snapshot?prefix=src&includeDirs=true&limit=50",
          method: "GET",
        },
        { url: "https://veslo.example/workspace/ws%201/files/content?path=src%2Findex.ts", method: "GET" },
        { url: "https://veslo.example/workspace/ws%201/files/content", method: "POST" },
        { url: "https://veslo.example/workspace/ws%201/artifacts", method: "GET" },
        { url: "https://veslo.example/workspace/ws%201/artifacts/artifact%2F1", method: "GET" },
      ],
    );
    assert.deepEqual(calls[0]?.body, { ttlSeconds: 60, write: true });
    assert.deepEqual(calls[3]?.body, { path: "src/index.ts", content: "export {};" });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("extensions inventory domain facade aggregates read-only extension requests", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response(JSON.stringify({ ok: true, items: [], loadOrder: [] }), {
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

    await client.extensionsInventory.overview("ws 1", {
      includeGlobalPlugins: true,
      includeGlobalSkills: true,
      commandScope: "global",
    });

    assert.deepEqual(
      calls.map((call) => ({ url: call.url, method: call.method })),
      [
        { url: "https://veslo.example/workspace/ws%201/mcp", method: "GET" },
        { url: "https://veslo.example/workspace/ws%201/plugins?includeGlobal=true", method: "GET" },
        { url: "https://veslo.example/workspace/ws%201/skills?includeGlobal=true", method: "GET" },
        { url: "https://veslo.example/workspace/ws%201/commands?scope=global", method: "GET" },
      ],
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("createVesloServerClient exposes remaining domain facades", async () => {
  const client = createVesloServerClient({
    baseUrl: "https://veslo.example",
    token: "token-123",
    hostToken: "host-token-123",
  });

  assert.equal(typeof client.skills.list, "function");
  assert.equal(typeof client.soul.overview, "function");
  assert.equal(typeof client.workspace.list, "function");
  assert.equal(typeof client.conversations.list, "function");
  assert.equal(typeof client.files.createSession, "function");
  assert.equal(typeof client.extensionsInventory.overview, "function");
});

test("skills domain facade exposes workspace, registry and materialization endpoints", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];

  globalThis.fetch = async (input, init) => {
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    }
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body,
    });
    const payload = String(input).includes("/v1/skills/search")
      ? { query: "alpha", skills: [] }
      : { ok: true, items: [], scope: "personal-global", synced: true, conflicts: [], materializedSkills: [] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
      hostToken: "host-token-123",
    });

    await client.skills.list("ws 1", { includeGlobal: true, includeDisabled: true });
    await client.skills.searchRegistry({ q: "alpha", workspaceId: "ws 1" });
    await client.skills.getGlobalMaterializationStatus();
    await client.skills.syncWorkspaceMaterialization("ws 1", { activeRun: true, denToken: "den-token" });
    await client.skills.listHub({ denToken: "den-token", denOrgId: "org-123" });
    await client.skills.installHub("ws 1", "owner/skill", { overwrite: true });
    await client.skills.deleteGlobal("global/skill", { reason: "cleanup" });
    await client.skills.listRemovals({ scope: "workspace", workspaceId: "ws 1", includeRestored: true });
    await client.skills.listImportCandidates();
    await client.skills.importCandidates(["candidate-1", "candidate-2"]);

    assert.deepEqual(
      calls.map((call) => ({ url: call.url, method: call.method })),
      [
        { url: "https://veslo.example/workspace/ws%201/skills?includeGlobal=true&includeDisabled=true", method: "GET" },
        { url: "https://veslo.example/v1/skills/search?q=alpha&workspaceId=ws+1", method: "GET" },
        { url: "https://veslo.example/skills/materialization", method: "GET" },
        { url: "https://veslo.example/workspace/ws%201/skills/materialization/sync", method: "POST" },
        { url: "https://veslo.example/hub/skills", method: "GET" },
        { url: "https://veslo.example/workspace/ws%201/skills/hub/owner%2Fskill", method: "POST" },
        { url: "https://veslo.example/skills/user-global/global%2Fskill?reason=cleanup", method: "DELETE" },
        { url: "https://veslo.example/skill-removals?scope=workspace&workspaceId=ws+1&includeRestored=true", method: "GET" },
        { url: "https://veslo.example/skills/import-candidates", method: "GET" },
        { url: "https://veslo.example/skills/import-candidates/import", method: "POST" },
      ],
    );
    assert.deepEqual(calls[3]?.body, { activeRun: true });
    assert.deepEqual(calls[9]?.body, { candidateIds: ["candidate-1", "candidate-2"] });
    assert.equal(calls[3]?.headers.get("x-veslo-den-token"), "den-token");
    assert.equal(calls[4]?.headers.get("x-veslo-den-token"), "den-token");
    assert.equal(calls[4]?.headers.get("x-veslo-den-org-id"), "org-123");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("soul domain facade exposes soul read and mutation endpoints", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];

  globalThis.fetch = async (input, init) => {
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    }
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body,
    });
    return new Response(JSON.stringify({ ok: true, items: [], versions: [], total: 0 }), {
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

    await client.soul.overview({ denToken: "den-token" });
    await client.soul.getWorkspace("ws 1", { denOrgId: "org-123" });
    await client.soul.updateWorkspace("ws 1", {
      content: "memory",
      changeSummary: "update",
      baseVersionId: null,
      activeWorkspaceIds: ["ws 1", "ws 1"],
    });
    await client.soul.restoreWorkspaceVersion("ws 1", "version/1", { activeRun: true });

    assert.deepEqual(
      calls.map((call) => ({ url: call.url, method: call.method })),
      [
        { url: "https://veslo.example/soul", method: "GET" },
        { url: "https://veslo.example/workspace/ws%201/soul", method: "GET" },
        { url: "https://veslo.example/workspace/ws%201/soul", method: "PATCH" },
        { url: "https://veslo.example/workspace/ws%201/soul/versions/version%2F1/restore", method: "POST" },
      ],
    );
    assert.equal(calls[0]?.headers.get("x-veslo-den-token"), "den-token");
    assert.equal(calls[1]?.headers.get("x-veslo-den-org-id"), "org-123");
    assert.deepEqual(calls[2]?.body, {
      content: "memory",
      changeSummary: "update",
      baseVersionId: null,
      activeWorkspaceIds: ["ws 1"],
    });
    assert.deepEqual(calls[3]?.body, { activeRun: true });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("workspace domain facade exposes management and status endpoints", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: unknown }> = [];

  globalThis.fetch = async (input, init) => {
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    }
    calls.push({ url: String(input), method: init?.method ?? "GET", body });
    return new Response(JSON.stringify({ ok: true, items: [], activeId: null, workspace: null }), {
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

    await client.workspace.health();
    await client.workspace.status();
    await client.workspace.statusForWorkspace("ws 1");
    await client.workspace.list();
    await client.workspace.activate("ws 1");
    await client.workspace.addLocal({ path: "C:/work", name: "Work" });
    await client.workspace.patchConfig("ws 1", { opencode: { baseUrl: "http://127.0.0.1:4096" } });
    await client.workspace.listReloadEvents("ws 1", { since: 12 });
    await client.workspace.listAudit("ws 1", 10);
    await client.workspace.deleteScheduledJob("ws 1", "daily/job");

    assert.deepEqual(
      calls.map((call) => ({ url: call.url, method: call.method })),
      [
        { url: "https://veslo.example/health", method: "GET" },
        { url: "https://veslo.example/status", method: "GET" },
        { url: "https://veslo.example/w/ws%201/status", method: "GET" },
        { url: "https://veslo.example/workspaces", method: "GET" },
        { url: "https://veslo.example/workspaces/ws%201/activate", method: "POST" },
        { url: "https://veslo.example/workspaces/local", method: "POST" },
        { url: "https://veslo.example/workspace/ws%201/config", method: "PATCH" },
        { url: "https://veslo.example/workspace/ws%201/events?since=12", method: "GET" },
        { url: "https://veslo.example/workspace/ws%201/audit?limit=10", method: "GET" },
        { url: "https://veslo.example/workspace/ws%201/scheduler/jobs/daily%2Fjob", method: "DELETE" },
      ],
    );
    assert.deepEqual(calls[5]?.body, { path: "C:/work", name: "Work" });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("conversations domain facade exposes conversation, transcript and archive endpoints", async () => {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];

  globalThis.fetch = async (input, init) => {
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    }
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers as HeadersInit | undefined),
      body,
    });
    return new Response(JSON.stringify({ ok: true, items: [], queuedSessionIds: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = createVesloServerClient({
      baseUrl: "https://veslo.example",
      token: "token-123",
      hostToken: "host-token-123",
      accountId: "account-123",
    });

    await client.conversations.list("ws 1", "src", { sync: true });
    await client.conversations.create("ws 1", { directory: "src", title: "Task" }, { sendTraceId: "trace-123" });
    await client.conversations.run("ws 1", "conv/1", { kind: "command", command: "test" }, { sendTraceId: "trace-456" });
    await client.conversations.getTranscript("ws 1", "session/1", { directory: "src", limit: 20 });
    await client.conversations.listArchives();
    await client.conversations.deleteArchive("session/1", { workspaceId: "ws 1" });

    assert.deepEqual(
      calls.map((call) => ({ url: call.url, method: call.method })),
      [
        { url: "https://veslo.example/workspace/ws%201/conversations?directory=src&sync=true", method: "GET" },
        { url: "https://veslo.example/workspace/ws%201/conversations", method: "POST" },
        { url: "https://veslo.example/workspace/ws%201/conversations/conv%2F1/runs", method: "POST" },
        { url: "https://veslo.example/workspace/ws%201/sessions/session%2F1/transcript?limit=20&directory=src", method: "GET" },
        { url: "https://veslo.example/session-archives", method: "GET" },
        { url: "https://veslo.example/session-archives/session%2F1?workspaceId=ws+1", method: "DELETE" },
      ],
    );
    assert.equal(calls[1]?.headers.get("x-veslo-send-trace-id"), "trace-123");
    assert.equal(calls[2]?.headers.get("x-veslo-send-trace-id"), "trace-456");
    assert.equal(calls[4]?.headers.get("x-veslo-account-id"), "account-123");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
