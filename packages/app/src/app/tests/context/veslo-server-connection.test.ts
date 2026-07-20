import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

import {
  createVesloServerConnection,
  mergeVesloServerDescriptorEvent,
  resolveManagedAiConfigAuthority,
  resolveVesloRuntimeReadiness,
  resolveVesloServerAuth,
  resolveVesloServerBaseUrl,
  type VesloServerConnectionClientFactory,
} from "../../context/veslo-server-connection.js";
import { VesloServerError } from "../../lib/veslo-server.js";
import type { VesloServerCapabilities } from "../../lib/veslo-server.js";
import { clearPerfLogs, readPerfLogs } from "../../lib/perf-log.js";
import type { VesloServerInfo } from "../../lib/tauri.js";

const capabilities = (): VesloServerCapabilities => ({
  skills: { read: true, write: true, source: "veslo" },
  plugins: { read: true, write: true },
  mcp: { read: true, write: true },
  commands: { read: true, write: true },
  config: { read: true, write: true },
});

const runningHostInfo = (): VesloServerInfo => ({
  running: true,
  host: "127.0.0.1",
  port: 8787,
  instanceId: "instance-test",
  baseUrl: "http://127.0.0.1:8787",
  connectUrl: null,
  mdnsUrl: null,
  lanUrl: null,
  engineUrl: null,
  clientToken: "client",
  hostToken: "host",
  pid: null,
  lastStdout: null,
  lastStderr: null,
});

test("managed AI config authority waits for a readable and writable server config owner", () => {
  const writableCapabilities = capabilities();
  const readOnlyCapabilities = {
    ...capabilities(),
    config: { read: true, write: false },
  };

  assert.deepEqual(resolveManagedAiConfigAuthority({
    serverCheckedAt: null,
    projectFallbackConfirmed: false,
    status: "disconnected",
    capabilities: null,
    workspaceConfigId: null,
  }), { kind: "pending" });
  assert.deepEqual(resolveManagedAiConfigAuthority({
    serverCheckedAt: 1,
    projectFallbackConfirmed: true,
    status: "disconnected",
    capabilities: null,
    workspaceConfigId: null,
  }), { kind: "project-fallback", reason: "serverless" });
  assert.deepEqual(resolveManagedAiConfigAuthority({
    serverCheckedAt: 1,
    projectFallbackConfirmed: false,
    status: "disconnected",
    capabilities: null,
    workspaceConfigId: null,
  }), { kind: "pending" });
  assert.deepEqual(resolveManagedAiConfigAuthority({
    serverCheckedAt: 1,
    projectFallbackConfirmed: false,
    status: "connected",
    capabilities: readOnlyCapabilities,
    workspaceConfigId: "ws-active",
  }), { kind: "project-fallback", reason: "unwritable" });
  assert.deepEqual(resolveManagedAiConfigAuthority({
    serverCheckedAt: 1,
    projectFallbackConfirmed: false,
    status: "connected",
    capabilities: writableCapabilities,
    workspaceConfigId: null,
  }), { kind: "pending" });
  assert.deepEqual(resolveManagedAiConfigAuthority({
    serverCheckedAt: 1,
    projectFallbackConfirmed: false,
    status: "connected",
    capabilities: writableCapabilities,
    workspaceConfigId: "ws-active",
  }), { kind: "server", workspaceConfigId: "ws-active" });
});

test("server connection resolves local and server endpoints without derived local fallback", () => {
  const localHost = {
    baseUrl: "http://127.0.0.1:8787",
    connectUrl: "http://127.0.0.1:8787",
    clientToken: "local-token",
    hostToken: "host-token",
  };

  assert.equal(
    resolveVesloServerBaseUrl({
      startupPreference: "local",
      activeHostInfo: localHost,
      settingsUrl: "https://remote.example",
    }),
    "http://127.0.0.1:8787",
  );
  assert.equal(
    resolveVesloServerBaseUrl({
      startupPreference: "server",
      activeHostInfo: localHost,
      settingsUrl: "https://remote.example",
    }),
    "https://remote.example",
  );
  assert.deepEqual(
    resolveVesloServerAuth({
      startupPreference: null,
      activeHostInfo: localHost,
      settingsToken: "remote-token",
    }),
    { token: "local-token", hostToken: "host-token" },
  );
  assert.equal(
    resolveVesloServerBaseUrl({
      startupPreference: "local",
      activeHostInfo: null,
      settingsUrl: "https://remote.example",
    }),
    "",
  );
  assert.deepEqual(
    resolveVesloServerAuth({
      startupPreference: null,
      activeHostInfo: null,
      settingsToken: "remote-token",
    }),
    { token: "remote-token", hostToken: undefined },
  );
});

