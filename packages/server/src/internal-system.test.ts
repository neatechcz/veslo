import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionWorkspaceInternalSystem } from "./internal-system.js";

async function createWorkspaceRoot(label: string) {
  return await mkdtemp(join(tmpdir(), `veslo-internal-system-${label}-`));
}

describe("provisionWorkspaceInternalSystem", () => {
  test("writes internal packs, hidden agents, managed routing block, and manifest", async () => {
    const workspaceRoot = await createWorkspaceRoot("bootstrap");

    try {
      await mkdir(join(workspaceRoot, ".opencode", "agents"), { recursive: true });
      await writeFile(
        join(workspaceRoot, ".opencode", "agents", "veslo.md"),
        `---
description: Veslo default agent
mode: primary
---

You are Veslo.
`,
        "utf8",
      );

      const result = await provisionWorkspaceInternalSystem(workspaceRoot);
      expect(result.status).toBe("updated");
      expect(result.written).toBeGreaterThan(0);

      const docxSkill = await readFile(
        join(workspaceRoot, ".opencode", "veslo", "internal", "docx", "SKILL.md"),
        "utf8",
      );
      expect(docxSkill).toContain("name: docx");
      expect(docxSkill).toContain('veslo_internal_pack: true');
      expect(docxSkill).not.toContain("license: Proprietary");

      const subagent = await readFile(
        join(workspaceRoot, ".opencode", "agents", "veslo-internal-docx.md"),
        "utf8",
      );
      expect(subagent).toContain("mode: subagent");
      expect(subagent).toContain("hidden: true");

      const vesloAgent = await readFile(join(workspaceRoot, ".opencode", "agents", "veslo.md"), "utf8");
      expect(vesloAgent).toContain("VESLO_INTERNAL_ROUTING_START");
      expect(vesloAgent).toContain("delegate");

      const plugin = await readFile(
        join(workspaceRoot, ".opencode", "plugins", "veslo-delegate.js"),
        "utf8",
      );
      expect(plugin).toContain('import { tool } from "@opencode-ai/plugin"');
      expect(plugin).toContain("veslo-internal-xlsx");
      expect(plugin).toContain("veslo-internal-docx");
      expect(plugin).toContain("export default async");
      expect(plugin).toContain('"chat.message"');
      expect(plugin).toContain("VESLO_ROUTER_FORCE_DELEGATE");

      const manifest = await readFile(
        join(workspaceRoot, ".opencode", "veslo", "internal", "manifest.json"),
        "utf8",
      );
      expect(manifest).toContain('"version": "2026-03-18.2"');
      expect(manifest).toContain('"schemaVersion": 1');
      expect(manifest).toContain('"plugins"');
      expect(manifest).toContain("veslo-delegate.js");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("is idempotent and restores managed artifacts when modified", async () => {
    const workspaceRoot = await createWorkspaceRoot("idempotent");

    try {
      await provisionWorkspaceInternalSystem(workspaceRoot);
      const second = await provisionWorkspaceInternalSystem(workspaceRoot);
      expect(second.status).toBe("unchanged");
      expect(second.written).toBe(0);
      expect(second.unchanged).toBeGreaterThan(0);

      const agentPath = join(workspaceRoot, ".opencode", "agents", "veslo-internal-docx.md");
      await writeFile(agentPath, "tampered", "utf8");

      const third = await provisionWorkspaceInternalSystem(workspaceRoot);
      expect(third.status).toBe("updated");

      const restored = await readFile(agentPath, "utf8");
      expect(restored).toContain("Veslo internal DOCX execution agent");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
