import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  PROJECT_RUNTIME_DIRECTORIES,
  syncWorkspaceOpencodeConfigToConfigDir,
} from "../workspace-opencode-config-mirror.js";

const roots: string[] = [];

async function fixture() {
  const root = join(process.cwd(), `.tmp-workspace-config-mirror-${crypto.randomUUID()}`);
  roots.push(root);
  const workspace = join(root, "workspace");
  const configDir = join(root, "config");
  await mkdir(workspace, { recursive: true });
  return { workspace, configDir };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("workspace OpenCode config mirror", () => {
  test("projects allowed project runtime directories without copying raw skills", async () => {
    const { workspace, configDir } = await fixture();
    await writeFile(
      join(workspace, "opencode.jsonc"),
      JSON.stringify({ mcp: { local: { type: "local" } }, skills: { paths: [".opencode/skills"] } }),
      "utf8",
    );
    await writeFile(join(workspace, "AGENTS.md"), "workspace instructions\n", "utf8");
    for (const name of PROJECT_RUNTIME_DIRECTORIES) {
      const source = join(workspace, ".opencode", name);
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "marker.txt"), `${name}\n`, "utf8");
    }
    await mkdir(join(workspace, ".opencode", "skills", "raw-skill"), { recursive: true });
    await writeFile(join(workspace, ".opencode", "skills", "raw-skill", "SKILL.md"), "raw\n", "utf8");

    await syncWorkspaceOpencodeConfigToConfigDir(workspace, configDir);

    const config = await readFile(join(configDir, "opencode.jsonc"), "utf8");
    expect(config).toContain('"mcp"');
    expect(config).not.toContain('"skills"');
    expect(await readFile(join(configDir, "AGENTS.md"), "utf8")).toBe("workspace instructions\n");
    for (const name of PROJECT_RUNTIME_DIRECTORIES) {
      expect(await readFile(join(configDir, name, "marker.txt"), "utf8")).toBe(`${name}\n`);
    }
    expect(await Bun.file(join(configDir, "skills", "raw-skill", "SKILL.md")).exists()).toBe(false);
  });

  test("removes stale projected runtime files when the workspace removes them", async () => {
    const { workspace, configDir } = await fixture();
    const source = join(workspace, ".opencode", "commands");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "marker.txt"), "first\n", "utf8");
    await syncWorkspaceOpencodeConfigToConfigDir(workspace, configDir);
    await rm(source, { recursive: true, force: true });

    await syncWorkspaceOpencodeConfigToConfigDir(workspace, configDir);

    expect(await Bun.file(join(configDir, "commands", "marker.txt")).exists()).toBe(false);
  });
});