test("server health checks distinguish no-token limited mode from auth desync", async () => {
  const factory: VesloServerConnectionClientFactory = ({ token }) => ({
    baseUrl: "http://worker.test",
    health: async () => ({ ok: true, version: "test", uptimeMs: 1 }),
    capabilities: async () => {
      if (!token) {
        throw new VesloServerError(403, "forbidden", "Forbidden");
      }
      if (token === "bad-token") {
        throw new VesloServerError(
          401,
          "invalid_bearer_token",
          "Invalid bearer token",
        );
      }
      return capabilities();
    },
  });

  await createRoot(async (dispose) => {
    try {
      const connection = createVesloServerConnection({
        startupPreference: () => null,
        opencodeBaseUrl: () => "",
        authenticatedAccountId: () => null,
        cloudEnvironment: {},
        documentVisible: () => false,
        developerMode: () => false,
        isTauriRuntime: () => false,
        createClient: factory,
      });

      assert.deepEqual(
        await connection.checkVesloServer("http://worker.test"),
        {
          status: "limited",
          capabilities: null,
          runtimeReadiness: "not-applicable",
        },
      );
      assert.deepEqual(
        await connection.checkVesloServer("http://worker.test", "bad-token"),
        {
          status: "auth_desync",
          capabilities: null,
          runtimeReadiness: "unknown",
        },
      );
      assert.deepEqual(
        await connection.checkVesloServer("http://worker.test", "token"),
        {
          status: "connected",
          capabilities: capabilities(),
          runtimeReadiness: "not-applicable",
        },
      );
    } finally {
      dispose();
    }
  });
});

test("manual connection test requires authenticated server status", async () => {
  let remoteWorkspaceCalls = 0;
  const factory: VesloServerConnectionClientFactory = ({ token }) => ({
    baseUrl: "http://worker.test",
    health: async () => ({ ok: true, version: "test", uptimeMs: 1 }),
    capabilities: async () => {
      if (!token) {
        throw new VesloServerError(403, "forbidden", "Forbidden");
      }
      return capabilities();
    },
  });

  await createRoot(async (dispose) => {
    try {
      const connection = createVesloServerConnection({
        startupPreference: () => null,
        opencodeBaseUrl: () => "",
        authenticatedAccountId: () => null,
        cloudEnvironment: {},
        documentVisible: () => false,
        developerMode: () => false,
        isTauriRuntime: () => false,
        workspace: {
          workspacesHydrated: () => true,
          activeWorkspaceDisplay: () => ({ workspaceType: "local" }),
          activeWorkspaceId: () => "ws-a",
          activeWorkspaceRoot: () => "/tmp/ws-a",
          createRemoteWorkspaceFlow: async () => {
            remoteWorkspaceCalls += 1;
          },
        },
        createClient: factory,
      });

      const ok = await connection.testVesloServerConnection({
        urlOverride: "http://worker.test",
      });

      assert.equal(ok, false);
      assert.equal(connection.vesloServerStatus(), "limited");
      assert.equal(connection.vesloServerCapabilities(), null);
      assert.equal(remoteWorkspaceCalls, 0);
    } finally {
      dispose();
    }
  });
});

