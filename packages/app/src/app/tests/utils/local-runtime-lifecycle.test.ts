import assert from "node:assert/strict";
import test from "node:test";

import type { OpencodeAuth } from "../../lib/opencode";
import type { EngineInfo } from "../../lib/tauri";
import { createLocalRuntimeLifecycle } from "../../utils/local-runtime-lifecycle.js";

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
  prepareInfo?: EngineInfo;
  infoSnapshot?: EngineInfo;
  infoSnapshots?: EngineInfo[];
  serverConnectResult?: boolean;
  quietConnectResult?: boolean;
}) {
  const calls: string[] = [];
  const snapshots: EngineInfo[] = [];
  const authSnapshots: Array<OpencodeAuth | null> = [];
  const readInfoRequests: Array<{ workspaceId?: string; workspacePath?: string }> = [];
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
  const startInfo = options?.startInfo ?? makeEngineInfo({ runtime, projectDir: "/tmp/demo" });
  const prepareInfo = options?.prepareInfo ?? startInfo;
  const infoSnapshot = options?.infoSnapshot ?? makeEngineInfo({ runtime, projectDir: "/tmp/demo" });
  const infoSnapshots = [...(options?.infoSnapshots ?? [])];

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
    readEngineInfo: async (workspaceId, workspacePath) => {
      calls.push("readEngineInfo");
      readInfoRequests.push({ workspaceId, workspacePath });
      return infoSnapshots.shift() ?? infoSnapshot;
    },
    prepareWorkspaceRuntime: async (input) => {
      calls.push(
        `prepareRuntime:${input.projectDir}:${input.runtime}:${input.workspaceId ?? ""}:${input.reason ?? ""}:${input.forceFreshRuntime === true}`,
      );
      return {
        ok: true,
        action: input.forceFreshRuntime === true || input.runtime === "direct"
          ? "fresh_start"
          : "orchestrator_activate",
        reason: input.reason ?? "",
        engine: prepareInfo,
      };
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
    readInfoRequests,
    serverConnections,
    quietConnections,
    startInfo,
    infoSnapshot,
  };
}

