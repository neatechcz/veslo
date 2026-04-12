import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { parseCliArgs, resolveServerConfig } from "./config.js";

const ENV_KEYS = ["VESLO_DEN_API_BASE"] as const;
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

describe("den api base config", () => {
  test("resolveServerConfig normalizes env VESLO_DEN_API_BASE", async () => {
    for (const key of ENV_KEYS) snapshot.set(key, process.env[key]);

    process.env.VESLO_DEN_API_BASE = "https://den.example///";

    const config = await resolveServerConfig(parseCliArgs([]));

    expect(config.denApiBase).toBe("https://den.example");
  });

  test("resolveServerConfig prefers env den api base over config file", async () => {
    for (const key of ENV_KEYS) snapshot.set(key, process.env[key]);

    const configDir = await mkdtemp(join(tmpdir(), "veslo-server-config-"));
    tempDirs.push(configDir);
    const configPath = join(configDir, "server.json");

    await writeFile(configPath, JSON.stringify({ denApiBase: "https://file-den.example/" }), "utf8");
    process.env.VESLO_DEN_API_BASE = "https://env-den.example/";

    const config = await resolveServerConfig(parseCliArgs(["--config", configPath]));

    expect(config.denApiBase).toBe("https://env-den.example");
  });

  test("resolveServerConfig reads den api base from config file when env is unset", async () => {
    for (const key of ENV_KEYS) snapshot.set(key, process.env[key]);

    const configDir = await mkdtemp(join(tmpdir(), "veslo-server-config-"));
    tempDirs.push(configDir);
    const configPath = join(configDir, "server.json");

    await writeFile(configPath, JSON.stringify({ denApiBase: "https://file-only-den.example/" }), "utf8");
    delete process.env.VESLO_DEN_API_BASE;

    const config = await resolveServerConfig(parseCliArgs(["--config", configPath]));

    expect(config.denApiBase).toBe("https://file-only-den.example");
  });
});
