import { describe, expect, test } from "bun:test";
import { matchRoute, type Route } from "../routing.js";
import { registerHealthStatusRoutes, resolveRuntimeChainPayload } from "../routes/health.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    token: "client",
    hostToken: "host",
    approval: { mode: "manual", timeoutMs: 1 },
    corsOrigins: [],
    workspaces: [],
    authorizedRoots: ["/tmp"],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "json",
    logRequests: false,
    debugLogs: {
      enabled: false,
      ingestUrl: null,
      ingestToken: null,
      batchMaxEvents: 1,
      batchMaxBytes: 1,
      spoolMaxBytes: 1,
      flushIntervalMs: 1,
    },
    ...overrides,
  };
}

const workspace: WorkspaceInfo = {
  id: "ws-a",
  name: "Workspace A",
  path: "/tmp/ws-a",
  workspaceType: "local",
};

function fetchSequence(responses: Array<Response | Error>): typeof fetch {
  return (async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("unexpected fetch");
    return next;
  }) as unknown as typeof fetch;
}

describe("Health and status routes", () => {
  test("registers health, toy UI, status, and capability endpoints", () => {
    const routes: Route[] = [];
    const dependencies = {} as Parameters<typeof registerHealthStatusRoutes>[1];

    registerHealthStatusRoutes(routes, dependencies);

    const expectedRoutes: Array<[string, string, Route["auth"]]> = [
      ["GET", "/health", "none"],
      ["GET", "/w/ws_1/health", "none"],
      ["GET", "/ui", "none"],
      ["GET", "/w/ws_1/ui", "none"],
      ["GET", "/ui/assets/toy.css", "none"],
      ["GET", "/ui/assets/toy.js", "none"],
      ["GET", "/w/ws_1/status", "client"],
      ["GET", "/w/ws_1/capabilities", "client"],
      ["GET", "/w/ws_1/workspaces", "client"],
      ["GET", "/status", "client"],
      ["GET", "/capabilities", "client"],
    ];

    expect(routes).toHaveLength(expectedRoutes.length);
    for (const [index, [method, path, auth]] of expectedRoutes.entries()) {
      const route = matchRoute([routes[index]!], method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe(auth);
    }

    expect(matchRoute(routes, "POST", "/status")).toBeNull();
  });

  test("runtimeChain reports plain server_running without orchestrator config", async () => {
    const payload = await resolveRuntimeChainPayload(config(), workspace, fetchSequence([]));

    expect(payload.status).toBe("server_running");
    expect(payload.orchestrator.configured).toBe(false);
  });

  test("runtimeChain reports orchestrator_unavailable when daemon probe fails", async () => {
    const payload = await resolveRuntimeChainPayload(
      config({ orchestratorDaemonUrl: "http://127.0.0.1:52008" }),
      workspace,
      fetchSequence([new Error("connect ECONNREFUSED")]),
    );

    expect(payload.status).toBe("orchestrator_unavailable");
    expect(payload.orchestrator.error).toContain("ECONNREFUSED");
  });

  test("runtimeChain reports shared_engine_unhealthy before proxy readiness", async () => {
    const payload = await resolveRuntimeChainPayload(
      config({ orchestratorDaemonUrl: "http://127.0.0.1:52008" }),
      workspace,
      fetchSequence([
        Response.json({
          ok: true,
          engineTopology: "shared-unsandboxed",
          sharedEngine: { running: false, pending: false, engineState: "failed" },
        }),
      ]),
    );

    expect(payload.status).toBe("shared_engine_unhealthy");
  });

  test("runtimeChain reports proxy_unreachable when shared engine is up but proxy fails", async () => {
    const payload = await resolveRuntimeChainPayload(
      config({ orchestratorDaemonUrl: "http://127.0.0.1:52008" }),
      workspace,
      fetchSequence([
        Response.json({
          ok: true,
          engineTopology: "shared-unsandboxed",
          sharedEngine: { running: true, pending: false, engineState: "ready", baseUrl: "http://127.0.0.1:53553" },
        }),
        Response.json({ error: "bad gateway" }, { status: 502 }),
      ]),
    );

    expect(payload.status).toBe("proxy_unreachable");
    expect(payload.proxy.status).toBe(502);
  });

  test("runtimeChain reports ready after daemon and proxy probes pass", async () => {
    const payload = await resolveRuntimeChainPayload(
      config({ orchestratorDaemonUrl: "http://127.0.0.1:52008" }),
      workspace,
      fetchSequence([
        Response.json({
          ok: true,
          engineTopology: "shared-unsandboxed",
          sharedEngine: { running: true, pending: false, engineState: "ready", baseUrl: "http://127.0.0.1:53553" },
        }),
        Response.json({ ok: true }),
      ]),
    );

    expect(payload.status).toBe("runtime_chain_ready");
    expect(payload.proxy.ok).toBe(true);
  });
});
