import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { resolveAutomationsPath, resolveLegacyAgentLabAutomationsPath, writeAutomationStore } from "../automation-store.js";
import type { AutomationRun, VesloAutomation } from "../automations.js";
import { startServer } from "../server.js";

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
  expect(fixture.openCodeCalls).toContainEqual({
    method: "GET",
    pathname: "/session/ses_existing",
    body: null,
  });
  expect(fixture.openCodeCalls).toContainEqual({
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

test("read-only automation list migrates legacy items in memory without writing canonical store", async () => {
  const fixture = await startFixture({
    readOnly: true,
    beforeStart: async (workspaceRoot) => {
      await writeLegacyAutomationStore(workspaceRoot);
    },
  });

  const response = await fixture.clientFetch("/workspace/ws_1/automations");

  expect(response.status).toBe(200);
  const payload = await response.json() as { items: VesloAutomation[] };
  expect(payload.items.map((item) => item.id)).toEqual(["agentlab_daily"]);
  await expect(readFile(resolveAutomationsPath(fixture.workspaceRoot), "utf8")).rejects.toThrow();
});

test("automation runner ignores unauthorized configured workspaces", async () => {
  const unauthorizedRoot = await mkdtemp(join(tmpdir(), "veslo-automations-unauthorized-"));
  tempDirs.push(unauthorizedRoot);
  await writeAutomationStore(unauthorizedRoot, {
    schemaVersion: 1,
    updatedAt: "2026-06-05T12:00:00.000Z",
    items: [makeAutomation({
      id: "auto_unauthorized_due",
      workspaceId: "ws_unauthorized",
      schedule: { kind: "oneShot", runAt: "2026-06-05T12:00:00.000Z" },
      nextRunAt: "2026-06-05T12:00:00.000Z",
      prompt: "Do not run",
    })],
    runs: [],
  });

  const fixture = await startFixture({
    extraWorkspaces: [{
      id: "ws_unauthorized",
      name: "Unauthorized",
      path: unauthorizedRoot,
      workspaceType: "local",
      baseUrl: "http://127.0.0.1:1",
    }],
  });
  await sleep(100);

  expect(fixture.openCodeCalls).toEqual([]);
  const persisted = JSON.parse(await readFile(resolveAutomationsPath(unauthorizedRoot), "utf8")) as { runs: unknown[] };
  expect(persisted.runs).toEqual([]);
});

test("DELETE /workspaces/:id clears scheduled automation timers before they can mutate removed workspace", async () => {
  const scheduledFor = new Date(Date.now() + 1_000).toISOString();
  const fixture = await startFixture({
    beforeStart: async (workspaceRoot) => {
      await writeAutomationStore(workspaceRoot, {
        schemaVersion: 1,
        updatedAt: "2026-06-05T12:00:00.000Z",
        items: [makeAutomation({
          id: "auto_delete_workspace",
          schedule: { kind: "oneShot", runAt: scheduledFor },
          nextRunAt: scheduledFor,
          prompt: "Do not run after workspace deletion",
        })],
        runs: [],
      });
    },
  });
  await sleep(100);

  const deleteResponse = await fixture.hostFetch("/workspaces/ws_1", { method: "DELETE" });
  expect(deleteResponse.status).toBe(200);
  await sleep(1_200);

  const persisted = JSON.parse(await readFile(resolveAutomationsPath(fixture.workspaceRoot), "utf8")) as {
    items: VesloAutomation[];
    runs: AutomationRun[];
  };
  expect(persisted.runs).toEqual([]);
  expect(persisted.items[0]).toMatchObject({
    id: "auto_delete_workspace",
    enabled: true,
    status: "active",
    nextRunAt: scheduledFor,
    lastRunId: null,
  });
  expect(fixture.openCodeCalls).toEqual([]);
});

test("failed workspace deletion preserves automation runner state for later runs", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "veslo-automations-bad-config-"));
  tempDirs.push(configDir);
  const configPath = join(configDir, "server.json");
  await writeFile(configPath, "{not json", "utf8");
  const fixture = await startFixture({ configPath });
  const created = await fixture.createAutomation();

  const deleteResponse = await fixture.hostFetch("/workspaces/ws_1", { method: "DELETE" });
  expect(deleteResponse.status).toBe(422);

  const runResponse = await fixture.clientFetch(`/workspace/ws_1/automations/${created.id}/run`, {
    method: "POST",
  });

  expect(runResponse.status).toBe(200);
  const payload = await runResponse.json() as { run: AutomationRun };
  expect(payload.run).toMatchObject({
    automationId: created.id,
    status: "success",
    sessionId: "ses_new",
    createdSession: true,
  });
  expect(fixture.openCodeCalls).toContainEqual({
    method: "POST",
    pathname: "/session/ses_new/prompt_async",
    body: { parts: [{ type: "text", text: "Run once" }] },
  });
});

