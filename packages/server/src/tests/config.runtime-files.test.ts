import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { parseCliArgs, resolveServerConfig } from "../config.js";

const ENV_KEYS = [
  "VESLO_HOST_TOKEN",
  "VESLO_ORCHESTRATOR_LIFECYCLE_TOKEN",
  "VESLO_RUNTIME_DESCRIPTOR_PATH",
  "VESLO_RUNTIME_FILE",
  "VESLO_SECRETS_FILE",
  "VESLO_TOKEN",
] as const;

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
  for (const key of ENV_KEYS) {
    snapshot.set(key, process.env[key]);
    delete process.env[key];
  }
}

describe("runtime and secrets file config", () => {
  test("loads desktop secrets file before env and config-file tokens", async () => {
    snapshotEnv();

    const configDir = await mkdtemp(join(tmpdir(), "veslo-server-runtime-files-"));
    tempDirs.push(configDir);
    const configPath = join(configDir, "server.json");
    const secretsPath = join(configDir, "secrets.json");
    const runtimePath = join(configDir, "runtime.json");

    await writeFile(
      configPath,
      JSON.stringify({
        token: "file-client",
        hostToken: "file-host",
        orchestratorLifecycleToken: "file-lifecycle",
        runtimeDescriptorPath: join(configDir, "file-runtime.json"),
      }),
      "utf8",
    );
    await writeFile(
      secretsPath,
      JSON.stringify({
        clientToken: " secret-client ",
        hostToken: " secret-host ",
        orchestratorLifecycleToken: " secret-lifecycle ",
      }),
      "utf8",
    );

    process.env.VESLO_TOKEN = "env-client";
    process.env.VESLO_HOST_TOKEN = "env-host";
    process.env.VESLO_ORCHESTRATOR_LIFECYCLE_TOKEN = "env-lifecycle";
    process.env.VESLO_RUNTIME_FILE = runtimePath;
    process.env.VESLO_RUNTIME_DESCRIPTOR_PATH = join(configDir, "legacy-runtime.json");
    process.env.VESLO_SECRETS_FILE = secretsPath;

    const config = await resolveServerConfig(parseCliArgs(["--config", configPath]));

    expect(config.token).toBe("secret-client");
    expect(config.hostToken).toBe("secret-host");
    expect(config.orchestratorLifecycleToken).toBe("secret-lifecycle");
    expect(config.runtimeDescriptorPath).toBe(runtimePath);
    expect(config.tokenSource).toBe("secrets-file");
    expect(config.hostTokenSource).toBe("secrets-file");
  });

  test("keeps manual CLI token compatibility above secrets files", async () => {
    snapshotEnv();

    const configDir = await mkdtemp(join(tmpdir(), "veslo-server-runtime-files-"));
    tempDirs.push(configDir);
    const secretsPath = join(configDir, "secrets.json");
    await writeFile(
      secretsPath,
      JSON.stringify({
        clientToken: "secret-client",
        hostToken: "secret-host",
        orchestratorLifecycleToken: "secret-lifecycle",
      }),
      "utf8",
    );
    process.env.VESLO_SECRETS_FILE = secretsPath;

    const config = await resolveServerConfig(
      parseCliArgs([
        "--token",
        "cli-client",
        "--host-token",
        "cli-host",
        "--orchestrator-lifecycle-token",
        "cli-lifecycle",
      ]),
    );

    expect(config.token).toBe("cli-client");
    expect(config.hostToken).toBe("cli-host");
    expect(config.orchestratorLifecycleToken).toBe("cli-lifecycle");
    expect(config.tokenSource).toBe("cli");
    expect(config.hostTokenSource).toBe("cli");
  });

  test("fails closed when configured secrets file cannot be read", async () => {
    snapshotEnv();

    const configDir = await mkdtemp(join(tmpdir(), "veslo-server-runtime-files-"));
    tempDirs.push(configDir);
    process.env.VESLO_TOKEN = "env-client";
    process.env.VESLO_HOST_TOKEN = "env-host";
    process.env.VESLO_SECRETS_FILE = join(configDir, "missing-secrets.json");

    await expect(resolveServerConfig(parseCliArgs([]))).rejects.toThrow(/Failed to read VESLO_SECRETS_FILE/);
  });

  test("fails closed when configured secrets file is invalid", async () => {
    snapshotEnv();

    const configDir = await mkdtemp(join(tmpdir(), "veslo-server-runtime-files-"));
    tempDirs.push(configDir);
    const secretsPath = join(configDir, "secrets.json");
    await writeFile(secretsPath, "{not json", "utf8");
    process.env.VESLO_TOKEN = "env-client";
    process.env.VESLO_HOST_TOKEN = "env-host";
    process.env.VESLO_SECRETS_FILE = secretsPath;

    await expect(resolveServerConfig(parseCliArgs([]))).rejects.toThrow(/Failed to parse VESLO_SECRETS_FILE/);
  });

  test("fails closed when configured secrets file is missing required tokens", async () => {
    snapshotEnv();

    const configDir = await mkdtemp(join(tmpdir(), "veslo-server-runtime-files-"));
    tempDirs.push(configDir);
    const secretsPath = join(configDir, "secrets.json");
    await writeFile(secretsPath, JSON.stringify({ clientToken: "secret-client" }), "utf8");
    process.env.VESLO_TOKEN = "env-client";
    process.env.VESLO_HOST_TOKEN = "env-host";
    process.env.VESLO_SECRETS_FILE = secretsPath;

    await expect(resolveServerConfig(parseCliArgs([]))).rejects.toThrow(/missing required hostToken/);
  });
});
