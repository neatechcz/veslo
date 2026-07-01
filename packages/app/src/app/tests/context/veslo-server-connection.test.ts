import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

import {
  createVesloServerConnection,
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

test("server connection resolves local, server, and fallback endpoints without monolithic app state", () => {
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
      localFallbackUrl: "http://127.0.0.1:8787",
      settingsUrl: "https://remote.example",
    }),
    "http://127.0.0.1:8787",
  );
  assert.equal(
    resolveVesloServerBaseUrl({
      startupPreference: "server",
      activeHostInfo: localHost,
      localFallbackUrl: "http://127.0.0.1:8787",
      settingsUrl: "https://remote.example",
    }),
    "https://remote.example",
  );
  assert.deepEqual(
    resolveVesloServerAuth({
      startupPreference: null,
      activeHostInfo: localHost,
      localFallbackUrl: "http://127.0.0.1:8787",
      settingsToken: "remote-token",
    }),
    { token: "local-token", hostToken: "host-token" },
  );
});

test("server health checks preserve limited auth semantics and connected capabilities", async () => {
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
        createClient: factory,
      });

      assert.deepEqual(await connection.checkVesloServer("http://worker.test"), {
        status: "limited",
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
