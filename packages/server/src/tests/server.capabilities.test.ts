import { expect, test } from "bun:test";

import { buildCapabilities } from "../server.js";
import type { ServerConfig } from "../types.js";

const baseConfig = (overrides: Partial<ServerConfig> = {}): ServerConfig => ({
  host: "127.0.0.1",
  port: 8787,
  token: "client-token",
  hostToken: "host-token",
  approval: { mode: "auto", timeoutMs: 1_000 },
  corsOrigins: ["*"],
  workspaces: [],
  authorizedRoots: [],
  readOnly: false,
  startedAt: 1,
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
});

test("buildCapabilities exposes skill registry availability", () => {
  expect(buildCapabilities(baseConfig()).skillRegistry).toEqual({ configured: false });
  expect(buildCapabilities(baseConfig({ skillRegistryBaseUrl: "https://registry.example" })).skillRegistry)
    .toEqual({ configured: true });
  expect(buildCapabilities(baseConfig({ skillRegistryBaseUrl: "   " })).skillRegistry)
    .toEqual({ configured: false });
});
