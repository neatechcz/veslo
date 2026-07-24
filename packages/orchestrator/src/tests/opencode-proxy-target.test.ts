import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";

import { resolveOpencodeProxyTarget } from "../opencode-proxy-target.js";
import type { EngineProcess, EngineState } from "../engine-pool.js";

function engine(workspaceId: string, baseUrl: string, state: EngineState = "ready"): EngineProcess {
  return {
    workspaceId,
    engineOwnerId: `owner-${workspaceId}`,
    pid: Math.floor(Math.random() * 10000) + 1000,
    port: Number(baseUrl.split(":").pop()) || 0,
    baseUrl,
    workdir: `/work/${workspaceId}`,
    configDir: `/config/${workspaceId}`,
    state,
    spawnedAt: 1,
    lastActivityAt: 1,
    child: { pid: 1234 } as ChildProcess,
    healthStrikes: 0,
    restartCount: 0,
    lastSuccessfulRunStartedAt: 1,
  };
}

describe("resolveOpencodeProxyTarget", () => {
  test("GET in shared mode does not start a stopped engine", async () => {
    let ensureCalls = 0;

    const target = await resolveOpencodeProxyTarget({
      topology: "shared-unsandboxed",
      method: "GET",
      workspaceId: "ws-a",
      workspacePath: "/repo/a",
      pooledEngine: {
        getRunning: () => null,
        ensure: async () => engine("ws-a", "http://127.0.0.1:5001"),
      },
      sharedEngine: {
        getRunning: () => null,
        snapshot: () => ({
          mode: "shared-unsandboxed",
          running: false,
          pending: false,
          engineState: "absent",
          runtimeDirectory: "/runtime",
          configDirectory: "/config",
        }),
        ensureStarted: async () => {
          ensureCalls++;
          return engine("shared-unsandboxed", "http://127.0.0.1:6001");
        },
      },
    });

    expect(target).toEqual({
      engine: null,
      engineKind: "shared",
      directory: "/repo/a",
      spawnedByRequest: false,
      engineState: "absent",
      unavailableReason: "absent",
    });
    expect(ensureCalls).toBe(0);
  });

  test("POST in shared mode reports reuse when the shared engine already runs", async () => {
    let ensureCalls = 0;
    const shared = engine("shared-unsandboxed", "http://127.0.0.1:6001");

    const target = await resolveOpencodeProxyTarget({
      topology: "shared-unsandboxed",
      method: "POST",
      workspaceId: "ws-a",
      workspacePath: "/repo/a",
      pooledEngine: {
        getRunning: () => null,
        ensure: async () => engine("ws-a", "http://127.0.0.1:5001"),
      },
      sharedEngine: {
        getRunning: () => shared,
        snapshot: () => ({
          mode: "shared-unsandboxed",
          running: true,
          pending: false,
          engineState: "ready",
          state: "ready",
          baseUrl: shared.baseUrl,
          pid: shared.pid,
          port: shared.port,
          startedAt: new Date(shared.spawnedAt).toISOString(),
          runtimeDirectory: "/runtime",
          configDirectory: "/config",
        }),
        ensureStarted: async () => {
          ensureCalls++;
          return shared;
        },
      },
    });

    expect(target.engine).toBe(shared);
    expect(target.engineKind).toBe("shared");
    expect(target.directory).toBe("/repo/a");
    expect(target.spawnedByRequest).toBe(false);
    expect(target.engineState).toBe("ready");
    expect(ensureCalls).toBe(1);
  });

  test("directory-scoped shared mode retains the workspace root as the directory key", async () => {
    const shared = engine("shared-directory-scoped", "http://127.0.0.1:6001");
    const target = await resolveOpencodeProxyTarget({
      topology: "shared-directory-scoped",
      method: "POST",
      workspaceId: "ws-a",
      workspacePath: "/repo/a",
      pooledEngine: {
        getRunning: () => null,
        ensure: async () => engine("ws-a", "http://127.0.0.1:5001"),
      },
      sharedEngine: {
        getRunning: () => shared,
        snapshot: () => ({
          mode: "shared-directory-scoped",
          running: true,
          pending: false,
          engineState: "ready",
          runtimeDirectory: "/runtime",
          configDirectory: "/config",
        }),
        ensureStarted: async () => shared,
      },
    });

    expect(target.engineKind).toBe("shared");
    expect(target.directory).toBe("/repo/a");
  });

  test("GET in shared mode reports starting without starting another engine", async () => {
    let ensureCalls = 0;

    const target = await resolveOpencodeProxyTarget({
      topology: "shared-unsandboxed",
      method: "GET",
      workspaceId: "ws-a",
      workspacePath: "/repo/a",
      pooledEngine: {
        getRunning: () => null,
        ensure: async () => engine("ws-a", "http://127.0.0.1:5001"),
      },
      sharedEngine: {
        getRunning: () => null,
        snapshot: () => ({
          mode: "shared-unsandboxed",
          running: false,
          pending: true,
          engineState: "starting",
          runtimeDirectory: "/runtime",
          configDirectory: "/config",
        }),
        ensureStarted: async () => {
          ensureCalls++;
          return engine("shared-unsandboxed", "http://127.0.0.1:6001");
        },
      },
    });

    expect(target.engine).toBeNull();
    expect(target.engineKind).toBe("shared");
    expect(target.spawnedByRequest).toBe(false);
    expect(target.engineState).toBe("starting");
    expect(target.unavailableReason).toBe("starting");
    expect(ensureCalls).toBe(0);
  });

  test("pooled mode reports reuse when ensure reuses the workspace engine", async () => {
    let ensureWorkspaceId = "";
    const pooled = engine("ws-a", "http://127.0.0.1:5001");

    const target = await resolveOpencodeProxyTarget({
      topology: "pooled-per-workspace",
      method: "POST",
      workspaceId: "ws-a",
      workspacePath: "/repo/a",
      pooledEngine: {
        get: () => pooled,
        getRunning: () => pooled,
        ensure: async (workspace) => {
          ensureWorkspaceId = workspace.id;
          return pooled;
        },
        ensureWithStatus: async (workspace) => {
          ensureWorkspaceId = workspace.id;
          return { engine: pooled, spawned: false };
        },
      },
    });

    expect(target.engine).toBe(pooled);
    expect(target.engineKind).toBe("pooled");
    expect(target.directory).toBe("/repo/a");
    expect(target.spawnedByRequest).toBe(false);
    expect(target.engineState).toBe("ready");
    expect(ensureWorkspaceId).toBe("ws-a");
  });

  test("pooled mode reports a process created by this request", async () => {
    const pooled = engine("ws-a", "http://127.0.0.1:5001");

    const target = await resolveOpencodeProxyTarget({
      topology: "pooled-per-workspace",
      method: "POST",
      workspaceId: "ws-a",
      workspacePath: "/repo/a",
      pooledEngine: {
        get: () => undefined,
        getRunning: () => null,
        ensure: async () => pooled,
        ensureWithStatus: async () => ({ engine: pooled, spawned: true }),
      },
    });

    expect(target.spawnedByRequest).toBe(true);
  });

  test("GET in pooled mode reports spawning as starting without ensuring", async () => {
    let ensureCalls = 0;
    const spawning = engine("ws-a", "http://127.0.0.1:5001", "spawning");

    const target = await resolveOpencodeProxyTarget({
      topology: "pooled-per-workspace",
      method: "GET",
      workspaceId: "ws-a",
      workspacePath: "/repo/a",
      pooledEngine: {
        get: () => spawning,
        getRunning: () => null,
        ensure: async () => {
          ensureCalls++;
          return engine("ws-a", "http://127.0.0.1:5001");
        },
      },
    });

    expect(target.engine).toBeNull();
    expect(target.engineKind).toBe("pooled");
    expect(target.spawnedByRequest).toBe(false);
    expect(target.engineState).toBe("starting");
    expect(target.unavailableReason).toBe("starting");
    expect(ensureCalls).toBe(0);
  });

  test("a non-spawning POST reload reports an absent pooled engine", async () => {
    let ensureCalls = 0;

    const target = await resolveOpencodeProxyTarget({
      topology: "pooled-per-workspace",
      method: "POST",
      allowEngineStart: false,
      workspaceId: "ws-a",
      workspacePath: "/repo/a",
      pooledEngine: {
        get: () => undefined,
        getRunning: () => null,
        ensure: async () => {
          ensureCalls++;
          return engine("ws-a", "http://127.0.0.1:5001");
        },
      },
    });

    expect(target).toEqual({
      engine: null,
      engineKind: "pooled",
      directory: "/repo/a",
      spawnedByRequest: false,
      engineState: "absent",
      unavailableReason: "absent",
    });
    expect(ensureCalls).toBe(0);
  });
});
