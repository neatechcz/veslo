import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readJsoncFile, updateJsoncTopLevel } from "./jsonc.js";

describe("readJsoncFile", () => {
  test("ignores trailing NUL padding after valid JSONC", async () => {
    const dir = await mkdtemp(join(tmpdir(), "veslo-jsonc-"));
    const path = join(dir, "opencode.jsonc");

    try {
      await writeFile(path, '{ "mcp": {} }\0\0\n', "utf8");

      const result = await readJsoncFile<Record<string, unknown>>(path, {});

      expect(result.data).toEqual({ mcp: {} });
      expect(result.raw.includes("\0")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("updateJsoncTopLevel", () => {
  test("removes trailing NUL padding when rewriting config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "veslo-jsonc-"));
    const path = join(dir, "opencode.jsonc");

    try {
      await writeFile(path, '{ "mcp": {} }\0\0\n', "utf8");

      await updateJsoncTopLevel(path, { plugin: ["opencode-scheduler"] });

      const content = await readFile(path, "utf8");
      expect(content.includes("\0")).toBe(false);
      expect(content).toContain('"plugin"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