test("local Tauri server check preserves server reachability when the runtime is unavailable", async () => {
  let rootStatusCalls = 0;
  let restartCalls = 0;
  const workspaceStatusCalls: string[] = [];
  const factory: VesloServerConnectionClientFactory = () => ({
    baseUrl: "http://127.0.0.1:8787",
    health: async () => ({ ok: true, version: "test", uptimeMs: 1 }),
    capabilities: async () => capabilities(),
    status: async () => {
      rootStatusCalls += 1;
      return {
        ok: true,
        version: "test",
        uptimeMs: 1,
        readOnly: false,
        approval: { mode: "manual", timeoutMs: 1 },
        corsOrigins: [],
        workspaceCount: 2,
        activeWorkspaceId: "ws-root",
        workspace: null,
        authorizedRoots: [],
        server: { host: "127.0.0.1", port: 8787, configPath: null },
        tokenSource: { client: "generated", host: "generated" },
        runtimeChain: {
          status: "runtime_chain_ready",
          checkedAt: Date.now(),
          orchestrator: {
            configured: true,
            daemonUrl: "http://127.0.0.1:52008",
            ok: true,
            engineTopology: "shared-unsandboxed",
            error: null,
          },
          sharedEngine: {
            running: true,
            pending: false,
            engineState: "ready",
            baseUrl: "http://127.0.0.1:53553",
          },
          proxy: { workspaceId: "ws-root", ok: true, status: 200, error: null },
        },
      };
    },
    workspace: {
      statusForWorkspace: async (workspaceId: string) => {
        workspaceStatusCalls.push(workspaceId);
        return {
          ok: true,
          version: "test",
          uptimeMs: 1,
          readOnly: false,
          approval: { mode: "manual", timeoutMs: 1 },
          corsOrigins: [],
          workspaceCount: 1,
          activeWorkspaceId: "ws-a",
          workspace: null,
          authorizedRoots: [],
          server: { host: "127.0.0.1", port: 8787, configPath: null },
          tokenSource: { client: "generated", host: "generated" },
          runtimeChain: {
            status: "orchestrator_unavailable",
            checkedAt: Date.now(),
            orchestrator: {
              configured: true,
              daemonUrl: "http://127.0.0.1:52008",
              ok: false,
              engineTopology: null,
              error: "connect ECONNREFUSED",
            },
            sharedEngine: {
              running: null,
              pending: null,
              engineState: null,
              baseUrl: null,
            },
            proxy: { workspaceId: "ws-a", ok: null, status: null, error: null },
          },
        };
      },
    } as any,
  });

  await createRoot(async (dispose) => {
    try {
      const connection = createVesloServerConnection({
        startupPreference: () => "local",
        opencodeBaseUrl: () => "",
        authenticatedAccountId: () => null,
        cloudEnvironment: {},
        documentVisible: () => false,
        developerMode: () => false,
        isTauriRuntime: () => true,
        workspace: {
          workspacesHydrated: () => true,
          activeWorkspaceDisplay: () => ({ workspaceType: "local" }),
          activeWorkspaceId: () => "ws-a",
          activeWorkspaceRoot: () => "/tmp/ws-a",
        },
        vesloServerInfo: async () => runningHostInfo(),
        vesloServerRestart: async () => {
          restartCalls += 1;
          return runningHostInfo();
        },
        createClient: factory,
      });

      assert.equal(
        await connection.testVesloServerConnection({
          urlOverride: "http://127.0.0.1:8787",
          token: "token",
        }),
        true,
      );
      assert.equal(rootStatusCalls, 0);
      assert.deepEqual(workspaceStatusCalls, ["ws-a"]);
      assert.equal(connection.vesloServerStatus(), "connected");
      assert.deepEqual(connection.vesloServerCapabilities(), capabilities());
      assert.equal(
        connection.vesloServerDiagnostics()?.runtimeChain?.status,
        "orchestrator_unavailable",
      );
      assert.deepEqual(connection.vesloServerConnectionSnapshot(), {
        serverReachability: "reachable",
        runtimeReadiness: "unavailable",
      });
      assert.equal(
        await connection.ensureLocalVesloServerRunning({
          ignoreStartupPreference: true,
        }),
        false,
      );
      assert.equal(restartCalls, 0);
    } finally {
      dispose();
    }
  });
});

