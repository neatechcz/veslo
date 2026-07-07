import { afterEach, describe, expect, test } from "bun:test";

import { parseCliArgs, resolveServerConfig } from "../config.js";
import { readServerEnv, SERVER_CONFIG_ENV_KEYS } from "../env.js";

const snapshot = new Map<string, string | undefined>();

function snapshotEnv() {
  for (const key of SERVER_CONFIG_ENV_KEYS) {
    snapshot.set(key, process.env[key]);
    delete process.env[key];
  }
}

afterEach(() => {
  for (const key of SERVER_CONFIG_ENV_KEYS) {
    const value = snapshot.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  snapshot.clear();
});

describe("server env validation", () => {
  test("normalizes typed config env values without changing config fallback order", async () => {
    snapshotEnv();

    process.env.VESLO_PORT = " 8788 ";
    process.env.VESLO_READONLY = "no";
    process.env.VESLO_LOG_REQUESTS = "off";
    process.env.VESLO_LOG_FORMAT = "human";
    process.env.VESLO_APPROVAL_MODE = "auto";
    process.env.VESLO_APPROVAL_TIMEOUT_MS = "12000";
    process.env.VESLO_ORCHESTRATOR_URL = "http://127.0.0.1:4096///";
    process.env.VESLO_DEN_API_BASE = "https://den.example///";
    process.env.VESLO_SKILL_REGISTRY_BASE_URL = "https://registry.example///";
    process.env.VESLO_LOG_BATCH_MAX_EVENTS = "50";

    const config = await resolveServerConfig(parseCliArgs([]));

    expect(config.port).toBe(8788);
    expect(config.readOnly).toBe(false);
    expect(config.logRequests).toBe(false);
    expect(config.logFormat).toBe("pretty");
    expect(config.approval).toEqual({ mode: "auto", timeoutMs: 12000 });
    expect(config.orchestratorDaemonUrl).toBe("http://127.0.0.1:4096");
    expect(config.denApiBase).toBe("https://den.example");
    expect(config.skillRegistryBaseUrl).toBe("https://registry.example");
    expect(config.debugLogs.batchMaxEvents).toBe(50);
  });

  test("treats empty env values as unset", async () => {
    snapshotEnv();

    process.env.VESLO_PORT = " ";
    process.env.VESLO_READONLY = "";
    process.env.VESLO_LOG_REQUESTS = " ";

    const config = await resolveServerConfig(parseCliArgs([]));

    expect(config.port).toBe(8787);
    expect(config.readOnly).toBe(false);
    expect(config.logRequests).toBe(true);
  });

  test("rejects invalid env port", () => {
    snapshotEnv();

    process.env.VESLO_PORT = "abc";

    expect(() => readServerEnv()).toThrow(/VESLO_PORT/);
  });

  test("rejects invalid env booleans", () => {
    snapshotEnv();

    process.env.VESLO_READONLY = "maybe";

    expect(() => readServerEnv()).toThrow(/VESLO_READONLY/);
  });

  test("rejects invalid env URLs", () => {
    snapshotEnv();

    process.env.VESLO_DEN_API_BASE = "ftp://den.example";

    expect(() => readServerEnv()).toThrow(/VESLO_DEN_API_BASE/);
  });

  test("rejects invalid positive integer env values", () => {
    snapshotEnv();

    process.env.VESLO_APPROVAL_TIMEOUT_MS = "0";

    expect(() => readServerEnv()).toThrow(/VESLO_APPROVAL_TIMEOUT_MS/);
  });
});
