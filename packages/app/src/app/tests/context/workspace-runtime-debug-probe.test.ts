import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkspaceRuntimeDiagnosis,
  createWorkspaceRuntimeDebugProbe,
  summarizeWorkspaceRuntimeSnapshotForDiff,
} from "../../context/workspace-runtime-debug-probe.js";

test("workspace runtime diagnosis reports app, Tauri, server, and orchestrator active workspace mismatches", () => {
  const diagnosis = buildWorkspaceRuntimeDiagnosis({
    app: {
      activeWorkspaceId: "ws-app",
      activeWorkspaceRoot: "C:/repo/app",
      activeWorkspace: {
        type: "local",
      },
      engineReady: true,
      engine: {
        projectDir: "C:/repo/engine",
        baseUrl: "http://127.0.0.1:4096/workspace/ws-engine/opencode",
      },
    },
    routing: {
      entries: [],
    },
    tauri: {
      workspaceBootstrap: {
        ok: true,
        value: {
          activeId: "ws-tauri",
        },
      },
      engineInfo: {
        ok: true,
        value: {
          baseUrl: "http://127.0.0.1:4096/workspace/ws-live/opencode",
        },
      },
    },
    server: {
      workspaces: {
        ok: true,
        value: {
          activeId: "ws-server",
          items: [
            {
              id: "ws-server",
              directory: "C:/repo/server",
            },
          ],
        },
      },
    },
    orchestrator: {
      status: {
        ok: true,
        value: {
          activeId: "ws-orchestrator",
          workspaces: [
            {
              id: "ws-orchestrator",
              directory: "C:/repo/orchestrator",
            },
          ],
        },
      },
    },
  });

  assert.deepEqual(
    diagnosis.map((entry) => entry.code),
    [
      "app-tauri-active-mismatch",
      "app-server-active-path-mismatch",
      "app-orchestrator-active-path-mismatch",
      "engine-ready-without-active-route",
      "app-engine-project-dir-mismatch",
      "current-engine-mount-id-mismatch",
      "live-engine-info-mount-id-mismatch",
    ],
  );
  assert.equal(diagnosis[0]?.level, "error");
});

test("workspace runtime diff summary keeps the public debug shape stable", () => {
  const summary = summarizeWorkspaceRuntimeSnapshotForDiff({
    app: {
      route: "/session/abc",
      activeWorkspaceId: "ws-app",
      connectingWorkspaceId: "ws-next",
      activeWorkspaceRoot: "/repo/app",
      projectDir: "/repo/app",
      engineReady: true,
    },
    session: {
      selectedSessionId: "ses_1",
      selectedScope: {
        workspaceId: "ws-selected",
      },
      sendTarget: {
        workspaceId: "ws-send",
      },
    },
    routing: {
      entryIds: ["ws-app", "ws-other"],
    },
    tauri: {
      workspaceBootstrap: {
        ok: true,
        value: {
          activeId: "ws-tauri",
        },
      },
    },
    server: {
      workspaces: {
        ok: true,
        value: {
          activeId: "ws-server",
        },
      },
    },
    orchestrator: {
      status: {
        ok: true,
        value: {
          activeId: "ws-orchestrator",
        },
      },
    },
    diagnosis: [
      {
        level: "warning",
        code: "send-would-activate-workspace",
      },
    ],
  });

  assert.deepEqual(summary, {
    route: "/session/abc",
    activeWorkspaceId: "ws-app",
    connectingWorkspaceId: "ws-next",
    activeWorkspaceRoot: "/repo/app",
    projectDir: "/repo/app",
    engineReady: true,
    selectedSessionId: "ses_1",
    selectedScopeWorkspaceId: "ws-selected",
    sendTargetWorkspaceId: "ws-send",
    routedWorkspaceIds: ["ws-app", "ws-other"],
    tauriActiveId: "ws-tauri",
    serverActiveId: "ws-server",
    orchestratorActiveId: "ws-orchestrator",
    diagnosis: ["warning:send-would-activate-workspace"],
  });
});

test("workspace runtime debug probe installs compatible window globals and cleans them up", async () => {
  const logs: Array<{ event: string; payload?: Record<string, unknown> }> = [];
  const windowTarget: Record<string, unknown> = {};
  let snapshotVersion = 0;
  const probe = createWorkspaceRuntimeDebugProbe({
    windowTarget: windowTarget as never,
    readSnapshot: async () => ({
      app: {
        route: "/dashboard",
        activeWorkspaceId: "ws-app",
        engineReady: true,
      },
      routing: {
        entryIds: ["ws-app"],
        entries: [
          {
            workspaceId: "ws-app",
          },
        ],
      },
      diagnosis: [
        {
          level: "info",
          code: `snapshot-${++snapshotVersion}`,
        },
      ],
    }),
    getRequestBrokerSnapshot: () => ({ pending: 0 }),
    log: (event, payload) => logs.push({ event, payload }),
  });

  const cleanup = probe.install();
  assert.equal(typeof windowTarget.__vesloWorkspaceRuntimeSnapshot, "function");
  assert.equal(typeof windowTarget.__vesloWorkspaceRuntimeDiff, "function");
  assert.equal(typeof windowTarget.__vesloRequestBrokerSnapshot, "function");
  assert.match(String(windowTarget.__vesloWorkspaceRuntimeDebugHelp), /__vesloWorkspaceRuntimeSnapshot/);

  const snapshot = await (windowTarget.__vesloWorkspaceRuntimeSnapshot as () => Promise<Record<string, unknown>>)();
  assert.equal(windowTarget.__vesloWorkspaceRuntimeLastSnapshot, snapshot);
  assert.deepEqual((windowTarget.__vesloRequestBrokerSnapshot as () => unknown)(), { pending: 0 });

  const diff = await (windowTarget.__vesloWorkspaceRuntimeDiff as () => Promise<Record<string, unknown>>)();
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.diagnosis, [{ level: "info", code: "snapshot-2" }]);
  assert.equal(logs[0]?.event, "runtime-probe:installed");

  cleanup();
  assert.equal(windowTarget.__vesloWorkspaceRuntimeSnapshot, undefined);
  assert.equal(windowTarget.__vesloWorkspaceRuntimeDiff, undefined);
  assert.equal(windowTarget.__vesloRequestBrokerSnapshot, undefined);
  assert.equal(windowTarget.__vesloWorkspaceRuntimeDebugHelp, undefined);
});
