import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { resolveLegacyAgentLabAutomationsPath, writeAutomationStore } from "./automation-store.js";
import type { AutomationRun, VesloAutomation } from "./automations.js";
import { startServer } from "./server.js";

const runningServers: Array<{ stop?: (closeActiveConnections?: boolean) => void }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (runningServers.length > 0) {
    const server = runningServers.pop();
    try {
      server?.stop?.(true);
    } catch {
      // ignore cleanup errors in tests
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /workspace/ws_1/automations returns migrated legacy items", async () => {
  const fixture = await startFixture();
  await writeLegacyAutomationStore(fixture.workspaceRoot);

  const response = await fixture.clientFetch("/workspace/ws_1/automations");

  expect(response.status).toBe(200);
  const payload = await response.json() as { items: VesloAutomation[]; updatedAt: string };
  expect(payload.updatedAt).toBe("2026-06-01T10:00:00.000Z");
  expect(payload.items).toHaveLength(1);
  expect(payload.items[0]).toMatchObject({
    id: "agentlab_daily",
    workspaceId: "ws_1",
    name: "Legacy Daily",
    enabled: true,
    status: "active",
    schedule: { kind: "daily", hour: 9, minute: 0 },
    prompt: "Legacy prompt",
    target: {},
  });
});

test("POST /workspace/ws_1/automations creates a one-shot automation with nextRunAt", async () => {
  const fixture = await startFixture();
  const runAt = futureRunAt();

  const response = await fixture.clientFetch("/workspace/ws_1/automations", {
    method: "POST",
    body: {
      name: "One shot",
      prompt: "Run once",
      schedule: { kind: "oneShot", runAt },
      target: { fallbackTitle: "Follow up" },
    },
  });

  expect(response.status).toBe(201);
  const payload = await response.json() as { automation: VesloAutomation };
  expect(payload.automation).toMatchObject({
    workspaceId: "ws_1",
    name: "One shot",
    enabled: true,
    status: "active",
    schedule: { kind: "oneShot", runAt },
    prompt: "Run once",
    target: { fallbackTitle: "Follow up" },
    nextRunAt: runAt,
  });
});

test("PATCH /workspace/ws_1/automations/:id can pause and update schedule", async () => {
  const fixture = await startFixture();
  const created = await fixture.createAutomation();

  const response = await fixture.clientFetch(`/workspace/ws_1/automations/${created.id}`, {
    method: "PATCH",
    body: {
      enabled: false,
      status: "paused",
      schedule: { kind: "interval", seconds: 3600 },
    },
  });

  expect(response.status).toBe(200);
  const payload = await response.json() as { automation: VesloAutomation };
  expect(payload.automation).toMatchObject({
    id: created.id,
    enabled: false,
    status: "paused",
    schedule: { kind: "interval", seconds: 3600 },
    nextRunAt: null,
  });
});

test("POST /workspace/ws_1/automations/:id/run creates a run and posts prompt to OpenCode", async () => {
  const fixture = await startFixture();
  const created = await fixture.createAutomation({
    target: { preferredSessionId: "ses_existing", fallbackTitle: "Fallback title" },
  });

  const response = await fixture.clientFetch(`/workspace/ws_1/automations/${created.id}/run`, {
    method: "POST",
  });

  expect(response.status).toBe(200);
  const payload = await response.json() as { run: AutomationRun };
  expect(payload.run).toMatchObject({
    automationId: created.id,
    status: "success",
    sessionId: "ses_existing",
    createdSession: false,
  });
  expect(fixture.opencCodeCalls).toContainEqual({
    method: "GET",
    pathname: "/session/ses_existing",
    body: null,
  });
  expect(fixture.opencCodeCalls).toContainEqual({
    method: "POST",
    pathname: "/session/ses_existing/prompt_async",
    body: { parts: [{ type: "text", text: "Run once" }] },
  });
});

test("GET /workspace/ws_1/automations/:id/runs returns run history", async () => {
  const fixture = await startFixture();
  const automation = fixture.makeAutomation({ id: "auto_history" });
  const run = fixture.makeRun({ id: "run_auto_history", automationId: automation.id });
  await writeAutomationStore(fixture.workspaceRoot, {
    schemaVersion: 1,
    updatedAt: "2026-06-05T12:05:00.000Z",
    items: [automation],
    runs: [run],
  });

  const response = await fixture.clientFetch("/workspace/ws_1/automations/auto_history/runs");

  expect(response.status).toBe(200);
  const payload = await response.json() as { items: AutomationRun[] };
  expect(payload.items).toEqual([run]);
});

test("DELETE /workspace/ws_1/automations/:id cancels active definition while preserving history", async () => {
  const fixture = await startFixture();
  const automation = fixture.makeAutomation({ id: "auto_delete" });
  const run = fixture.makeRun({ id: "run_auto_delete", automationId: automation.id });
  await writeAutomationStore(fixture.workspaceRoot, {
    schemaVersion: 1,
    updatedAt: "2026-06-05T12:05:00.000Z",
    items: [automation],
    runs: [run],
  });

  const deleteResponse = await fixture.clientFetch("/workspace/ws_1/automations/auto_delete", {
    method: "DELETE",
  });

  expect(deleteResponse.status).toBe(200);
  const deletePayload = await deleteResponse.json() as { automation: VesloAutomation };
  expect(deletePayload.automation).toMatchObject({
    id: "auto_delete",
    enabled: false,
    status: "cancelled",
    nextRunAt: null,
  });

  const runsResponse = await fixture.clientFetch("/workspace/ws_1/automations/auto_delete/runs");
  expect(runsResponse.status).toBe(200);
  const runsPayload = await runsResponse.json() as { items: AutomationRun[] };
  expect(runsPayload.items).toEqual([run]);
});

