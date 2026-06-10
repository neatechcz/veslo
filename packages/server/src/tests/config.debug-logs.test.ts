import { afterEach, describe, expect, test } from "bun:test";

import { parseCliArgs, resolveServerConfig } from "../config.js";

const ENV_KEYS = [
  "VESLO_LOG_INGEST_URL",
  "VESLO_LOG_INGEST_TOKEN",
  "VESLO_LOG_BATCH_MAX_EVENTS",
  "VESLO_LOG_BATCH_MAX_BYTES",
  "VESLO_LOG_SPOOL_MAX_BYTES",
  "VESLO_LOG_FLUSH_INTERVAL_MS",
] as const;

const snapshot = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = snapshot.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  snapshot.clear();
});

describe("debug log config", () => {
  test("resolveServerConfig reads debug log ingest settings from env", async () => {
    for (const key of ENV_KEYS) snapshot.set(key, process.env[key]);

    process.env.VESLO_LOG_INGEST_URL = "https://den.example/v1/internal/debug-logs";
    process.env.VESLO_LOG_INGEST_TOKEN = "ingest-token";
    process.env.VESLO_LOG_BATCH_MAX_EVENTS = "250";
    process.env.VESLO_LOG_BATCH_MAX_BYTES = "262144";
    process.env.VESLO_LOG_SPOOL_MAX_BYTES = "104857600";
    process.env.VESLO_LOG_FLUSH_INTERVAL_MS = "7500";

    const config = await resolveServerConfig(parseCliArgs([]));

    expect(config.debugLogs.enabled).toBe(true);
    expect(config.debugLogs.ingestUrl).toBe("https://den.example/v1/internal/debug-logs");
    expect(config.debugLogs.ingestToken).toBe("ingest-token");
    expect(config.debugLogs.batchMaxEvents).toBe(250);
    expect(config.debugLogs.batchMaxBytes).toBe(262144);
    expect(config.debugLogs.spoolMaxBytes).toBe(104857600);
    expect(config.debugLogs.flushIntervalMs).toBe(7500);
  });

  test("resolveServerConfig defaults flushIntervalMs when env is missing", async () => {
    for (const key of ENV_KEYS) snapshot.set(key, process.env[key]);
    for (const key of ENV_KEYS) delete process.env[key];

    const config = await resolveServerConfig(parseCliArgs([]));
    expect(config.debugLogs.enabled).toBe(false);
    expect(config.debugLogs.flushIntervalMs).toBe(5000);
  });
});