test("startHost delegates runtime process preparation to the backend and reconnects", async () => {
  const harness = createHarness();

  const ok = await harness.lifecycle.startHost({
    workspacePath: "/tmp/demo",
    workspaceId: "ws-demo",
    reason: "host-start",
    navigate: false,
  });

  assert.equal(ok, true);
  assert.deepEqual(harness.calls, [
    "prepareRuntime:/tmp/demo:direct:ws-demo:host-start:true",
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

test("orchestrator quiet reconnect waits through starting engine info state", async () => {
  const harness = createHarness({
    runtime: "veslo-orchestrator",
    prepareInfo: makeEngineInfo({
      running: false,
      runtime: "veslo-orchestrator",
      engineState: "starting",
      baseUrl: "http://127.0.0.1:7777/workspace/ws-a/opencode",
      projectDir: "/tmp/demo",
    }),
    infoSnapshots: [
      makeEngineInfo({
        running: true,
        runtime: "veslo-orchestrator",
        engineState: "ready",
        baseUrl: "http://127.0.0.1:7777/workspace/ws-a/opencode",
        projectDir: "/tmp/demo",
      }),
    ],
  });

  const ok = await harness.lifecycle.restartWorkspaceRuntime({
    workspacePath: "/tmp/demo",
    workspaceId: "ws-a",
    reason: "test-starting",
    connectMode: "quiet",
  });

  assert.equal(ok, true);
  assert.equal(harness.readInfoRequests.length, 1);
  assert.equal(harness.quietConnections.length, 1);
  assert.equal(harness.quietConnections[0]?.baseUrl, "http://127.0.0.1:7777/workspace/ws-a/opencode");
  assert.deepEqual(
    harness.snapshots.map((snapshot) => snapshot.engineState ?? null),
    ["starting", "ready"],
  );
});

test("orchestrator quiet reconnect skips absent engine proxy health check", async () => {
  const harness = createHarness({
    runtime: "veslo-orchestrator",
    prepareInfo: makeEngineInfo({
      running: false,
      runtime: "veslo-orchestrator",
      engineState: "absent",
      baseUrl: "http://127.0.0.1:7777/workspace/ws-a/opencode",
      projectDir: "/tmp/demo",
    }),
  });

  const ok = await harness.lifecycle.restartWorkspaceRuntime({
    workspacePath: "/tmp/demo",
    workspaceId: "ws-a",
    reason: "test-absent",
    connectMode: "quiet",
  });

  assert.equal(ok, false);
  assert.equal(harness.readInfoRequests.length, 0);
  assert.equal(harness.quietConnections.length, 0);
});

test("startHost can reconnect quietly without routing through the shared server connector", async () => {
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
    "prepareRuntime:/tmp/demo:direct:ws-demo:browse-cold-start:true",
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

test("startHost reconnects through workspace-scoped engine info for orchestrator runtime", async () => {
  const harness = createHarness({
    runtime: "veslo-orchestrator",
    prepareInfo: makeEngineInfo({
      runtime: "veslo-orchestrator",
      baseUrl: "http://127.0.0.1:57871/workspace/ws-old/opencode",
      projectDir: "/tmp/old",
    }),
    infoSnapshot: makeEngineInfo({
      runtime: "veslo-orchestrator",
      baseUrl: "http://127.0.0.1:57871/workspace/ws-new/opencode",
      projectDir: "/tmp/new",
    }),
  });

  const ok = await harness.lifecycle.startHost({
    workspacePath: "/tmp/new",
    workspaceId: "ws-new",
    reason: "browse-cold-start",
    navigate: false,
  });

  assert.equal(ok, true);
  assert.deepEqual(harness.calls, [
    "prepareRuntime:/tmp/new:veslo-orchestrator:ws-new:browse-cold-start:true",
    "activateHost:/tmp/new",
    "readEngineInfo",
    "setEngine:/tmp/new",
    "setEngineAuth:demo-user",
    "connectToServer:browse-cold-start",
  ]);
  assert.deepEqual(harness.readInfoRequests, [
    { workspaceId: "ws-new", workspacePath: "/tmp/new" },
  ]);
  assert.equal(
    harness.serverConnections[0]?.baseUrl,
    "http://127.0.0.1:57871/workspace/ws-new/opencode",
  );
  assert.deepEqual(harness.serverConnections[0]?.context, {
    workspaceId: "ws-new",
    workspaceType: "local",
    targetRoot: "/tmp/new",
    reason: "browse-cold-start",
  });
});

test("restartWorkspaceRuntime delegates direct runtime preparation to the backend", async () => {
  const harness = createHarness({
    runtime: "direct",
    prepareInfo: makeEngineInfo({
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
    "prepareRuntime:/tmp/new-workspace:direct:ws-next:workspace-restart:false",
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

test("restartWorkspaceRuntime can reconnect quietly after backend orchestrator preparation", async () => {
  const harness = createHarness({
    runtime: "veslo-orchestrator",
    prepareInfo: makeEngineInfo({
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
    "prepareRuntime:/tmp/orchestrated:veslo-orchestrator:ws-orch:ensure-engine:false",
    "activateHost:/tmp/orchestrated",
    "setEngine:/tmp/orchestrated",
    "setEngineAuth:demo-user",
    "connectQuiet:/tmp/orchestrated",
  ]);
  assert.deepEqual(harness.serverConnections, []);
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

test("restartWorkspaceRuntime forceFreshRuntime is passed to the backend prepare owner", async () => {
  const harness = createHarness({
    runtime: "veslo-orchestrator",
    prepareInfo: makeEngineInfo({
      runtime: "veslo-orchestrator",
      projectDir: "/tmp/fresh",
      baseUrl: "http://127.0.0.1:6300",
    }),
  });

  const ok = await harness.lifecycle.restartWorkspaceRuntime({
    workspacePath: "/tmp/fresh",
    workspaceId: "ws-fresh",
    workspaceName: "Fresh",
    reason: "event-stream-runtime-recovery",
    connectMode: "quiet",
    forceFreshRuntime: true,
  });

  assert.equal(ok, true);
  assert.deepEqual(harness.calls, [
    "prepareRuntime:/tmp/fresh:veslo-orchestrator:ws-fresh:event-stream-runtime-recovery:true",
    "activateHost:/tmp/fresh",
    "setEngine:/tmp/fresh",
    "setEngineAuth:demo-user",
    "connectQuiet:/tmp/fresh",
  ]);
});

test("restartWorkspaceRuntime activates orchestrator with the requested workspace id", async () => {
  const harness = createHarness({
    runtime: "veslo-orchestrator",
    prepareInfo: makeEngineInfo({
      runtime: "veslo-orchestrator",
      projectDir: "/tmp/private-profile",
      baseUrl: "http://127.0.0.1:6100/workspace/ws-target/opencode",
    }),
  });

  const ok = await harness.lifecycle.restartWorkspaceRuntime({
    workspacePath: "/tmp/private-profile",
    workspaceId: "ws-target",
    workspaceName: "Private",
    reason: "ensure-engine",
    connectMode: "quiet",
  });

  assert.equal(ok, true);
  assert.equal(harness.calls[0], "prepareRuntime:/tmp/private-profile:veslo-orchestrator:ws-target:ensure-engine:false");
  assert.deepEqual(harness.readInfoRequests, []);
  assert.equal(harness.quietConnections[0]?.context?.workspaceId, "ws-target");
});

test("reattachOrchestratorWorkspace delegates to backend prepare and reuses snapshot reconnect", async () => {
  const harness = createHarness({
    runtime: "veslo-orchestrator",
    prepareInfo: makeEngineInfo({
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
    "prepareRuntime:/tmp/reused:veslo-orchestrator:ws-reused:workspace-attach-local:false",
    "activateHost:/tmp/reused",
    "setEngine:/tmp/reused",
    "setEngineAuth:demo-user",
    "connectToServer:workspace-attach-local",
  ]);
  assert.deepEqual(harness.serverConnections[0]?.connectOptions, { navigate: false });
});
