import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

import {
  createVesloServerConnection,
  mergeVesloServerDescriptorEvent,
  resolveVesloServerAuth,
  resolveVesloServerBaseUrl,
  type VesloServerConnectionClientFactory,
} from "../../context/veslo-server-connection.js";
import { VesloServerError } from "../../lib/veslo-server.js";
import type { VesloServerCapabilities } from "../../lib/veslo-server.js";
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
        throw new VesloServerError(401, "invalid_bearer_token", "Invalid bearer token");
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

      assert.deepEqual(await connection.checkVesloServer("http://worker.test"), {
        status: "limited",
        capabilities: null,
      });
      assert.deepEqual(await connection.checkVesloServer("http://worker.test", "bad-token"), {
        status: "auth_desync",
        capabilities: null,
      });
      assert.deepEqual(await connection.checkVesloServer("http://worker.test", "token"), {
        status: "connected",
        capabilities: capabilities(),
      });
    } finally {
      dispose();
    }
  });
});

test("local Tauri server check requires runtimeChain readiness", async () => {
  let rootStatusCalls = 0;
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
          orchestrator: { configured: true, daemonUrl: "http://127.0.0.1:52008", ok: true, engineTopology: "shared-unsandboxed", error: null },
          sharedEngine: { running: true, pending: false, engineState: "ready", baseUrl: "http://127.0.0.1:53553" },
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
        sharedEngine: { running: null, pending: null, engineState: null, baseUrl: null },
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
        createClient: factory,
      });

      assert.deepEqual(await connection.checkVesloServer("http://127.0.0.1:8787", "token"), {
        status: "disconnected",
        capabilities: null,
      });
      assert.equal(rootStatusCalls, 0);
      assert.deepEqual(workspaceStatusCalls, ["ws-a"]);
      assert.equal(connection.vesloServerDiagnostics()?.runtimeChain?.status, "orchestrator_unavailable");
    } finally {
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
            sharedEngine: { running: null, pending: null, engineState: null, baseUrl: null },
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
          sharedEngine: { running: true, pending: false, engineState: "ready", baseUrl: "http://127.0.0.1:53553" },
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

      const runtimeChain = connection.ensureLocalVesloServerRunning({ ignoreStartupPreference: true });
      const serverOnly = connection.ensureLocalVesloServerRunning({
        ignoreStartupPreference: true,
        requireRuntimeChainReady: false,
      });
      const runtimeChainDuplicate = connection.ensureLocalVesloServerRunning({ ignoreStartupPreference: true });

      assert.equal(infoCalls, 2);
      releaseInfo?.();

      assert.deepEqual(await Promise.all([runtimeChain, serverOnly, runtimeChainDuplicate]), [true, true, true]);
      assert.equal(infoCalls, 2);
    } finally {
      dispose();
    }
  });
});

test("local ensure does not restart the server on auth desync", async () => {
  let restartCalls = 0;
  const factory: VesloServerConnectionClientFactory = () => ({
    baseUrl: "http://127.0.0.1:8787",
    health: async () => ({ ok: true, version: "test", uptimeMs: 1 }),
    capabilities: async () => {
      throw new VesloServerError(401, "invalid_bearer_token", "Invalid bearer token");
    },
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

      const ok = await connection.ensureLocalVesloServerRunning({ ignoreStartupPreference: true });

      assert.equal(ok, false);
      assert.equal(restartCalls, 0);
      assert.equal(connection.vesloServerStatus(), "auth_desync");
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
