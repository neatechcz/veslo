import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { migrateLegacyWorkspaceConfigDir } from "../workspace-runtime-migration.js";

const tempRoots: string[] = [];

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `veslo-orchestrator-${label}-`));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("migrateLegacyWorkspaceConfigDir", () => {
  test("copies the first existing legacy config dir to the new server-owned id", async () => {
    const dataDir = await tempRoot("config-migrate");
    const legacyDir = join(dataDir, "opencode-config", "app-ws");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, "opencode.json"), JSON.stringify({ model: "test-model" }));

    const result = await migrateLegacyWorkspaceConfigDir({
      dataDir,
      workspaceId: "server-ws",
      legacyWorkspaceIds: ["missing-ws", "app-ws"],
    });

    expect(result).toMatchObject({
      migrated: true,
      sourceWorkspaceId: "app-ws",
      reason: "migrated",
    });
    const copied = await readFile(join(dataDir, "opencode-config", "server-ws", "opencode.json"), "utf8");
    expect(JSON.parse(copied)).toEqual({ model: "test-model" });
  });

  test("does not overwrite an existing server-owned config dir", async () => {
    const dataDir = await tempRoot("config-target-exists");
    const legacyDir = join(dataDir, "opencode-config", "app-ws");
    const targetDir = join(dataDir, "opencode-config", "server-ws");
    await mkdir(legacyDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(legacyDir, "opencode.json"), JSON.stringify({ model: "legacy" }));
    await writeFile(join(targetDir, "opencode.json"), JSON.stringify({ model: "server" }));

    const result = await migrateLegacyWorkspaceConfigDir({
      dataDir,
      workspaceId: "server-ws",
      legacyWorkspaceIds: ["app-ws"],
    });

    expect(result).toMatchObject({
      migrated: false,
      sourceWorkspaceId: null,
      reason: "target_exists",
    });
    const current = await readFile(join(targetDir, "opencode.json"), "utf8");
    expect(JSON.parse(current)).toEqual({ model: "server" });
  });
});