test("collaborator auth is required for automation mutations", async () => {
  const fixture = await startFixture();
  const viewerToken = await fixture.createViewerToken();
  const created = await fixture.createAutomation();

  const createResponse = await fixture.clientFetch("/workspace/ws_1/automations", {
    method: "POST",
    token: viewerToken,
    body: {
      name: "Viewer create",
      prompt: "Nope",
      schedule: { kind: "oneShot", runAt: futureRunAt() },
    },
  });
  const patchResponse = await fixture.clientFetch(`/workspace/ws_1/automations/${created.id}`, {
    method: "PATCH",
    token: viewerToken,
    body: { status: "paused" },
  });
  const runResponse = await fixture.clientFetch(`/workspace/ws_1/automations/${created.id}/run`, {
    method: "POST",
    token: viewerToken,
  });
  const deleteResponse = await fixture.clientFetch(`/workspace/ws_1/automations/${created.id}`, {
    method: "DELETE",
    token: viewerToken,
  });

  expect(createResponse.status).toBe(403);
  expect(patchResponse.status).toBe(403);
  expect(runResponse.status).toBe(403);
  expect(deleteResponse.status).toBe(403);
});

async function startFixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-automations-route-"));
  tempDirs.push(workspaceRoot);
  const opencCodeCalls: Array<{ method: string; pathname: string; body: unknown }> = [];

  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = request.method === "GET" ? null : await request.json().catch(() => null);
      opencCodeCalls.push({ method: request.method, pathname: url.pathname, body });

      if (request.method === "GET" && url.pathname === "/session/ses_existing") return json(200, { id: "ses_existing" });
      if (request.method === "POST" && url.pathname === "/session") return json(200, { id: "ses_new" });
      if (request.method === "POST" && url.pathname === "/session/ses_new/prompt_async") return json(200, { ok: true });
      if (request.method === "POST" && url.pathname === "/session/ses_existing/prompt_async") return json(200, { ok: true });
      return json(404, { code: "not_found" });
    },
  });
  runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

  const server = startServer({
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [
      {
        id: "ws_1",
        name: "Workspace",
        path: workspaceRoot,
        workspaceType: "local",
        baseUrl: `http://127.0.0.1:${upstream.port}`,
      },
    ],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
    debugLogs: {
      enabled: false,
      ingestUrl: null,
      ingestToken: null,
      batchMaxEvents: 200,
      batchMaxBytes: 256 * 1024,
      spoolMaxBytes: 100 * 1024 * 1024,
      flushIntervalMs: 5000,
    },
  });
  runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });

  const clientFetch = (path: string, options: {
    method?: string;
    token?: string;
    body?: Record<string, unknown>;
  } = {}) => {
    const headers = new Headers({ Authorization: `Bearer ${options.token ?? "client-token"}` });
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    return fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  };

  const createViewerToken = async (): Promise<string> => {
    const response = await fetch(`http://127.0.0.1:${server.port}/tokens`, {
      method: "POST",
      headers: {
        "x-veslo-host-token": "host-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ scope: "viewer" }),
    });
    expect(response.status).toBe(201);
    const payload = await response.json() as { token: string };
    return payload.token;
  };

  const createAutomation = async (overrides: Record<string, unknown> = {}): Promise<VesloAutomation> => {
    const response = await clientFetch("/workspace/ws_1/automations", {
      method: "POST",
      body: {
        name: "One shot",
        prompt: "Run once",
        schedule: { kind: "oneShot", runAt: futureRunAt() },
        ...overrides,
      },
    });
    expect(response.status).toBe(201);
    const payload = await response.json() as { automation: VesloAutomation };
    return payload.automation;
  };

  return {
    server,
    workspaceRoot,
    opencCodeCalls,
    clientFetch,
    createViewerToken,
    createAutomation,
    makeAutomation,
    makeRun,
  };
}

async function writeLegacyAutomationStore(workspaceRoot: string): Promise<void> {
  const legacyPath = resolveLegacyAgentLabAutomationsPath(workspaceRoot);
  await mkdir(join(workspaceRoot, ".opencode", "veslo", "agentlab"), { recursive: true });
  await writeFile(legacyPath, JSON.stringify({
    schemaVersion: 1,
    updatedAt: Date.parse("2026-06-01T10:00:00.000Z"),
    items: [{
      id: "agentlab_daily",
      name: "Legacy Daily",
      enabled: true,
      schedule: { kind: "daily", hour: 9, minute: 0 },
      prompt: "Legacy prompt",
      createdAt: Date.parse("2026-06-01T10:00:00.000Z"),
      lastRunAt: Date.parse("2026-06-02T09:00:00.000Z"),
      lastRunSessionId: "ses_legacy",
    }],
  }, null, 2) + "\n", "utf8");
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeAutomation(overrides: Partial<VesloAutomation> = {}): VesloAutomation {
  return {
    id: "auto_daily",
    workspaceId: "ws_1",
    name: "Daily",
    enabled: true,
    status: "active",
    schedule: { kind: "daily", hour: 9, minute: 0 },
    prompt: "Run daily check",
    target: {},
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T10:00:00.000Z",
    nextRunAt: futureRunAt(),
    completedAt: null,
    lastRunId: null,
    ...overrides,
  };
}

function futureRunAt(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "run_auto_daily_1",
    automationId: "auto_daily",
    scheduledFor: "2026-06-01T09:00:00.000Z",
    startedAt: "2026-06-01T09:00:01.000Z",
    finishedAt: "2026-06-01T09:02:00.000Z",
    status: "success",
    sessionId: "ses_daily",
    createdSession: false,
    error: null,
    ...overrides,
  };
}
