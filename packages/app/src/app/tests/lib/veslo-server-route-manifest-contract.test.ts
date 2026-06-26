import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createVesloServerClient } from "../../lib/veslo-server.js";

type CapturedRequest = {
  method: string;
  path: string;
};

type RouteTemplate = {
  method: string;
  path: string;
};

const readServerRouteSource = (routeFileName: string) =>
  readFileSync(new URL(`../../../../../server/src/routes/${routeFileName}`, import.meta.url), "utf8");

const extractRouteTemplates = (source: string): RouteTemplate[] => {
  const templates: RouteTemplate[] = [];
  const routePattern = /addRoute\(routes,\s*"([^"]+)",\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = routePattern.exec(source)) !== null) {
    templates.push({ method: match[1]!, path: match[2]! });
  }
  return templates;
};

const pathMatchesTemplate = (template: string, path: string) => {
  const templateParts = template.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  if (templateParts.length !== pathParts.length) return false;
  return templateParts.every((part, index) => part.startsWith(":") || part === pathParts[index]);
};

const assertRequestsMatchServerRoutes = (source: string, requests: CapturedRequest[]) => {
  const templates = extractRouteTemplates(source);
  for (const request of requests) {
    const matched = templates.some(
      (template) => template.method === request.method && pathMatchesTemplate(template.path, request.path),
    );
    assert.equal(
      matched,
      true,
      `${request.method} ${request.path} is not covered by the extracted server route manifest`,
    );
  }
};

const captureClientRequests = async (run: () => Promise<void>) => {
  const previousFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
    });
    return new Response(
      JSON.stringify({
        ok: true,
        items: [],
        updatedAt: "2026-06-26T00:00:00.000Z",
        automation: {},
        run: {},
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };

  try {
    await run();
    return requests;
  } finally {
    globalThis.fetch = previousFetch;
  }
};

test("automations domain facade requests match the extracted server route manifest", async () => {
  const client = createVesloServerClient({
    baseUrl: "https://veslo.example",
    token: "token-123",
    hostToken: "host-token-123",
  });
  const requests = await captureClientRequests(async () => {
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
  });

  assertRequestsMatchServerRoutes(readServerRouteSource("automations.ts"), requests);
});

test("messaging identities workspace requests match the extracted OpenCode Router route manifest", async () => {
  const client = createVesloServerClient({
    baseUrl: "https://veslo.example",
    token: "token-123",
    hostToken: "host-token-123",
  });
  const requests = await captureClientRequests(async () => {
    await client.identities.setTelegramToken("ws 1", "telegram-token", 3005);
    await client.identities.getTelegram("ws 1");
    await client.identities.setTelegramEnabled("ws 1", true);
    await client.identities.setSlackTokens("ws 1", "bot-token", "app-token", 3005);
    await client.identities.getTelegramIdentities("ws 1", { healthPort: 3005 });
    await client.identities.upsertTelegramIdentity(
      "ws 1",
      { token: "telegram-token", enabled: true },
      { healthPort: 3005 },
    );
    await client.identities.deleteTelegramIdentity("ws 1", "telegram/1", { healthPort: 3005 });
    await client.identities.getSlackIdentities("ws 1", { healthPort: 3005 });
    await client.identities.upsertSlackIdentity(
      "ws 1",
      { botToken: "bot-token", appToken: "app-token", enabled: true },
      { healthPort: 3005 },
    );
    await client.identities.deleteSlackIdentity("ws 1", "slack/1", { healthPort: 3005 });
    await client.identities.getBindings("ws 1", { channel: "telegram", identityId: "telegram/1", healthPort: 3005 });
    await client.identities.setBinding(
      "ws 1",
      { channel: "telegram", identityId: "telegram/1", peerId: "peer-1" },
      { healthPort: 3005 },
    );
    await client.identities.sendMessage(
      "ws 1",
      { channel: "telegram", text: "hello", identityId: "telegram/1", peerId: "peer-1" },
      { healthPort: 3005 },
    );
  });

  assertRequestsMatchServerRoutes(readServerRouteSource("opencode-router.ts"), requests);
});

test("plugins domain facade requests match the extracted server route manifest", async () => {
  const client = createVesloServerClient({
    baseUrl: "https://veslo.example",
    token: "token-123",
    hostToken: "host-token-123",
  });
  const requests = await captureClientRequests(async () => {
    await client.plugins.list("ws 1", { includeGlobal: true });
    await client.plugins.add("ws 1", "veslo/example-plugin");
    await client.plugins.remove("ws 1", "plugin/name");
  });

  assertRequestsMatchServerRoutes(readServerRouteSource("plugins.ts"), requests);
});

test("commands domain facade requests match the extracted server route manifest", async () => {
  const client = createVesloServerClient({
    baseUrl: "https://veslo.example",
    token: "token-123",
    hostToken: "host-token-123",
  });
  const requests = await captureClientRequests(async () => {
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
  });

  assertRequestsMatchServerRoutes(readServerRouteSource("commands.ts"), requests);
});

test("mcp domain facade requests match the extracted server route manifest", async () => {
  const client = createVesloServerClient({
    baseUrl: "https://veslo.example",
    token: "token-123",
    hostToken: "host-token-123",
  });
  const requests = await captureClientRequests(async () => {
    await client.mcp.listHub({ denToken: "den-token", denOrgId: "org-123" });
    await client.mcp.installHub("ws 1", "google/gmail", { denToken: "den-token", denOrgId: "org-123" });
    await client.mcp.list("ws 1");
    await client.mcp.add("ws 1", { name: "local", config: { type: "local", command: ["node", "server.js"] } });
    await client.mcp.remove("ws 1", "local/name");
    await client.mcp.refreshRuntimeToken("ws 1", "google-gmail", { denToken: "den-token", denOrgId: "org-123" });
    await client.mcp.logoutAuth("ws 1", "google-gmail");
  });

  assertRequestsMatchServerRoutes(readServerRouteSource("mcp.ts"), requests);
});