test("runtime readiness maps local runtime diagnostics without changing external server reachability", () => {
  const diagnostics = (
    status:
      | "runtime_chain_ready"
      | "server_running"
      | "shared_engine_unhealthy"
      | "orchestrator_unavailable"
      | "proxy_unreachable",
    pending = false,
  ) => ({
    ok: true,
    version: "test",
    uptimeMs: 1,
    readOnly: false,
    approval: { mode: "manual" as const, timeoutMs: 1 },
    corsOrigins: [],
    workspaceCount: 1,
    activeWorkspaceId: "ws-a",
    workspace: null,
    authorizedRoots: [],
    server: { host: "127.0.0.1", port: 8787, configPath: null },
    tokenSource: { client: "generated", host: "generated" },
    runtimeChain: {
      status,
      checkedAt: Date.now(),
      orchestrator: {
        configured: true,
        daemonUrl: "http://127.0.0.1:52008",
        ok: true,
        engineTopology: "shared-unsandboxed",
        error: null,
      },
      sharedEngine: {
        running: !pending,
        pending,
        engineState: pending ? "starting" : "ready",
        baseUrl: null,
      },
      proxy: {
        workspaceId: "ws-a",
        ok: status === "runtime_chain_ready",
        status: null,
        error: null,
      },
    },
  });

  assert.equal(
    resolveVesloRuntimeReadiness({
      localRuntimeContract: true,
      diagnostics: diagnostics("runtime_chain_ready"),
    }),
    "ready",
  );
  assert.equal(
    resolveVesloRuntimeReadiness({
      localRuntimeContract: true,
      diagnostics: diagnostics("server_running"),
    }),
    "starting",
  );
  assert.equal(
    resolveVesloRuntimeReadiness({
      localRuntimeContract: true,
      diagnostics: diagnostics("shared_engine_unhealthy", true),
    }),
    "starting",
  );
  assert.equal(
    resolveVesloRuntimeReadiness({
      localRuntimeContract: true,
      diagnostics: diagnostics("shared_engine_unhealthy"),
    }),
    "degraded",
  );
  assert.equal(
    resolveVesloRuntimeReadiness({
      localRuntimeContract: true,
      diagnostics: diagnostics("orchestrator_unavailable"),
    }),
    "unavailable",
  );
  assert.equal(
    resolveVesloRuntimeReadiness({
      localRuntimeContract: true,
      diagnostics: diagnostics("proxy_unreachable"),
    }),
    "degraded",
  );
  assert.equal(
    resolveVesloRuntimeReadiness({
      localRuntimeContract: false,
      diagnostics: diagnostics("server_running"),
    }),
    "not-applicable",
  );
});

test("connection tracing records distinct runtime transitions without poll noise", async () => {
  clearPerfLogs();
  let runtimeChainStatus: "server_running" | "runtime_chain_ready" =
    "server_running";
  const factory: VesloServerConnectionClientFactory = () => ({
    baseUrl: "http://127.0.0.1:8787",
    health: async () => ({ ok: true, version: "test", uptimeMs: 1 }),
    capabilities: async () => capabilities(),
    workspace: {
      statusForWorkspace: async () => ({
        ok: true,
        version: "test",
        uptimeMs: 1,
        readOnly: false,
        approval: { mode: "manual", timeoutMs: 1 },
        corsOrigins: [],
        workspaceCount: 1,
        activeWorkspaceId: "ws-a",
        workspace: null,
        authorizedRoots: [],
        server: { host: "127.0.0.1", port: 8787, configPath: null },
        tokenSource: { client: "generated", host: "generated" },
        runtimeChain: {
          status: runtimeChainStatus,
          checkedAt: Date.now(),
          orchestrator: {
            configured: true,
            daemonUrl: "http://127.0.0.1:52008",
            ok: true,
            engineTopology: "shared-unsandboxed",
            error: null,
          },
          sharedEngine: {
            running: runtimeChainStatus === "runtime_chain_ready",
            pending: runtimeChainStatus === "server_running",
            engineState:
              runtimeChainStatus === "runtime_chain_ready"
                ? "ready"
                : "starting",
            baseUrl: null,
          },
          proxy: {
            workspaceId: "ws-a",
            ok: runtimeChainStatus === "runtime_chain_ready",
            status: 200,
            error: null,
          },
        },
      }),
    } as any,
  });

  await createRoot(async (dispose) => {
    try {
      const connection = createVesloServerConnection({
        startupPreference: () => "local",
        opencodeBaseUrl: () => "",
        authenticatedAccountId: () => null,
        cloudEnvironment: {},
        documentVisible: () => false,
        developerMode: () => true,
        isTauriRuntime: () => true,
        workspace: {
          workspacesHydrated: () => true,
          activeWorkspaceDisplay: () => ({ workspaceType: "local" }),
          activeWorkspaceId: () => "ws-a",
          activeWorkspaceRoot: () => "/tmp/ws-a",
        },
        createClient: factory,
      });

      await connection.testVesloServerConnection({
        urlOverride: "http://127.0.0.1:8787",
        token: "token",
      });
      runtimeChainStatus = "runtime_chain_ready";
      await connection.testVesloServerConnection({
        urlOverride: "http://127.0.0.1:8787",
        token: "token",
      });

      const transitions = readPerfLogs().filter(
        (entry) =>
          entry.scope === "workspace.requests" &&
          entry.event === "veslo-connection-state",
      );
      assert.equal(transitions.length, 2);
      assert.deepEqual(
        transitions.map((entry) => ({
          source: entry.payload?.source,
          serverReachability: entry.payload?.serverReachability,
          runtimeReadiness: entry.payload?.runtimeReadiness,
          runtimeChainStatus: entry.payload?.runtimeChainStatus,
        })),
        [
          {
            source: "manual-test",
            serverReachability: "reachable",
            runtimeReadiness: "starting",
            runtimeChainStatus: "server_running",
          },
          {
            source: "manual-test",
            serverReachability: "reachable",
            runtimeReadiness: "ready",
            runtimeChainStatus: "runtime_chain_ready",
          },
        ],
      );
    } finally {
      clearPerfLogs();
      dispose();
    }
  });
});

