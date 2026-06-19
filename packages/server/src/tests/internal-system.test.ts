import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  provisionWorkspaceInternalSystem,
  resolveVesloAppDataDir,
} from "../internal-system.js";

async function createWorkspaceRoot(label: string) {
  return await mkdtemp(join(tmpdir(), `veslo-internal-system-${label}-`));
}

async function canCreateDirectorySymlink(): Promise<boolean> {
  const root = await createWorkspaceRoot("symlink-probe");
  try {
    const target = join(root, "target");
    const link = join(root, "link");
    await mkdir(target);
    await symlink(target, link, "dir");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function installFakeOpenCodePluginModule(pluginDir: string) {
  const moduleRoot = join(pluginDir, "node_modules", "@opencode-ai", "plugin");
  await mkdir(moduleRoot, { recursive: true });
  await writeFile(join(moduleRoot, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  await writeFile(
    join(moduleRoot, "index.js"),
    `
export function tool(definition) {
  return definition;
}

function schema() {
  return {
    optional() { return this; },
    describe() { return this; },
  };
}

tool.schema = {
  any: schema,
  boolean: schema,
  string: schema,
  enum: () => schema(),
};
`,
    "utf8",
  );
}

async function loadGeneratedAutomationTools(workspaceRoot: string) {
  await provisionWorkspaceInternalSystem(workspaceRoot);
  const pluginDir = join(workspaceRoot, ".opencode", "plugins");
  await writeFile(join(pluginDir, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  await installFakeOpenCodePluginModule(pluginDir);

  const pluginUrl = pathToFileURL(join(pluginDir, "veslo-automations.js")).href;
  const module = await import(`${pluginUrl}?test=${Date.now()}-${Math.random()}`);
  return await module.default({
    client: {
      session: {
        get: async () => ({ directory: workspaceRoot }),
      },
    },
  });
}

const LEGACY_INTERNAL_AGENT_FILES = [
  "veslo-internal-docx.md",
  "veslo-internal-pdf.md",
  "veslo-internal-pptx.md",
  "veslo-internal-xlsx.md",
  "veslo-internal-skill-creator.md",
  "veslo-internal-research.md",
] as const;

async function expectMissing(path: string) {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function expectNoInternalDelegationRuntime(workspaceRoot: string) {
  await expectMissing(join(workspaceRoot, ".opencode", "veslo", "internal"));
  await expectMissing(join(workspaceRoot, ".opencode", "plugins", "veslo-delegate.js"));
  for (const filename of LEGACY_INTERNAL_AGENT_FILES) {
    await expectMissing(join(workspaceRoot, ".opencode", "agents", filename));
  }
}

function managedAgentBlock(content: string) {
  const start = content.indexOf("<!-- VESLO_AGENT_INSTRUCTIONS_START -->");
  const end = content.indexOf("<!-- VESLO_AGENT_INSTRUCTIONS_END -->", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return content.slice(start, end);
}

function expectNoRuntimeRoutingLanguage(content: string) {
  const block = managedAgentBlock(content);
  expect(block).not.toMatch(/\bdelegat(?:e|ed|es|ing|ion)\b/i);
  expect(block).not.toMatch(/\bsub-?agents?\b/i);
  expect(block).not.toMatch(/\bchild[- ]sessions?\b/i);
  expect(block).not.toMatch(/\binternal agents?\b/i);
  expect(block).not.toContain("veslo-internal-");
  expect(block).not.toContain(".opencode/veslo/internal");
}

function managedLegacyAgentDocument(label: string) {
  return `---
description: Veslo internal ${label} execution agent
mode: subagent
hidden: true
---

You are a hidden Veslo internal execution agent.
`;
}

describe("provisionWorkspaceInternalSystem", () => {
  test("resolves platform app data directory", () => {
    const resolved = resolveVesloAppDataDir();
    expect(resolved).toBeTruthy();
    expect(resolved).toContain("com.neatech.veslo");
  });

  test("does not provision internal delegation runtime", async () => {
    const workspaceRoot = await createWorkspaceRoot("no-internal-delegation");

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

      await expectNoInternalDelegationRuntime(workspaceRoot);

      const vesloAgent = await readFile(join(workspaceRoot, ".opencode", "agents", "veslo.md"), "utf8");
      expect(vesloAgent).not.toContain("VESLO_INTERNAL_ROUTING_START");
      expect(vesloAgent).not.toContain("VESLO_INTERNAL_ROUTING_END");
      expectNoRuntimeRoutingLanguage(vesloAgent);

      // AGENTS.md with Veslo instructions at workspace root
      const agentsMd = await readFile(join(workspaceRoot, "AGENTS.md"), "utf8");
      expect(agentsMd).toContain("VESLO_INSTRUCTIONS_START");
      expect(agentsMd).toContain("VESLO_INSTRUCTIONS_END");
      expect(agentsMd).toContain("Introduce yourself as Veslo");
      expect(agentsMd).toContain("Skills");

      // veslo.md should have both managed blocks
      expect(vesloAgent).toContain("VESLO_AGENT_INSTRUCTIONS_START");
      expect(vesloAgent).toContain("VESLO_AGENT_INSTRUCTIONS_END");
      expect(vesloAgent).toContain("Response Style");
      expect(vesloAgent).toContain("Output Hygiene");
      expect(vesloAgent).toContain("Do not print raw JSON");
      expect(vesloAgent).toContain("Progressive disclosure");
      expect(vesloAgent).toContain("Document Download Safety");
      expect(vesloAgent).toContain("If a fetch tool already returned bytes for a file URL");
      expect(vesloAgent).toContain("materialized Soul files are read-only runtime output owned by Veslo");
      expect(vesloAgent).toContain("save the memory through the Soul memory API or ask the user to save it in Veslo");
      expect(vesloAgent).not.toContain("persist the information to `.opencode/soul-user.md`");
      expect(vesloAgent).not.toContain("Read the file first, append new entries, then write it back");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("generated automation plugin creates through directory-matched workspace using sanitized state", async () => {
    const workspaceRoot = await createWorkspaceRoot("automation-plugin-runtime");
    const statePath = join(workspaceRoot, "veslo-server-plugin-state.json");
    const previousStatePath = process.env.VESLO_SERVER_STATE_PATH;
    const previousFetch = globalThis.fetch;
    const calls: Array<{ path: string; method: string; body: unknown; authorization: string | null }> = [];

    try {
      await writeFile(
        statePath,
        JSON.stringify({ baseUrl: "http://veslo.local", clientToken: "client-token" }, null, 2),
        "utf8",
      );
      const statePayload = await readFile(statePath, "utf8");
      expect(statePayload).not.toContain("hostToken");
      expect(statePayload).not.toContain("host-token");
      process.env.VESLO_SERVER_STATE_PATH = statePath;

      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
        const headers = new Headers(init?.headers);
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({
          path: url.pathname,
          method: init?.method ?? "GET",
          body,
          authorization: headers.get("Authorization"),
        });

        if (url.pathname === "/workspaces") {
          return Response.json({
            activeId: "ws_other",
            items: [
              { id: "ws_other", path: join(workspaceRoot, "other"), opencode: { directory: join(workspaceRoot, "other") } },
              { id: "ws_matched", path: workspaceRoot, opencode: { directory: workspaceRoot } },
            ],
          });
        }
        if (url.pathname === "/workspace/ws_matched/automations" && init?.method === "POST") {
          return Response.json({
            automation: { id: "auto_runtime", status: "active", nextRunAt: "2026-06-07T07:00:00.000Z" },
          });
        }
        return Response.json({ error: "unexpected" }, { status: 404 });
      }) as typeof fetch;

      const plugin = await loadGeneratedAutomationTools(workspaceRoot);
      const createTool = plugin.tool.veslo_create_automation;

      const timezoneCapableSchedules = [
        { name: "Daily review", schedule: { kind: "daily", hour: 9, minute: 0 } },
        { name: "Weekly review", schedule: { kind: "weekly", weekday: 1, hour: 9, minute: 0 } },
        { name: "Cron review", schedule: { kind: "cron", expression: "0 9 * * 1-5" } },
        { name: "One-shot review", schedule: { kind: "oneShot", runAt: "2026-06-07T07:00:00.000Z" } },
      ];

      for (const item of timezoneCapableSchedules) {
        calls.length = 0;
        const result = await createTool.execute(
          {
            name: item.name,
            prompt: "Review the queue",
            schedule: item.schedule,
            timezone: "Europe/Prague",
          },
          { sessionID: "ses_runtime", directory: workspaceRoot },
        );
        expect(result).toContain("auto_runtime");

        const workspacesGet = calls.find((call) => call.path === "/workspaces" && call.method === "GET");
        const post = calls.find((call) => call.path === "/workspace/ws_matched/automations" && call.method === "POST");
        expect(workspacesGet?.authorization).toBe("Bearer client-token");
        expect(post?.authorization).toBe("Bearer client-token");
        expect(post?.body).toMatchObject({
          name: item.name,
          prompt: "Review the queue",
          schedule: { ...item.schedule, timezone: "Europe/Prague" },
          target: { preferredSessionId: "ses_runtime" },
        });
      }

      calls.length = 0;
      await createTool.execute(
        {
          name: "Interval review",
          prompt: "Review periodically",
          schedule: { kind: "interval", seconds: 3600 },
          timezone: "Europe/Prague",
        },
        { sessionID: "ses_runtime", directory: workspaceRoot },
      );

      const intervalPost = calls.find((call) => call.path === "/workspace/ws_matched/automations" && call.method === "POST");
      expect(intervalPost?.body).toMatchObject({
        schedule: { kind: "interval", seconds: 3600 },
      });
      expect((intervalPost?.body as { schedule?: { timezone?: string } } | undefined)?.schedule?.timezone).toBeUndefined();
    } finally {
      if (previousStatePath === undefined) {
        delete process.env.VESLO_SERVER_STATE_PATH;
      } else {
        process.env.VESLO_SERVER_STATE_PATH = previousStatePath;
      }
      globalThis.fetch = previousFetch;
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("cleans up Veslo-managed legacy internal delegation artifacts", async () => {
    const workspaceRoot = await createWorkspaceRoot("managed-legacy-cleanup");
    const internalRoot = join(workspaceRoot, ".opencode", "veslo", "internal");
    const agentsRoot = join(workspaceRoot, ".opencode", "agents");
    const pluginsRoot = join(workspaceRoot, ".opencode", "plugins");
    const vesloAgentPath = join(agentsRoot, "veslo.md");

    try {
      await mkdir(join(internalRoot, "docx"), { recursive: true });
      await mkdir(join(internalRoot, "pdf"), { recursive: true });
      await mkdir(join(internalRoot, "pptx"), { recursive: true });
      await mkdir(join(internalRoot, "xlsx"), { recursive: true });
      await mkdir(join(internalRoot, "skill-creator"), { recursive: true });
      await mkdir(join(internalRoot, "research"), { recursive: true });
      await mkdir(agentsRoot, { recursive: true });
      await mkdir(pluginsRoot, { recursive: true });
      await writeFile(
        join(internalRoot, "manifest.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            version: "2026-06-06.1",
            source: "openwork-snapshot",
            packs: ["docx", "pdf", "pptx", "xlsx", "skill-creator", "research"],
            agents: LEGACY_INTERNAL_AGENT_FILES.map((filename) => filename.replace(/\.md$/i, "")),
            plugins: ["veslo-delegate.js"],
            routingBlockVersion: 3,
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(join(internalRoot, "docx", "SKILL.md"), "---\nname: docx\nveslo_internal_pack: true\n---\n", "utf8");
      await writeFile(join(internalRoot, "pdf", "SKILL.md"), "---\nname: pdf\nveslo_internal_pack: true\n---\n", "utf8");
      await writeFile(join(internalRoot, "pptx", "SKILL.md"), "---\nname: pptx\nveslo_internal_pack: true\n---\n", "utf8");
      await writeFile(join(internalRoot, "xlsx", "SKILL.md"), "---\nname: xlsx\nveslo_internal_pack: true\n---\n", "utf8");
      await writeFile(join(internalRoot, "skill-creator", "SKILL.md"), "---\nname: skill-creator\nveslo_internal_pack: true\n---\n", "utf8");
      await writeFile(join(internalRoot, "research", "SKILL.md"), "---\nname: research\nveslo_internal_pack: true\n---\n", "utf8");
      for (const filename of LEGACY_INTERNAL_AGENT_FILES) {
        await writeFile(
          join(agentsRoot, filename),
          managedLegacyAgentDocument(filename.replace(/^veslo-internal-/, "").replace(/\.md$/i, "").toUpperCase()),
          "utf8",
        );
      }
      await writeFile(
        join(pluginsRoot, "veslo-delegate.js"),
        `/**
 * Veslo Delegate Plugin
 *
 * Managed by Veslo internal system (v2026-06-06.1). Do not edit manually.
 */
export default async () => ({});
`,
        "utf8",
      );
      await writeFile(
        vesloAgentPath,
        `---
description: Veslo default agent
mode: primary
---

User-authored project rule.

<!-- VESLO_INTERNAL_ROUTING_START -->
## Managed Internal Delegation (Veslo)

Document work must use the delegate tool and hidden subagents.
<!-- VESLO_INTERNAL_ROUTING_END -->

Keep this sentence too.
`,
        "utf8",
      );

      const result = await provisionWorkspaceInternalSystem(workspaceRoot);
      expect(result.status).toBe("updated");

      await expectNoInternalDelegationRuntime(workspaceRoot);

      const vesloAgent = await readFile(vesloAgentPath, "utf8");
      expect(vesloAgent).toContain("User-authored project rule.");
      expect(vesloAgent).toContain("Keep this sentence too.");
      expect(vesloAgent).not.toContain("VESLO_INTERNAL_ROUTING_START");
      expect(vesloAgent).not.toContain("Managed Internal Delegation");
      expectNoRuntimeRoutingLanguage(vesloAgent);

      const second = await provisionWorkspaceInternalSystem(workspaceRoot);
      expect(second.status).toBe("unchanged");
      expect(second.written).toBe(0);
      expect(second.unchanged).toBeGreaterThan(0);
      await expectNoInternalDelegationRuntime(workspaceRoot);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("preserves ambiguous user-owned internal-looking files without legacy manifest", async () => {
    const workspaceRoot = await createWorkspaceRoot("ambiguous-user-owned");
    const agentsRoot = join(workspaceRoot, ".opencode", "agents");
    const pluginsRoot = join(workspaceRoot, ".opencode", "plugins");
    const userDocxAgentPath = join(agentsRoot, "veslo-internal-docx.md");
    const userCustomAgentPath = join(agentsRoot, "veslo-internal-custom.md");
    const userPluginPath = join(pluginsRoot, "veslo-delegate.js");
    const userDocxAgent = `---
description: User-owned DOCX notes
mode: primary
---

This file happens to use a Veslo-like internal name, but it is user-authored.
`;
    const userCustomAgent = `---
description: User-owned custom helper
mode: primary
---

Keep this internal-looking custom agent.
`;
    const userPlugin = `// User-owned OpenCode helper with a similar filename.
export default async () => ({ name: "my-helper" });
`;

    try {
      await mkdir(agentsRoot, { recursive: true });
      await mkdir(pluginsRoot, { recursive: true });
      await writeFile(userDocxAgentPath, userDocxAgent, "utf8");
      await writeFile(userCustomAgentPath, userCustomAgent, "utf8");
      await writeFile(userPluginPath, userPlugin, "utf8");

      await provisionWorkspaceInternalSystem(workspaceRoot);

      await expectMissing(join(workspaceRoot, ".opencode", "veslo", "internal"));
      await expect(readFile(userDocxAgentPath, "utf8")).resolves.toBe(userDocxAgent);
      await expect(readFile(userCustomAgentPath, "utf8")).resolves.toBe(userCustomAgent);
      await expect(readFile(userPluginPath, "utf8")).resolves.toBe(userPlugin);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("preserves user-owned same-name files and unowned internal directories during legacy cleanup", async () => {
    const workspaceRoot = await createWorkspaceRoot("mixed-owned-preservation");
    const internalRoot = join(workspaceRoot, ".opencode", "veslo", "internal");
    const siblingInternalRoot = join(workspaceRoot, ".opencode", "veslo", "not-managed-internal");
    const agentsRoot = join(workspaceRoot, ".opencode", "agents");
    const pluginsRoot = join(workspaceRoot, ".opencode", "plugins");
    const userDocxAgentPath = join(agentsRoot, "veslo-internal-docx.md");
    const managedPdfAgentPath = join(agentsRoot, "veslo-internal-pdf.md");
    const userPluginPath = join(pluginsRoot, "veslo-delegate.js");
    const userDocxAgent = `---
description: User-owned DOCX helper
mode: primary
---

This file has the old Veslo filename but is not the hidden managed agent.
`;
    const userPlugin = `// User-owned OpenCode helper with the old Veslo plugin filename.
export default async () => ({ name: "custom-user-helper" });
`;

    try {
      await mkdir(join(internalRoot, "docx"), { recursive: true });
      await mkdir(join(siblingInternalRoot, "docx"), { recursive: true });
      await mkdir(agentsRoot, { recursive: true });
      await mkdir(pluginsRoot, { recursive: true });
      await writeFile(
        join(internalRoot, "manifest.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            source: "openwork-snapshot",
            packs: ["docx"],
            agents: ["veslo-internal-docx", "veslo-internal-pdf"],
            plugins: ["veslo-delegate.js"],
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(join(internalRoot, "docx", "SKILL.md"), "---\nname: docx\nveslo_internal_pack: true\n---\n", "utf8");
      await writeFile(
        join(siblingInternalRoot, "manifest.json"),
        JSON.stringify({ schemaVersion: 1, source: "user-owned", packs: ["docx"] }, null, 2),
        "utf8",
      );
      await writeFile(join(siblingInternalRoot, "docx", "SKILL.md"), "---\nname: user-docx\n---\n", "utf8");
      await writeFile(userDocxAgentPath, userDocxAgent, "utf8");
      await writeFile(managedPdfAgentPath, managedLegacyAgentDocument("PDF"), "utf8");
      await writeFile(userPluginPath, userPlugin, "utf8");

      const result = await provisionWorkspaceInternalSystem(workspaceRoot);
      expect(result.status).toBe("updated");

      await expectMissing(internalRoot);
      await expectMissing(managedPdfAgentPath);
      await expect(readFile(userDocxAgentPath, "utf8")).resolves.toBe(userDocxAgent);
      await expect(readFile(userPluginPath, "utf8")).resolves.toBe(userPlugin);
      await expect(readFile(join(siblingInternalRoot, "docx", "SKILL.md"), "utf8")).resolves.toContain("user-docx");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("preserves user-owned files inside a managed legacy internal root", async () => {
    const workspaceRoot = await createWorkspaceRoot("managed-root-user-content");
    const internalRoot = join(workspaceRoot, ".opencode", "veslo", "internal");
    const agentsRoot = join(workspaceRoot, ".opencode", "agents");
    const customNotesPath = join(internalRoot, "custom", "notes.md");

    try {
      await mkdir(join(internalRoot, "docx"), { recursive: true });
      await mkdir(join(internalRoot, "custom"), { recursive: true });
      await mkdir(agentsRoot, { recursive: true });
      await writeFile(
        join(internalRoot, "manifest.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            source: "openwork-snapshot",
            packs: ["docx"],
            agents: ["veslo-internal-docx"],
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(join(internalRoot, "docx", "SKILL.md"), "---\nname: docx\nveslo_internal_pack: true\n---\n", "utf8");
      await writeFile(customNotesPath, "user notes\n", "utf8");
      await writeFile(join(agentsRoot, "veslo-internal-docx.md"), managedLegacyAgentDocument("DOCX"), "utf8");

      const result = await provisionWorkspaceInternalSystem(workspaceRoot);
      expect(result.status).toBe("updated");

      await expectMissing(join(internalRoot, "manifest.json"));
      await expectMissing(join(internalRoot, "docx"));
      await expectMissing(join(agentsRoot, "veslo-internal-docx.md"));
      await expect(readFile(customNotesPath, "utf8")).resolves.toBe("user notes\n");

      const second = await provisionWorkspaceInternalSystem(workspaceRoot);
      expect(second.status).toBe("unchanged");
      await expect(readFile(customNotesPath, "utf8")).resolves.toBe("user notes\n");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("preserves ambiguous .opencode/veslo/internal directory without managed ownership proof", async () => {
    const workspaceRoot = await createWorkspaceRoot("unowned-internal-dir");
    const internalRoot = join(workspaceRoot, ".opencode", "veslo", "internal");

    try {
      await mkdir(join(internalRoot, "notes"), { recursive: true });
      await mkdir(join(internalRoot, "docx"), { recursive: true });
      await writeFile(
        join(internalRoot, "manifest.json"),
        JSON.stringify({ schemaVersion: 1, source: "user-owned", packs: ["notes", "docx"] }, null, 2),
        "utf8",
      );
      await writeFile(join(internalRoot, "notes", "SKILL.md"), "---\nname: notes\n---\n", "utf8");
      await writeFile(join(internalRoot, "docx", "SKILL.md"), "---\nname: user-docx\n---\n", "utf8");

      await provisionWorkspaceInternalSystem(workspaceRoot);

      await expect(readFile(join(internalRoot, "notes", "SKILL.md"), "utf8")).resolves.toContain("name: notes");
      await expect(readFile(join(internalRoot, "docx", "SKILL.md"), "utf8")).resolves.toContain("name: user-docx");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("is idempotent and does not recreate legacy internal artifacts", async () => {
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

      await expectNoInternalDelegationRuntime(workspaceRoot);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("removes legacy onboarding skills without removing user-owned skills", async () => {
    const workspaceRoot = await createWorkspaceRoot("legacy-onboarding-skills");
    const skillsRoot = join(workspaceRoot, ".opencode", "skills");
    const workspaceGuideDir = join(skillsRoot, "workspace-guide");
    const getStartedDir = join(skillsRoot, "get-started");
    const userGuideDir = join(skillsRoot, "user-guide");

    try {
      await mkdir(workspaceGuideDir, { recursive: true });
      await mkdir(getStartedDir, { recursive: true });
      await mkdir(userGuideDir, { recursive: true });
      await writeFile(
        join(workspaceGuideDir, "SKILL.md"),
        `---
name: workspace-guide
description: Workspace guide to introduce Veslo and onboard new users.
---

# Welcome to Veslo

Hi, I'm Ben and this is Veslo. It's a local-first alternative to Claude's cowork.

End with two friendly next actions to try in Veslo.
`,
        "utf8",
      );
      await writeFile(
        join(getStartedDir, "SKILL.md"),
        `---
name: get-started
description: Guide users through the get started setup and Chrome DevTools demo.
---

## When to use
- Always load this skill when the user says "get started".

## What to do
- Reply with these four lines, exactly and in order:
  1) hey there welcome this is veslo
`,
        "utf8",
      );
      await writeFile(
        join(userGuideDir, "SKILL.md"),
        `---
name: user-guide
description: User-owned onboarding notes.
---

# User guide
`,
        "utf8",
      );

      await provisionWorkspaceInternalSystem(workspaceRoot);

      await expect(access(workspaceGuideDir)).rejects.toThrow();
      await expect(access(getStartedDir)).rejects.toThrow();
      await access(join(userGuideDir, "SKILL.md"));
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("is idempotent in central symlink mode", async () => {
    if (!(await canCreateDirectorySymlink())) return;

    const workspaceRoot = await createWorkspaceRoot("idempotent-symlink");
    const appDataDir = await createWorkspaceRoot("idempotent-symlink-appdata");

    try {
      await mkdir(join(workspaceRoot, ".opencode", "agents"), { recursive: true });
      await writeFile(
        join(workspaceRoot, ".opencode", "agents", "veslo.md"),
        "---\ndescription: Veslo default agent (desktop-first, safe, self-referential)\nmode: primary\ntemperature: 0.2\n---\n\nYou are Veslo.\n",
        "utf8",
      );

      await provisionWorkspaceInternalSystem(workspaceRoot, appDataDir);
      const second = await provisionWorkspaceInternalSystem(workspaceRoot, appDataDir);
      expect(second.status).toBe("unchanged");
      expect(second.written).toBe(0);
      expect(second.unchanged).toBeGreaterThan(0);
      await expectNoInternalDelegationRuntime(workspaceRoot);
      await expectMissing(join(appDataDir, "internal-packs"));
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(appDataDir, { recursive: true, force: true });
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
      expect(vesloAgent).not.toContain("VESLO_INTERNAL_ROUTING_START");
      expectNoRuntimeRoutingLanguage(vesloAgent);
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

  test("does not create veslo.md or internal agents when veslo.md is absent", async () => {
    const workspaceRoot = await createWorkspaceRoot("no-veslo-md");

    try {
      // No veslo.md — TS provision should NOT create it (that's Rust's job)
      await provisionWorkspaceInternalSystem(workspaceRoot);

      const vesloMdPath = join(workspaceRoot, ".opencode", "agents", "veslo.md");
      const fileExists = await access(vesloMdPath)
        .then(() => true)
        .catch(() => false);
      expect(fileExists).toBe(false);
      await expectNoInternalDelegationRuntime(workspaceRoot);
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
      expect(vesloAgent).not.toContain("VESLO_INTERNAL_ROUTING_START");
      expect(vesloAgent).toContain("VESLO_AGENT_INSTRUCTIONS_START");
      expect(vesloAgent).toContain("Response Style");
      expect(vesloAgent).toContain("Output Hygiene");
      expect(vesloAgent).toContain("Veslo Tools & Features");
      expect(vesloAgent).toContain("Skills");
      expect(vesloAgent).toContain("Scheduler");
      expect(vesloAgent).toContain("Workspace");
      expectNoRuntimeRoutingLanguage(vesloAgent);

      // Idempotent
      const second = await provisionWorkspaceInternalSystem(workspaceRoot);
      expect(second.status).toBe("unchanged");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
