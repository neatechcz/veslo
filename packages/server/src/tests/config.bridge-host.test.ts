import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { parseCliArgs, resolveServerConfig } from "../config.js";

const ENV_KEYS = ["VESLO_BRIDGE_HOST", "VESLO_HOST"] as const;
const snapshot = new Map<string, string | undefined>();
const tempDirs: string[] = [];

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = snapshot.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  snapshot.clear();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

function snapshotEnv() {
  for (const key of ENV_KEYS) snapshot.set(key, process.env[key]);
  for (const key of ENV_KEYS) delete process.env[key];
}

describe("bridge host config", () => {
  test("parses --bridge-host from the CLI", async () => {
    snapshotEnv();

    const config = await resolveServerConfig(parseCliArgs(["--bridge-host", "172.29.64.1"]));

    expect(config.bridgeHost).toBe("172.29.64.1");
  });

  test("reads VESLO_BRIDGE_HOST from the environment", async () => {
    snapshotEnv();
    process.env.VESLO_BRIDGE_HOST = " 172.29.64.1 ";

    const config = await resolveServerConfig(parseCliArgs([]));

    expect(config.bridgeHost).toBe("172.29.64.1");
  });

  test("CLI bridge host wins over env and file", async () => {
    snapshotEnv();

    const configDir = await mkdtemp(join(tmpdir(), "veslo-server-bridge-"));
    tempDirs.push(configDir);
    const configPath = join(configDir, "server.json");
    await writeFile(configPath, JSON.stringify({ bridgeHost: "10.0.0.1" }), "utf8");
    process.env.VESLO_BRIDGE_HOST = "172.29.64.1";

    const config = await resolveServerConfig(parseCliArgs(["--config", configPath, "--bridge-host", "172.30.0.1"]));

    expect(config.bridgeHost).toBe("172.30.0.1");
  });

  test("drops a bridge host equal to the primary host", async () => {
    snapshotEnv();

    const config = await resolveServerConfig(
      parseCliArgs(["--host", "127.0.0.1", "--bridge-host", "127.0.0.1"]),
    );

    expect(config.bridgeHost).toBeUndefined();
  });

  test("leaves bridge host unset by default", async () => {
    snapshotEnv();

    const config = await resolveServerConfig(parseCliArgs([]));

    expect(config.bridgeHost).toBeUndefined();
  });
});