test("POST /workspace/ws_1/automations rejects duplicate ids without replacing existing data", async () => {
  const fixture = await startFixture();
  const existing = fixture.makeAutomation({ id: "auto_duplicate", name: "Original", prompt: "Keep me" });
  const existingRun = fixture.makeRun({ id: "run_duplicate", automationId: existing.id });
  const originalStore = {
    schemaVersion: 1 as const,
    updatedAt: "2026-06-05T12:05:00.000Z",
    items: [existing],
    runs: [existingRun],
  };
  await writeAutomationStore(fixture.workspaceRoot, originalStore);

  const response = await fixture.clientFetch("/workspace/ws_1/automations", {
    method: "POST",
    body: {
      id: "auto_duplicate",
      name: "Replacement",
      prompt: "Overwrite",
      schedule: { kind: "oneShot", runAt: futureRunAt() },
    },
  });

  expect(response.status).toBe(409);
  const persisted = JSON.parse(await readFile(resolveAutomationsPath(fixture.workspaceRoot), "utf8"));
  expect(persisted.items).toEqual(originalStore.items);
  expect(persisted.runs).toEqual(originalStore.runs);
});

test("PATCH enabled true does not reactivate a completed past one-shot", async () => {
  const fixture = await startFixture();
  const completed = fixture.makeAutomation({
    id: "auto_completed",
    enabled: false,
    status: "completed",
    schedule: { kind: "oneShot", runAt: "2026-06-01T10:00:00.000Z" },
    nextRunAt: null,
    completedAt: "2026-06-01T10:05:00.000Z",
  });
  await writeAutomationStore(fixture.workspaceRoot, {
    schemaVersion: 1,
    updatedAt: "2026-06-01T10:05:00.000Z",
    items: [completed],
    runs: [],
  });

  const response = await fixture.clientFetch("/workspace/ws_1/automations/auto_completed", {
    method: "PATCH",
    body: { enabled: true },
  });

  expect(response.status).toBe(409);
  const persisted = JSON.parse(await readFile(resolveAutomationsPath(fixture.workspaceRoot), "utf8")) as { items: VesloAutomation[] };
  expect(persisted.items[0]).toEqual(completed);
});

test("manual run forwards target agent model and variant to OpenCode prompt", async () => {
  const fixture = await startFixture();
  const created = await fixture.createAutomation({
    target: {
      preferredSessionId: "ses_existing",
      agent: "build",
      model: "gpt-5",
      variant: "xhigh",
    },
  });

  const response = await fixture.clientFetch(`/workspace/ws_1/automations/${created.id}/run`, {
    method: "POST",
  });

  expect(response.status).toBe(200);
  expect(fixture.openCodeCalls).toContainEqual({
    method: "POST",
    pathname: "/session/ses_existing/prompt_async",
    body: {
      parts: [{ type: "text", text: "Run once" }],
      agent: "build",
      model: "gpt-5",
      variant: "xhigh",
    },
  });
});

test("automation execution allows cold OpenCode session startup beyond the generic fetch timeout", async () => {
  const previousTimeout = process.env.VESLO_OPENCODE_JSON_FETCH_TIMEOUT_MS;
  process.env.VESLO_OPENCODE_JSON_FETCH_TIMEOUT_MS = "10";
  try {
    const fixture = await startFixture({ sessionDelayMs: 250 });
    const created = await fixture.createAutomation();

    const response = await fixture.clientFetch(`/workspace/ws_1/automations/${created.id}/run`, {
      method: "POST",
    });
    const payload = await response.json() as { run?: AutomationRun };

    expect(response.status).toBe(200);
    expect(payload.run?.status).toBe("success");
    expect(payload.run?.sessionId).toBe("ses_new");
  } finally {
    if (previousTimeout === undefined) {
      delete process.env.VESLO_OPENCODE_JSON_FETCH_TIMEOUT_MS;
    } else {
      process.env.VESLO_OPENCODE_JSON_FETCH_TIMEOUT_MS = previousTimeout;
    }
  }
});