test("local server-only ensure does not require runtimeChain readiness before runtime start", async () => {
  let restartCalls = 0;
  const workspaceStatusCalls: string[] = [];
  const factory: VesloServerConnectionClientFactory = () => ({
    baseUrl: "http://127.0.0.1:8787",
    health: async () => ({ ok: true, version: "test", uptimeMs: 1 }),
    capabilities: async () => capabilities(),
    workspace: {
      statusForWorkspace: async (workspaceId: string) => {
        workspaceStatusCalls.push(workspaceId);
        return {
          ok: true,
          version: "test",
          uptimeMs: 1,
          readOnly: false,
          approval: { mode: "manual", timeoutMs: 1 },
          corsOrigins: [],
          workspaceCount: 1,
          activeWorkspaceId: "ws-a",
          workspace: null,
          authorizedRoots: [],
          server: { host: "127.0.0.1", port: 8787, configPath: null },
          tokenSource: { client: "generated", host: "generated" },
          runtimeChain: {
            status: "orchestrator_unavailable",
            checkedAt: Date.now(),
            orchestrator: {
              configured: true,
              daemonUrl: "http://127.0.0.1:52008",
              ok: false,
              engineTopology: null,
              error: "connect ECONNREFUSED",
            },
            sharedEngine: {
              running: null,
              pending: null,
              engineState: null,
              baseUrl: null,
            },
            proxy: { workspaceId: "ws-a", ok: null, status: null, error: null },
          },
        };
      },
    } as any,
  });

  await createRoot(async (dispose) => {
    try {
      const connection = createVesloServerConnection({
        startupPreference: () => "local",
        opencodeBaseUrl: () => "",
        authenticatedAccountId: () => null,
        cloudEnvironment: {},
        documentVisible: () => false,
        developerMode: () => false,
        isTauriRuntime: () => true,
        workspace: {
          workspacesHydrated: () => true,
          activeWorkspaceDisplay: () => ({ workspaceType: "local" }),
          activeWorkspaceId: () => "ws-a",
          activeWorkspaceRoot: () => "/tmp/ws-a",
        },
        vesloServerInfo: async () => runningHostInfo(),
        vesloServerRestart: async () => {
          restartCalls += 1;
          return runningHostInfo();
        },
        createClient: factory,
      });

      const ok = await connection.ensureLocalVesloServerRunning({
        ignoreStartupPreference: true,
        requireRuntimeChainReady: false,
      });

      assert.equal(ok, true);
      assert.equal(restartCalls, 0);
      assert.deepEqual(workspaceStatusCalls, []);
      assert.equal(connection.vesloServerStatus(), "connected");
      assert.deepEqual(connection.vesloServerCapabilities(), capabilities());
    } finally {
      dispose();
    }
  });
});

