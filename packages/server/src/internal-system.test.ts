import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  INTERNAL_SYSTEM_VERSION,
  provisionWorkspaceInternalSystem,
  resolveVesloAppDataDir,
} from "./internal-system.js";

async function createWorkspaceRoot(label: string) {
  return await mkdtemp(join(tmpdir(), `veslo-internal-system-${label}-`));
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

describe("provisionWorkspaceInternalSystem", () => {
  test("resolves desktop-provided app data directory before platform fallback", async () => {
    const appDataDir = await createWorkspaceRoot("app-data-override");
    const dataDir = await createWorkspaceRoot("data-dir-override");
    const previousAppDataDir = process.env.VESLO_APP_DATA_DIR;
    const previousDataDir = process.env.VESLO_DATA_DIR;

    try {
      process.env.VESLO_APP_DATA_DIR = appDataDir;
      process.env.VESLO_DATA_DIR = dataDir;
      expect(resolveVesloAppDataDir()).toBe(appDataDir);

      delete process.env.VESLO_APP_DATA_DIR;
      expect(resolveVesloAppDataDir()).toBe(join(dataDir, "app-data"));
    } finally {
      if (previousAppDataDir === undefined) {
        delete process.env.VESLO_APP_DATA_DIR;
      } else {
        process.env.VESLO_APP_DATA_DIR = previousAppDataDir;
      }
      if (previousDataDir === undefined) {
        delete process.env.VESLO_DATA_DIR;
      } else {
        process.env.VESLO_DATA_DIR = previousDataDir;
      }
      await rm(appDataDir, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  });

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

      const researchSkill = await readFile(
        join(workspaceRoot, ".opencode", "veslo", "internal", "research", "SKILL.md"),
        "utf8",
      );
      expect(researchSkill).toContain("name: research");
      expect(researchSkill).toContain('veslo_internal_pack: true');

      const subagent = await readFile(
        join(workspaceRoot, ".opencode", "agents", "veslo-internal-docx.md"),
        "utf8",
      );
      expect(subagent).toContain("mode: subagent");
      expect(subagent).toContain("hidden: true");

      const researchSubagent = await readFile(
        join(workspaceRoot, ".opencode", "agents", "veslo-internal-research.md"),
        "utf8",
      );
      expect(researchSubagent).toContain("Veslo internal Research execution agent");
      expect(researchSubagent).toContain("mode: subagent");

      const skillCreatorSkill = await readFile(
        join(workspaceRoot, ".opencode", "veslo", "internal", "skill-creator", "SKILL.md"),
        "utf8",
      );
      expect(skillCreatorSkill).toContain("Veslo Registry-Aware Skill Creation");
      expect(skillCreatorSkill).toContain(
        "Where should this skill live: user skill, workspace skill, organization skill, or public skill?",
      );
      expect(skillCreatorSkill).toContain('scope: "system"');
      expect(skillCreatorSkill).toContain('removalPolicy: "locked"');
      expect(skillCreatorSkill).not.toContain("Create or update skills only in this workspace");
      expect(skillCreatorSkill).not.toContain("Do not write company-global/shared skills in this flow");

      const skillCreatorSubagent = await readFile(
        join(workspaceRoot, ".opencode", "agents", "veslo-internal-skill-creator.md"),
        "utf8",
      );
      expect(skillCreatorSubagent).toContain("Do not assume workspace scope");
      expect(skillCreatorSubagent).toContain("user skill");
      expect(skillCreatorSubagent).toContain("workspace skill");
      expect(skillCreatorSubagent).toContain("organization skill");
      expect(skillCreatorSubagent).toContain("public skill");
      expect(skillCreatorSubagent).not.toContain("Create or update skills only in this workspace");
      expect(skillCreatorSubagent).not.toContain("Do not write company-global/shared skills in this flow");

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
      expect(plugin).toContain("veslo-internal-research");
      expect(plugin).toContain("export default async");
      expect(plugin).toContain('"chat.message"');
      expect(plugin).toContain("VESLO_ROUTER_FORCE_DELEGATE");
      expect(plugin).toContain("hasExplicitDelegateRequest");
      expect(plugin).toContain("spusť subagenta");
      expect(plugin).toContain('return "veslo-internal-research"');
      expect(plugin).toContain('" listu "');
      expect(plugin).not.toContain('" list "');
      expect(plugin).toContain("client.session.get");
      expect(plugin).toContain("query: { directory: parentDirectory }");

      const automationPlugin = await readFile(
        join(workspaceRoot, ".opencode", "plugins", "veslo-automations.js"),
        "utf8",
      );
      expect(automationPlugin).toContain("veslo_create_automation");
      expect(automationPlugin).toContain("veslo_list_automations");
      expect(automationPlugin).toContain("veslo_run_automation");
      expect(automationPlugin).toContain("veslo_update_automation");
      expect(automationPlugin).toContain("veslo_delete_automation");
      expect(automationPlugin).toContain("VESLO_SERVER_STATE_PATH");
      expect(automationPlugin).toContain("/workspace/${workspaceId}/automations");
      expect(automationPlugin).toContain("timezone: tool.schema.string().optional()");
      expect(automationPlugin).toContain("schedule: withTopLevelTimezone(args.schedule, args.timezone)");
      expect(automationPlugin).toContain("const TIMEZONE_CAPABLE_SCHEDULES");
      expect(automationPlugin).toContain('schedule.kind === "interval"');
      expect(automationPlugin).toContain("/workspaces");
      expect(automationPlugin).toContain("matchWorkspaceByDirectory");
      for (const forbidden of [
        "launchctl",
        "crontab",
        "systemctl",
        ".opencode/veslo/automations.json",
        ".opencode/veslo/agentlab",
      ]) {
        expect(automationPlugin).not.toContain(forbidden);
      }

      const manifest = await readFile(
        join(workspaceRoot, ".opencode", "veslo", "internal", "manifest.json"),
        "utf8",
      );
      expect(manifest).toContain(`"version": "${INTERNAL_SYSTEM_VERSION}"`);
      expect(manifest).toContain('"schemaVersion": 1');
      expect(manifest).toContain('"plugins"');
      expect(manifest).toContain("veslo-delegate.js");
      expect(manifest).toContain("veslo-automations.js");
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
      expect(subagent).toContain("Do not dump raw JSON");
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
      const fileExists = await access(vesloMdPath)
        .then(() => true)
        .catch(() => false);
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
      expect(vesloAgent).toContain("Response Style");
      expect(vesloAgent).toContain("Output Hygiene");
      expect(vesloAgent).toContain("delegate");

      // Idempotent
      const second = await provisionWorkspaceInternalSystem(workspaceRoot);
      expect(second.status).toBe("unchanged");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