test("legacy Agent Lab list filters schedules old clients do not understand", async () => {
  const fixture = await startFixture();
  await writeAutomationStore(fixture.workspaceRoot, {
    schemaVersion: 1,
    updatedAt: "2026-06-05T12:00:00.000Z",
    items: [
      fixture.makeAutomation({ id: "auto_daily", schedule: { kind: "daily", hour: 9, minute: 0 } }),
      fixture.makeAutomation({ id: "auto_once", schedule: { kind: "oneShot", runAt: futureRunAt() } }),
      fixture.makeAutomation({ id: "auto_cron", schedule: { kind: "cron", expression: "0 9 * * *" } }),
    ],
    runs: [],
  });

  const response = await fixture.clientFetch("/workspace/ws_1/agentlab/automations");

  expect(response.status).toBe(200);
  const payload = await response.json() as { items: Array<{ id: string }> };
  expect(payload.items.map((item) => item.id)).toEqual(["auto_daily"]);
});

test("legacy Agent Lab run reports failed runner result instead of ok true", async () => {
  const fixture = await startFixture({ failPrompt: true });
  const created = await fixture.createAutomation();

  const response = await fixture.clientFetch(`/workspace/ws_1/agentlab/automations/${created.id}/run`, {
    method: "POST",
  });
  const payload = await response.json() as { ok?: boolean; run?: AutomationRun };

  if (response.status >= 200 && response.status < 300) {
    expect(payload.ok).toBe(false);
    expect(payload.run?.status).toBe("failed");
  } else {
    expect(response.status).toBeGreaterThanOrEqual(400);
  }
});

type FixtureOptions = {
  readOnly?: boolean;
  failPrompt?: boolean;
  sessionDelayMs?: number;
  configPath?: string;
  beforeStart?: (workspaceRoot: string) => Promise<void>;
  extraWorkspaces?: Array<{
    id: string;
    name: string;
    path: string;
    workspaceType: "local";
    baseUrl?: string;
  }>;
};

async function startFixture(options: FixtureOptions = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-automations-route-"));
  tempDirs.push(workspaceRoot);
  const openCodeCalls: Array<{ method: string; pathname: string; body: unknown }> = [];

  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = request.method === "GET" ? null : await request.json().catch(() => null);
      openCodeCalls.push({ method: request.method, pathname: url.pathname, body });

      if (request.method === "GET" && url.pathname === "/session/ses_existing") return json(200, { id: "ses_existing" });
      if (request.method === "POST" && url.pathname === "/session") {
        if (options.sessionDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.sessionDelayMs));
        }
        return json(200, { id: "ses_new" });
      }
      if (request.method === "POST" && url.pathname === "/session/ses_new/prompt_async") {
        return options.failPrompt ? json(500, { code: "failed" }) : json(200, { ok: true });
      }
      if (request.method === "POST" && url.pathname === "/session/ses_existing/prompt_async") {
        return options.failPrompt ? json(500, { code: "failed" }) : json(200, { ok: true });
      }
      return json(404, { code: "not_found" });
    },
  });
  runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

  await options.beforeStart?.(workspaceRoot);

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
      ...(options.extraWorkspaces ?? []),
    ],
    authorizedRoots: [workspaceRoot],
    configPath: options.configPath,
    readOnly: options.readOnly ?? false,
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

  const hostFetch = (path: string, options: {
    method?: string;
    body?: Record<string, unknown>;
  } = {}) => {
    const headers = new Headers({ "x-veslo-host-token": "host-token" });
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
    openCodeCalls,
    clientFetch,
    hostFetch,
    createViewerToken,
    createAutomation,
    makeAutomation,
    makeRun,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