test("local ensure single-flights each readiness mode independently", async () => {
  let infoCalls = 0;
  let releaseInfo: (() => void) | null = null;
  const infoGate = new Promise<void>((resolve) => {
    releaseInfo = resolve;
  });
  const factory: VesloServerConnectionClientFactory = () => ({
    baseUrl: "http://127.0.0.1:8787",
    health: async () => ({ ok: true, version: "test", uptimeMs: 1 }),
    capabilities: async () => capabilities(),
    workspace: {
      statusForWorkspace: async () => ({
        ok: true,
        version: "test",
        uptimeMs: 1,
        readOnly: false,
        approval: { mode: "manual", timeoutMs: 1 },
        corsOrigins: [],
        workspaceCount: 1,
        activeWorkspaceId: "ws-a",
        workspace: null,
        authorizedRoots: [],
        server: { host: "127.0.0.1", port: 8787, configPath: null },
        tokenSource: { client: "generated", host: "generated" },
        runtimeChain: {
          status: "runtime_chain_ready",
          checkedAt: Date.now(),
          orchestrator: {
            configured: true,
            daemonUrl: "http://127.0.0.1:52008",
            ok: true,
            engineTopology: "shared-unsandboxed",
            error: null,
          },
          sharedEngine: {
            running: true,
            pending: false,
            engineState: "ready",
            baseUrl: "http://127.0.0.1:53553",
          },
          proxy: { workspaceId: "ws-a", ok: true, status: 200, error: null },
        },
      }),
    } as any,
  });

  await createRoot(async (dispose) => {
    try {
      const connection = createVesloServerConnection({
        startupPreference: () => "local",
        opencodeBaseUrl: () => "",
        authenticatedAccountId: () => null,
        cloudEnvironment: {},
        documentVisible: () => false,
        developerMode: () => false,
        isTauriRuntime: () => true,
        workspace: {
          workspacesHydrated: () => true,
          activeWorkspaceDisplay: () => ({ workspaceType: "local" }),
          activeWorkspaceId: () => "ws-a",
          activeWorkspaceRoot: () => "/tmp/ws-a",
        },
        vesloServerInfo: async () => {
          infoCalls += 1;
          await infoGate;
          return runningHostInfo();
        },
        createClient: factory,
      });

      const runtimeChain = connection.ensureLocalVesloServerRunning({
        ignoreStartupPreference: true,
      });
      const serverOnly = connection.ensureLocalVesloServerRunning({
        ignoreStartupPreference: true,
        requireRuntimeChainReady: false,
      });
      const runtimeChainDuplicate = connection.ensureLocalVesloServerRunning({
        ignoreStartupPreference: true,
      });

      assert.equal(infoCalls, 2);
      releaseInfo?.();

      assert.deepEqual(
        await Promise.all([runtimeChain, serverOnly, runtimeChainDuplicate]),
        [true, true, true],
      );
      assert.equal(infoCalls, 2);
    } finally {
      dispose();
    }
  });
});

test("local ensure reaches its owner deadline when Tauri server info never resolves", async () => {
  let restartCalls = 0;

  await createRoot(async (dispose) => {
    try {
      const connection = createVesloServerConnection({
        startupPreference: () => "local",
        opencodeBaseUrl: () => "",
        authenticatedAccountId: () => null,
        cloudEnvironment: {},
        documentVisible: () => false,
        developerMode: () => false,
        isTauriRuntime: () => true,
        workspace: {
          workspacesHydrated: () => true,
          activeWorkspaceDisplay: () => ({ workspaceType: "local" }),
          activeWorkspaceId: () => "ws-a",
          activeWorkspaceRoot: () => "/tmp/ws-a",
        },
        localEnsureTimeoutMs: 1,
        vesloServerInfo: () => new Promise(() => {}),
        vesloServerRestart: async () => {
          restartCalls += 1;
          return runningHostInfo();
        },
      });

      assert.equal(
        await connection.ensureLocalVesloServerRunning({
          ignoreStartupPreference: true,
          requireRuntimeChainReady: false,
        }),
        false,
      );
      assert.equal(restartCalls, 0);
      assert.equal(connection.vesloServerStatus(), "disconnected");
    } finally {
      dispose();
    }
  });
});

