import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configIncludesSoulInstruction,
  readOpencodeConfig,
  SOUL_INSTRUCTIONS,
  SOUL_MANIFEST_PATH,
  soulMaterializationApprovalPaths,
} from "../soul-runtime.js";

async function tempWorkspace(label: string) {
  return await mkdtemp(join(tmpdir(), `veslo-soul-runtime-${label}-`));
}

describe("soul runtime owner", () => {
  test("owns the materialization approval paths for the current Soul runtime contract", async () => {
    const workspaceRoot = await tempWorkspace("approval-paths");
    try {
      const paths = soulMaterializationApprovalPaths(workspaceRoot);

      expect(paths).toEqual([
        join(workspaceRoot, "opencode.jsonc"),
        ...SOUL_INSTRUCTIONS.map((relativePath) => join(workspaceRoot, relativePath)),
        join(workspaceRoot, SOUL_MANIFEST_PATH),
      ]);
      expect(new Set(paths).size).toBe(paths.length);
      expect(paths).not.toContain(join(workspaceRoot, ".opencode/soul.md"));
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("detects current Soul instruction config without matching legacy or unrelated paths", () => {
    for (const relativePath of SOUL_INSTRUCTIONS) {
      expect(configIncludesSoulInstruction({ instructions: [relativePath] })).toBe(true);
      expect(configIncludesSoulInstruction({ instructions: `Load ${relativePath} before answering.` })).toBe(true);
    }

    expect(configIncludesSoulInstruction({ instructions: [".opencode/soul.md"] })).toBe(false);
    expect(configIncludesSoulInstruction({ instructions: [".opencode/not-soul.md"] })).toBe(false);
    expect(configIncludesSoulInstruction({ instructions: 123 })).toBe(false);
  });

  test("reads OpenCode config for current Soul materialization checks", async () => {
    const workspaceRoot = await tempWorkspace("config");
    try {
      await writeFile(
        join(workspaceRoot, "opencode.jsonc"),
        JSON.stringify({ instructions: [SOUL_INSTRUCTIONS[2]], model: "test-model" }, null, 2),
        "utf8",
      );

      const config = await readOpencodeConfig(workspaceRoot);

      expect(configIncludesSoulInstruction(config)).toBe(true);
      expect(config).toMatchObject({ model: "test-model" });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
