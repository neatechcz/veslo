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

describe("veslo-server bridge listener", () => {
  test("serves the same handler on the bridge host as on the primary host", async () => {
    const port = await findFreePort();
    const server = startServer(createConfig({ host: "127.0.0.1", bridgeHost: "127.0.0.2", port }));
    servers.push(server);

    const primary = await fetch(`http://127.0.0.1:${port}/health`);
    const bridge = await fetch(`http://127.0.0.2:${port}/health`);

    expect(primary.status).toBe(200);
    expect(bridge.status).toBe(200);

    const primaryBody = await primary.json();
    const bridgeBody = await bridge.json();
    // Same shared fetch handler => same health identity (token/pid).
    expect(bridgeBody).toMatchObject({ token: (primaryBody as { token?: string }).token });
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