test("local ensure applies the same deadline when Tauri restart never resolves", async () => {
  let restartCalls = 0;

  await createRoot(async (dispose) => {
    try {
      const connection = createVesloServerConnection({
        startupPreference: () => "local",
        opencodeBaseUrl: () => "",
        authenticatedAccountId: () => null,
        cloudEnvironment: {},
        documentVisible: () => false,
        developerMode: () => false,
        isTauriRuntime: () => true,
        workspace: {
          workspacesHydrated: () => true,
          activeWorkspaceDisplay: () => ({ workspaceType: "local" }),
          activeWorkspaceId: () => "ws-a",
          activeWorkspaceRoot: () => "/tmp/ws-a",
        },
        localEnsureTimeoutMs: 1,
        vesloServerInfo: async () => null,
        vesloServerRestart: () => {
          restartCalls += 1;
          return new Promise(() => {});
        },
      });

      assert.equal(
        await connection.ensureLocalVesloServerRunning({
          ignoreStartupPreference: true,
          requireRuntimeChainReady: false,
        }),
        false,
      );
      assert.equal(restartCalls, 1);
      assert.equal(connection.vesloServerStatus(), "disconnected");
    } finally {
      dispose();
    }
  });
});

test("local ensure respawns the owned server once on auth desync", async () => {
  let restartCalls = 0;
  const factory: VesloServerConnectionClientFactory = () => ({
    baseUrl: "http://127.0.0.1:8787",
    health: async () => ({ ok: true, version: "test", uptimeMs: 1 }),
    capabilities: async () => {
      if (restartCalls === 0) {
        throw new VesloServerError(
          401,
          "invalid_bearer_token",
          "Invalid bearer token",
        );
      }
      return capabilities();
    },
    workspace: {
      statusForWorkspace: async () => ({
        ok: true,
        version: "test",
        uptimeMs: 1,
        readOnly: false,
        approval: { mode: "manual", timeoutMs: 1 },
        corsOrigins: [],
        workspaceCount: 1,
        activeWorkspaceId: "ws-a",
        workspace: null,
        authorizedRoots: [],
        server: { host: "127.0.0.1", port: 8787, configPath: null },
        tokenSource: { client: "generated", host: "generated" },
        runtimeChain: {
          status: "runtime_chain_ready",
          checkedAt: Date.now(),
          orchestrator: {
            configured: true,
            daemonUrl: "http://127.0.0.1:52008",
            ok: true,
            engineTopology: "shared-unsandboxed",
            error: null,
          },
          sharedEngine: {
            running: true,
            pending: false,
            engineState: "ready",
            baseUrl: "http://127.0.0.1:53553",
          },
          proxy: { workspaceId: "ws-a", ok: true, status: 200, error: null },
        },
      }),
    } as any,
  });

  await createRoot(async (dispose) => {
    try {
      const connection = createVesloServerConnection({
        startupPreference: () => "local",
        opencodeBaseUrl: () => "",
        authenticatedAccountId: () => null,
        cloudEnvironment: {},
        documentVisible: () => false,
        developerMode: () => false,
        isTauriRuntime: () => true,
        workspace: {
          workspacesHydrated: () => true,
          activeWorkspaceDisplay: () => ({ workspaceType: "local" }),
          activeWorkspaceId: () => "ws-a",
          activeWorkspaceRoot: () => "/tmp/ws-a",
        },
        vesloServerInfo: async () => runningHostInfo(),
        vesloServerRestart: async () => {
          restartCalls += 1;
          return runningHostInfo();
        },
        createClient: factory,
      });

      const ok = await connection.ensureLocalVesloServerRunning({
        ignoreStartupPreference: true,
      });

      assert.equal(ok, true);
      assert.equal(restartCalls, 1);
      assert.equal(connection.vesloServerStatus(), "connected");
    } finally {
      dispose();
    }
  });
});

test("a failed owned local ensure confirms managed AI project fallback", async () => {
  await createRoot(async (dispose) => {
    try {
      const connection = createVesloServerConnection({
        startupPreference: () => "local",
        opencodeBaseUrl: () => "",
        authenticatedAccountId: () => null,
        cloudEnvironment: {},
        documentVisible: () => false,
        developerMode: () => false,
        isTauriRuntime: () => true,
        workspace: {
          workspacesHydrated: () => true,
          activeWorkspaceDisplay: () => ({ workspaceType: "local" }),
          activeWorkspaceId: () => "ws-a",
          activeWorkspaceRoot: () => "/tmp/ws-a",
        },
        vesloServerInfo: async () => null,
        vesloServerRestart: async () => null,
      });

      assert.deepEqual(connection.managedAiConfigAuthority(), { kind: "pending" });
      assert.equal(await connection.ensureLocalVesloServerRunning(), false);
      assert.equal(connection.vesloServerStatus(), "disconnected");
      assert.deepEqual(connection.managedAiConfigAuthority(), {
        kind: "project-fallback",
        reason: "serverless",
      });
    } finally {
      dispose();
    }
  });
});

