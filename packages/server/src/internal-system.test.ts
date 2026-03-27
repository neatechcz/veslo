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
      expect(manifest).toContain('"version": "2026-03-27.1"');
      expect(manifest).toContain('"schemaVersion": 1');
      expect(manifest).toContain('"plugins"');
      expect(manifest).toContain("veslo-delegate.js");
      expect(manifest).toContain('"routingBlockVersion": 3');

      // AGENTS.md with Veslo instructions at workspace root
      const agentsMd = await readFile(join(workspaceRoot, "AGENTS.md"), "utf8");
      expect(agentsMd).toContain("VESLO_INSTRUCTIONS_START");
      expect(agentsMd).toContain("VESLO_INSTRUCTIONS_END");
      expect(agentsMd).toContain("Introduce yourself as Veslo");
      expect(agentsMd).toContain("Skills");

      // veslo.md should have both managed blocks
      expect(vesloAgent).toContain("VESLO_AGENT_INSTRUCTIONS_START");
      expect(vesloAgent).toContain("VESLO_AGENT_INSTRUCTIONS_END");
      expect(vesloAgent).toContain("Task Mode Behavior");
      expect(vesloAgent).toContain("Progressive disclosure");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("is idempotent and restores managed artifacts when modified", async () => {
    const workspaceRoot = await createWorkspaceRoot("idempotent");

    try {
      // Pre-populate veslo.md (simulates Rust seed_veslo_agent)
      await mkdir(join(workspaceRoot, ".opencode", "agents"), { recursive: true });
      await writeFile(
        join(workspaceRoot, ".opencode", "agents", "veslo.md"),
        "---\ndescription: Veslo default agent (desktop-first, safe, self-referential)\nmode: primary\ntemperature: 0.2\n---\n\nYou are Veslo.\n",
        "utf8",
      );

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

  test("preserves user content in veslo.md and AGENTS.md around managed blocks", async () => {
    const workspaceRoot = await createWorkspaceRoot("user-content");

    try {
      // Pre-populate veslo.md with user content
      await mkdir(join(workspaceRoot, ".opencode", "agents"), { recursive: true });
      await writeFile(
        join(workspaceRoot, ".opencode", "agents", "veslo.md"),
        `---
description: Veslo default agent
mode: primary
---

You are Veslo. Custom user instructions here.
`,
        "utf8",
      );

      // Pre-populate AGENTS.md with user content
      await writeFile(
        join(workspaceRoot, "AGENTS.md"),
        `# My Project Guidelines

Some custom rules here.
`,
        "utf8",
      );

      await provisionWorkspaceInternalSystem(workspaceRoot);

      const vesloAgent = await readFile(join(workspaceRoot, ".opencode", "agents", "veslo.md"), "utf8");
      expect(vesloAgent).toContain("Custom user instructions here");
      expect(vesloAgent).toContain("VESLO_INTERNAL_ROUTING_START");
      expect(vesloAgent).toContain("VESLO_AGENT_INSTRUCTIONS_START");

      const agentsMd = await readFile(join(workspaceRoot, "AGENTS.md"), "utf8");
      expect(agentsMd).toContain("My Project Guidelines");
      expect(agentsMd).toContain("Some custom rules here");
      expect(agentsMd).toContain("VESLO_INSTRUCTIONS_START");

      // Second provision should be idempotent
      const second = await provisionWorkspaceInternalSystem(workspaceRoot);
      const vesloAgent2 = await readFile(join(workspaceRoot, ".opencode", "agents", "veslo.md"), "utf8");
      const agentsMd2 = await readFile(join(workspaceRoot, "AGENTS.md"), "utf8");
      expect(vesloAgent2).toBe(vesloAgent);
      expect(agentsMd2).toBe(agentsMd);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("skips veslo.md managed blocks when file does not exist (Rust creates it)", async () => {
    const workspaceRoot = await createWorkspaceRoot("no-veslo-md");

    try {
      // No veslo.md — TS provision should NOT create it (that's Rust's job)
      await provisionWorkspaceInternalSystem(workspaceRoot);

      const vesloMdPath = join(workspaceRoot, ".opencode", "agents", "veslo.md");
      const fileExists = await Bun.file(vesloMdPath).exists();
      // veslo.md should not be created by TS — only internal subagents are written
      expect(fileExists).toBe(false);

      // But internal subagents should exist
      const docxAgent = await readFile(
        join(workspaceRoot, ".opencode", "agents", "veslo-internal-docx.md"),
        "utf8",
      );
      expect(docxAgent).toContain("Veslo internal DOCX execution agent");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("works with full Rust-seeded veslo.md content", async () => {
    const workspaceRoot = await createWorkspaceRoot("rust-seeded");

    try {
      // Simulate full Rust seed_veslo_agent content
      await mkdir(join(workspaceRoot, ".opencode", "agents"), { recursive: true });
      await writeFile(
        join(workspaceRoot, ".opencode", "agents", "veslo.md"),
        `---
description: Veslo default agent (desktop-first, safe, self-referential)
mode: primary
temperature: 0.2
---

You are Veslo.

When the user refers to "you", they mean the Veslo app and the current workspace.

Your job:
- Help the user work with files safely and efficiently.
- Automate repeatable work.
- Keep behavior portable and reproducible.

Reconstruction-first
- Do not assume prior setup or context.
- If required information is missing, ask one targeted question.
- After the user provides it, store it and continue.

Verification-first
- After making changes, verify the result works correctly.
- If something fails, explain what happened and suggest a fix.
`,
        "utf8",
      );

      await provisionWorkspaceInternalSystem(workspaceRoot);

      const vesloAgent = await readFile(join(workspaceRoot, ".opencode", "agents", "veslo.md"), "utf8");

      // Rust base content preserved
      expect(vesloAgent).toContain("You are Veslo");
      expect(vesloAgent).toContain("Reconstruction-first");
      expect(vesloAgent).toContain("desktop-first");

      // Managed blocks added by TS
      expect(vesloAgent).toContain("VESLO_INTERNAL_ROUTING_START");
      expect(vesloAgent).toContain("VESLO_AGENT_INSTRUCTIONS_START");
      expect(vesloAgent).toContain("Task Mode Behavior");
      expect(vesloAgent).toContain("delegate");

      // Idempotent
      const second = await provisionWorkspaceInternalSystem(workspaceRoot);
      expect(second.status).toBe("unchanged");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
