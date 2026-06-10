import assert from "node:assert/strict";
import test from "node:test";

import type { OpencodeAuth } from "../lib/opencode";
import type { EngineInfo } from "../lib/tauri";
import { createLocalRuntimeLifecycle } from "./local-runtime-lifecycle.js";

function makeEngineInfo(overrides: Partial<EngineInfo> = {}): EngineInfo {
  return {
    running: true,
    runtime: "direct",
    baseUrl: "http://127.0.0.1:4096",
    projectDir: "/tmp/demo",
    hostname: "127.0.0.1",
    port: 4096,
    opencodeUsername: "demo-user",
    opencodePassword: "demo-pass",
    pid: 1234,
    lastStdout: null,
    lastStderr: null,
    ...overrides,
  };
}

function createHarness(options?: {
  runtime?: EngineInfo["runtime"];
  startInfo?: EngineInfo;
  stopInfo?: EngineInfo;
  infoSnapshot?: EngineInfo;
  serverConnectResult?: boolean;
  quietConnectResult?: boolean;
}) {
  const calls: string[] = [];
  const snapshots: EngineInfo[] = [];
  const authSnapshots: Array<OpencodeAuth | null> = [];
  const serverConnections: Array<{
    baseUrl: string;
    directory?: string;
    context?: {
      workspaceId?: string;
      workspaceType?: "local" | "remote";
      targetRoot?: string;
      reason?: string;
    };
    auth?: OpencodeAuth;
    connectOptions?: { quiet?: boolean; navigate?: boolean };
  }> = [];
  const quietConnections: Array<{
    baseUrl: string;
    directory: string;
    auth?: OpencodeAuth;
    context?: {
      workspaceId?: string;
      workspaceType?: "local" | "remote";
      targetRoot?: string;
      reason?: string;
    };
  }> = [];

  const runtime = options?.runtime ?? "direct";
  const stopInfo =
    options?.stopInfo ??
    makeEngineInfo({
      running: false,
      runtime,
      baseUrl: null,
      projectDir: "/tmp/old",
      opencodeUsername: null,
      opencodePassword: null,
      pid: null,
    });
  const startInfo = options?.startInfo ?? makeEngineInfo({ runtime, projectDir: "/tmp/demo" });
  const infoSnapshot = options?.infoSnapshot ?? makeEngineInfo({ runtime, projectDir: "/tmp/demo" });

  const lifecycle = createLocalRuntimeLifecycle({
    engineSource: () => "path",
    engineCustomBinPath: () => "",
    resolveEngineRuntime: () => runtime,
    resolveWorkspacePaths: () => ["/tmp/demo", "/tmp/other"],
    setEngine: (info) => {
      calls.push(`setEngine:${info.projectDir ?? "none"}`);
      snapshots.push(info);
    },
    setEngineAuth: (auth) => {
      calls.push(`setEngineAuth:${auth?.username ?? auth?.mode ?? "none"}`);
      authSnapshots.push(auth ?? null);
    },
    startEngine: async (workspacePath, startOptions) => {
      calls.push(`startEngine:${workspacePath}:${startOptions.runtime}`);
      return startInfo;
    },
    stopEngine: async () => {
      calls.push("stopEngine");
      return stopInfo;
    },
    readEngineInfo: async () => {
      calls.push("readEngineInfo");
      return infoSnapshot;
    },
    activateOrchestratorWorkspace: async ({ workspacePath, name }) => {
      calls.push(`activateOrchestrator:${workspacePath}:${name ?? ""}`);
      return null;
    },
    activateVesloHostWorkspace: async (workspacePath) => {
      calls.push(`activateHost:${workspacePath}`);
      return null;
    },
    connectToServer: async (baseUrl, directory, context, auth, connectOptions) => {
      calls.push(`connectToServer:${context?.reason ?? "none"}`);
      serverConnections.push({ baseUrl, directory, context, auth, connectOptions });
      return options?.serverConnectResult ?? true;
    },
    connectQuiet: async (baseUrl, directory, auth, context) => {
      calls.push(`connectQuiet:${directory}`);
      quietConnections.push({ baseUrl, directory, auth, context });
      return options?.quietConnectResult ?? true;
    },
  });

  return {
    lifecycle,
    calls,
    snapshots,
    authSnapshots,
    serverConnections,
    quietConnections,
    startInfo,
    stopInfo,
    infoSnapshot,
  };
}

test("startHost starts the engine once, derives auth, and reconnects through the shared lifecycle", async () => {
  const harness = createHarness();

  const ok = await harness.lifecycle.startHost({
    workspacePath: "/tmp/demo",
    workspaceId: "ws-demo",
    reason: "host-start",
    navigate: false,
  });

  assert.equal(ok, true);
  assert.deepEqual(harness.calls, [
    "startEngine:/tmp/demo:direct",
    "setEngine:/tmp/demo",
    "setEngineAuth:demo-user",
    "connectToServer:host-start",
  ]);
  assert.deepEqual(harness.serverConnections, [
    {
      baseUrl: "http://127.0.0.1:4096",
      directory: "/tmp/demo",
      context: {
        workspaceId: "ws-demo",
        workspaceType: "local",
        targetRoot: "/tmp/demo",
        reason: "host-start",
      },
      auth: { username: "demo-user", password: "demo-pass" },
      connectOptions: { navigate: false },
    },
  ]);
});

