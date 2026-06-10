import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { parseCliArgs, resolveServerConfig } from "../config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("workspace id config", () => {
  test("cli workspace ids are paired with matching workspace paths", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "veslo-server-workspace-id-"));
    tempDirs.push(configDir);
    const configPath = join(configDir, "server.json");
    const workspacePath = join(configDir, "workspace-a");

    await writeFile(configPath, "{}\n", "utf8");

    const config = await resolveServerConfig(parseCliArgs([
      "--config",
      configPath,
      "--workspace",
      workspacePath,
      "--workspace-id",
      "app-workspace-a",
    ]));

    expect(config.workspaces).toHaveLength(1);
    expect(config.workspaces[0].id).toBe("app-workspace-a");
    expect(config.workspaces[0].path).toBe(workspacePath);
  });

  test("cli workspace id attaches to the most recent workspace without an id", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "veslo-server-workspace-id-"));
    tempDirs.push(configDir);
    const configPath = join(configDir, "server.json");
    const scratchPath = join(configDir, "scratch");
    const realWorkspacePath = join(configDir, "workspace-real");

    await writeFile(configPath, "{}\n", "utf8");

    const config = await resolveServerConfig(parseCliArgs([
      "--config",
      configPath,
      "--workspace",
      scratchPath,
      "--workspace",
      realWorkspacePath,
      "--workspace-id",
      "app-workspace-real",
    ]));

    expect(config.workspaces).toHaveLength(2);
    expect(config.workspaces[0].path).toBe(scratchPath);
    expect(config.workspaces[0].id).not.toBe("app-workspace-real");
    expect(config.workspaces[1].path).toBe(realWorkspacePath);
    expect(config.workspaces[1].id).toBe("app-workspace-real");
  });

  test("file workspace ids override generated path ids", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "veslo-server-workspace-id-"));
    tempDirs.push(configDir);
    const configPath = join(configDir, "server.json");

    await writeFile(
      configPath,
      `${JSON.stringify({
        workspaces: [{ id: "file-workspace-a", path: "workspace-a" }],
      })}\n`,
      "utf8",
    );

    const config = await resolveServerConfig(parseCliArgs(["--config", configPath]));

    expect(config.workspaces).toHaveLength(1);
    expect(config.workspaces[0].id).toBe("file-workspace-a");
    expect(config.workspaces[0].path).toBe(join(configDir, "workspace-a"));
  });

  test("cli workspaces are authorized even when the config file has stale authorized roots", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "veslo-server-workspace-id-"));
    tempDirs.push(configDir);
    const configPath = join(configDir, "server.json");
    const staleWorkspacePath = join(configDir, "stale-workspace");
    const runtimeWorkspacePath = join(configDir, "runtime-private-chat");

    await writeFile(
      configPath,
      `${JSON.stringify({
        authorizedRoots: [staleWorkspacePath],
      })}\n`,
      "utf8",
    );

    const config = await resolveServerConfig(parseCliArgs([
      "--config",
      configPath,
      "--workspace",
      runtimeWorkspacePath,
      "--workspace-id",
      "runtime-private-chat-id",
    ]));

    expect(config.workspaces).toHaveLength(1);
    expect(config.workspaces[0].id).toBe("runtime-private-chat-id");
    expect(config.authorizedRoots).toContain(resolve(staleWorkspacePath));
    expect(config.authorizedRoots).toContain(resolve(runtimeWorkspacePath));
  });

  test("file authorized roots still constrain file-configured workspaces", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "veslo-server-workspace-id-"));
    tempDirs.push(configDir);
    const configPath = join(configDir, "server.json");
    const allowedWorkspacePath = join(configDir, "allowed-workspace");
    const listedButUnauthorizedPath = join(configDir, "listed-but-unauthorized");

    await writeFile(
      configPath,
      `${JSON.stringify({
        workspaces: [
          { id: "allowed-workspace-id", path: allowedWorkspacePath },
          { id: "listed-but-unauthorized-id", path: listedButUnauthorizedPath },
        ],
        authorizedRoots: [allowedWorkspacePath],
      })}\n`,
      "utf8",
    );

    const config = await resolveServerConfig(parseCliArgs(["--config", configPath]));

    expect(config.workspaces).toHaveLength(2);
    expect(config.authorizedRoots).toContain(resolve(allowedWorkspacePath));
    expect(config.authorizedRoots).not.toContain(resolve(listedButUnauthorizedPath));
  });
});
