import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type AddressInfo } from "node:net";
import { once } from "node:events";

import { startServer } from "../server.js";
import type { ServerConfig } from "../types.js";

const servers: Array<{ stop: (closeActiveConnections?: boolean) => void }> = [];

afterEach(() => {
  while (servers.length > 0) {
    const server = servers.pop();
    try {
      server?.stop(true);
    } catch {
      // best effort cleanup
    }
  }
});

async function findFreePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  probe.close();
  await once(probe, "close");
  return port;
}

async function canBindHost(host: string): Promise<boolean> {
  const probe = createServer();
  try {
    probe.listen(0, host);
    await once(probe, "listening");
    return true;
  } catch {
    return false;
  } finally {
    if (probe.listening) {
      probe.close();
      await once(probe, "close");
    } else {
      try {
        probe.close();
      } catch {
        // best effort cleanup
      }
    }
  }
}

function createConfig(overrides: Partial<ServerConfig>): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
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
    ...overrides,
  };
}

const bridgeHostBindable = await canBindHost("127.0.0.2");

describe("veslo-server bridge listener", () => {
  test.skipIf(!bridgeHostBindable)(
    bridgeHostBindable
      ? "serves the same handler on the bridge host as on the primary host"
      : "serves the same handler on the bridge host as on the primary host (skipped: 127.0.0.2 cannot be bound)",
    async () => {
      const port = await findFreePort();
      const server = startServer(createConfig({ host: "127.0.0.1", bridgeHost: "127.0.0.2", port }));
      servers.push(server);

      const primary = await fetch(`http://127.0.0.1:${port}/health`);
      const bridge = await fetch(`http://127.0.0.2:${port}/health`);

      expect(primary.status).toBe(200);
      expect(bridge.status).toBe(200);

      const primaryBody = await primary.json();
      const bridgeBody = await bridge.json();
      // Same shared fetch handler => same non-secret health identity.
      expect(bridgeBody).toMatchObject({ pid: (primaryBody as { pid?: number }).pid });
      expect((primaryBody as { token?: unknown }).token).toBeUndefined();
      expect((bridgeBody as { token?: unknown }).token).toBeUndefined();
    },
  );

  test("keeps the primary listener alive when the bridge host cannot be bound", async () => {
    const port = await findFreePort();
    const server = startServer(createConfig({ host: "127.0.0.1", bridgeHost: "203.0.113.1", port }));
    servers.push(server);

    const primary = await fetch(`http://127.0.0.1:${port}/health`);
    expect(primary.status).toBe(200);
  });

  test("does not open a bridge listener when bridgeHost is unset", async () => {
    const port = await findFreePort();
    const server = startServer(createConfig({ host: "127.0.0.1", port }));
    servers.push(server);

    const primary = await fetch(`http://127.0.0.1:${port}/health`);
    expect(primary.status).toBe(200);

    let bridgeReachable = true;
    try {
      await fetch(`http://127.0.0.2:${port}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
    } catch {
      bridgeReachable = false;
    }
    expect(bridgeReachable).toBe(false);
  });
});