test("stable setters keep polled host and capability references when content is unchanged", () => {
  createRoot((dispose) => {
    const connection = createVesloServerConnection({
      startupPreference: () => null,
      opencodeBaseUrl: () => "",
      authenticatedAccountId: () => null,
      cloudEnvironment: {},
      documentVisible: () => false,
      developerMode: () => false,
      isTauriRuntime: () => false,
    });

    const firstCapabilities = capabilities();
    connection.setVesloServerCapabilitiesStable(firstCapabilities);
    assert.equal(connection.vesloServerCapabilities(), firstCapabilities);

    connection.setVesloServerCapabilitiesStable(capabilities());
    assert.equal(
      connection.vesloServerCapabilities(),
      firstCapabilities,
      "capability polling should not replace equivalent signal values",
    );

    const firstHostInfo = runningHostInfo();
    connection.setVesloServerHostInfoStable(firstHostInfo);
    assert.equal(connection.vesloServerHostInfo(), firstHostInfo);

    connection.setVesloServerHostInfoStable({ ...firstHostInfo });
    assert.equal(
      connection.vesloServerHostInfo(),
      firstHostInfo,
      "host polling should not replace equivalent signal values",
    );

    dispose();
  });
});

test("server state events preserve trusted in-memory owner fields for the same descriptor", () => {
  const current = {
    ...runningHostInfo(),
    hostToken: "host-token",
    lastStdout: "stdout",
    lastStderr: "stderr",
  };
  const eventPayload = {
    ...runningHostInfo(),
    hostToken: null,
    lastStdout: null,
    lastStderr: null,
    clientToken: "client-next",
  };

  const merged = mergeVesloServerDescriptorEvent(current, eventPayload);

  assert.equal(merged?.clientToken, "client-next");
  assert.equal(merged?.hostToken, "host-token");
  assert.equal(merged?.lastStdout, "stdout");
  assert.equal(merged?.lastStderr, "stderr");
});

test("server state events do not carry host token across a new instance", () => {
  const current = {
    ...runningHostInfo(),
    hostToken: "host-token",
  };
  const eventPayload = {
    ...runningHostInfo(),
    instanceId: "new-instance",
    baseUrl: "http://127.0.0.1:8790",
    hostToken: null,
  };

  const merged = mergeVesloServerDescriptorEvent(current, eventPayload);

  assert.equal(merged?.instanceId, "new-instance");
  assert.equal(merged?.hostToken, null);
});

test("server state events do not carry host token when a new instance reuses the same base URL", () => {
  const current = {
    ...runningHostInfo(),
    hostToken: "old-host-token",
    lastStdout: "old stdout",
  };
  const eventPayload = {
    ...runningHostInfo(),
    instanceId: "new-instance",
    hostToken: null,
    lastStdout: null,
  };

  const merged = mergeVesloServerDescriptorEvent(current, eventPayload);

  assert.equal(merged?.baseUrl, current.baseUrl);
  assert.equal(merged?.instanceId, "new-instance");
  assert.equal(merged?.hostToken, null);
  assert.equal(merged?.lastStdout, null);
});

test("server state events without identity do not inherit owner fields by base URL", () => {
  const current = {
    ...runningHostInfo(),
    hostToken: "old-host-token",
    lastStdout: "old stdout",
    lastStderr: "old stderr",
  };
  const eventPayload = {
    ...runningHostInfo(),
    instanceId: null,
    hostToken: null,
    lastStdout: null,
    lastStderr: null,
  };

  const merged = mergeVesloServerDescriptorEvent(current, eventPayload);

  assert.equal(merged?.baseUrl, current.baseUrl);
  assert.equal(merged?.instanceId, null);
  assert.equal(merged?.hostToken, null);
  assert.equal(merged?.lastStdout, null);
  assert.equal(merged?.lastStderr, null);
});
