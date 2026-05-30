import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { parseCliArgs, resolveServerConfig } from "./config.js";

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
});