test("startHost can reconnect quietly for browsing-mode cold starts", async () => {
  const harness = createHarness();

  const ok = await harness.lifecycle.startHost({
    workspacePath: "/tmp/demo",
    workspaceId: "ws-demo",
    reason: "browse-cold-start",
    connectMode: "quiet",
    navigate: false,
  });

  assert.equal(ok, true);
  assert.deepEqual(harness.calls, [
    "startEngine:/tmp/demo:direct",
    "setEngine:/tmp/demo",
    "setEngineAuth:demo-user",
    "connectQuiet:/tmp/demo",
  ]);
  assert.deepEqual(harness.serverConnections, []);
  assert.deepEqual(harness.quietConnections, [
    {
      baseUrl: "http://127.0.0.1:4096",
      directory: "/tmp/demo",
      auth: { username: "demo-user", password: "demo-pass" },
      context: {
        workspaceId: "ws-demo",
        workspaceType: "local",
        targetRoot: "/tmp/demo",
        reason: "browse-cold-start",
      },
    },
  ]);
});

test("restartWorkspaceRuntime uses the shared stop/start reconnect flow for direct runtime", async () => {
  const harness = createHarness({
    runtime: "direct",
    startInfo: makeEngineInfo({
      runtime: "direct",
      projectDir: "/tmp/new-workspace",
      baseUrl: "http://127.0.0.1:5000",
    }),
  });

  const ok = await harness.lifecycle.restartWorkspaceRuntime({
    workspacePath: "/tmp/new-workspace",
    workspaceId: "ws-next",
    workspaceName: "Next",
    reason: "workspace-restart",
    connectMode: "server",
    navigate: false,
  });

  assert.equal(ok, true);
  assert.deepEqual(harness.calls, [
    "stopEngine",
    "startEngine:/tmp/new-workspace:direct",
    "setEngine:/tmp/old",
    "setEngine:/tmp/new-workspace",
    "setEngineAuth:demo-user",
    "connectToServer:workspace-restart",
  ]);
  assert.deepEqual(harness.serverConnections[0]?.context, {
    workspaceId: "ws-next",
    workspaceType: "local",
    targetRoot: "/tmp/new-workspace",
    reason: "workspace-restart",
  });
});

test("restartWorkspaceRuntime can reconnect quietly after orchestrator workspace activation", async () => {
  const harness = createHarness({
    runtime: "veslo-orchestrator",
    infoSnapshot: makeEngineInfo({
      runtime: "veslo-orchestrator",
      projectDir: "/tmp/orchestrated",
      baseUrl: "http://127.0.0.1:6100",
    }),
  });

  const ok = await harness.lifecycle.restartWorkspaceRuntime({
    workspacePath: "/tmp/orchestrated",
    workspaceId: "ws-orch",
    workspaceName: "Orchestrated",
    reason: "ensure-engine",
    connectMode: "quiet",
  });

  assert.equal(ok, true);
  assert.deepEqual(harness.calls, [
    "activateOrchestrator:/tmp/orchestrated:Orchestrated",
    "activateHost:/tmp/orchestrated",
    "readEngineInfo",
    "setEngine:/tmp/orchestrated",
    "setEngineAuth:demo-user",
    "connectQuiet:/tmp/orchestrated",
  ]);
  assert.deepEqual(harness.quietConnections, [
    {
      baseUrl: "http://127.0.0.1:6100",
      directory: "/tmp/orchestrated",
      auth: { username: "demo-user", password: "demo-pass" },
      context: {
        workspaceId: "ws-orch",
        workspaceType: "local",
        targetRoot: "/tmp/orchestrated",
        reason: "ensure-engine",
      },
    },
  ]);
});

test("reattachOrchestratorWorkspace reuses the shared engine snapshot flow without a stop/start cycle", async () => {
  const harness = createHarness({
    runtime: "veslo-orchestrator",
    infoSnapshot: makeEngineInfo({
      runtime: "veslo-orchestrator",
      projectDir: "/tmp/reused",
      baseUrl: "http://127.0.0.1:6200",
    }),
  });

  const ok = await harness.lifecycle.reattachOrchestratorWorkspace({
    workspacePath: "/tmp/reused",
    workspaceId: "ws-reused",
    workspaceName: "Reused",
    reason: "workspace-attach-local",
    navigate: false,
  });

  assert.equal(ok, true);
  assert.deepEqual(harness.calls, [
    "activateOrchestrator:/tmp/reused:Reused",
    "activateHost:/tmp/reused",
    "readEngineInfo",
    "setEngine:/tmp/reused",
    "setEngineAuth:demo-user",
    "connectToServer:workspace-attach-local",
  ]);
  assert.deepEqual(harness.serverConnections[0]?.connectOptions, { navigate: false });
});
