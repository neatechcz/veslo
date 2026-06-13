import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";

import { resolveOpencodeProxyTarget } from "../opencode-proxy-target.js";
import type { EngineProcess } from "../engine-pool.js";

function engine(workspaceId: string, baseUrl: string): EngineProcess {
  return {
    workspaceId,
    pid: Math.floor(Math.random() * 10000) + 1000,
    port: Number(baseUrl.split(":").pop()) || 0,
    baseUrl,
    workdir: `/work/${workspaceId}`,
    configDir: `/config/${workspaceId}`,
    state: "ready",
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
    });
    expect(ensureCalls).toBe(0);
  });

  test("POST in shared mode starts one shared engine with workspace directory", async () => {
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
        ensureStarted: async () => {
          ensureCalls++;
          return shared;
        },
      },
    });

    expect(target.engine).toBe(shared);
    expect(target.engineKind).toBe("shared");
    expect(target.directory).toBe("/repo/a");
    expect(target.spawnedByRequest).toBe(true);
    expect(ensureCalls).toBe(1);
  });

  test("pooled mode uses the workspace engine", async () => {
    let ensureWorkspaceId = "";
    const pooled = engine("ws-a", "http://127.0.0.1:5001");

    const target = await resolveOpencodeProxyTarget({
      topology: "pooled-per-workspace",
      method: "POST",
      workspaceId: "ws-a",
      workspacePath: "/repo/a",
      pooledEngine: {
        getRunning: () => null,
        ensure: async (workspace) => {
          ensureWorkspaceId = workspace.id;
          return pooled;
        },
      },
    });

    expect(target.engine).toBe(pooled);
    expect(target.engineKind).toBe("pooled");
    expect(target.directory).toBe("/repo/a");
    expect(target.spawnedByRequest).toBe(true);
    expect(ensureWorkspaceId).toBe("ws-a");
  });
});
