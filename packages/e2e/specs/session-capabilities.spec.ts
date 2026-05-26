import { expect } from "@wdio/globals";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";

type EngineInfo = {
  running: boolean;
  baseUrl: string | null;
  opencodeUsername: string | null;
  opencodePassword: string | null;
};

type WorkspaceInfo = {
  id: string;
  path: string;
  directory?: string | null;
};

type WorkspaceList = {
  activeId: string;
  workspaces: WorkspaceInfo[];
};

type SeededSession = {
  id: string;
  title: string;
};

const WAIT_TIMEOUT_MS = 20_000;
const SIDEBAR_DOCKED_VISIBILITY_KEY = "veslo.global.sidebar.docked.v1";
const CAPABILITIES_PANEL_SELECTOR = '[data-testid="session-capabilities-panel"]';
const CAPABILITIES_SKILLS_SELECTOR = '[data-testid="session-capabilities-skills"]';
const CAPABILITIES_MCP_SELECTOR = '[data-testid="session-capabilities-mcp"]';

const profileRoot = () => process.env.E2E_OPENCODE_HOME?.trim() || join(process.cwd(), ".tmp-veslo-home");
const activeWorkspaceRoot = () => join(profileRoot(), "workspaces", "visual-workspace");
const selectedWorkspaceRoot = () => join(profileRoot(), "workspaces", "session-capabilities-selected-workspace");
const globalSkillsRoot = () => join(profileRoot(), ".config", "opencode", "skills");
const activeWorkspaceSkillsRoot = () => join(activeWorkspaceRoot(), ".opencode", "skills");
const selectedWorkspaceSkillsRoot = () => join(selectedWorkspaceRoot(), ".opencode", "skills");
const globalMcpConfigPath = () => join(profileRoot(), ".config", "opencode", "opencode.jsonc");
const activeWorkspaceMcpConfigPath = () => join(activeWorkspaceRoot(), "opencode.jsonc");
const selectedWorkspaceMcpConfigPath = () => join(selectedWorkspaceRoot(), "opencode.jsonc");

function trimText(value: string | null | undefined) {
  return (value ?? "").trim();
}

function writeSkill(root: string, name: string, description: string): void {
  const skillDir = join(root, name);
  rmSync(skillDir, { recursive: true, force: true });
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    [
      `# ${name}`,
      "",
      description,
      "",
      "## When to use",
      `- ${description}`,
      "",
    ].join("\n"),
  );
}

function writeJsonc(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function seedSessionCapabilitiesFixture(): void {
  writeSkill(
    globalSkillsRoot(),
    "e2e-global-session-skill",
    "Global fixture skill for the session capabilities panel.",
  );
  writeSkill(
    selectedWorkspaceSkillsRoot(),
    "e2e-workspace-session-skill",
    "Selected workspace fixture skill for the session capabilities panel.",
  );
  writeSkill(
    activeWorkspaceSkillsRoot(),
    "e2e-active-decoy-session-skill",
    "Active workspace decoy skill that should not appear for the selected session.",
  );
  writeJsonc(globalMcpConfigPath(), {
    mcp: {
      "e2e-global-session-mcp": {
        type: "remote",
        url: "https://global-session-mcp.example/mcp",
      },
    },
  });
  writeJsonc(selectedWorkspaceMcpConfigPath(), {
    mcp: {
      "e2e-workspace-session-mcp": {
        type: "remote",
        url: "https://workspace-session-mcp.example/mcp",
      },
    },
  });
  writeJsonc(activeWorkspaceMcpConfigPath(), {
    mcp: {
      "e2e-active-decoy-session-mcp": {
        type: "remote",
        url: "https://active-decoy-session-mcp.example/mcp",
      },
    },
  });
}

async function tauriInvoke<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  const result = await browser.executeAsync(
    (
      args: { command: string; payload: Record<string, unknown> },
      done: (value: { ok: boolean; value?: unknown; error?: string }) => void,
    ) => {
      const invoke = (
        window as typeof window & {
          __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__?.invoke;

      if (typeof invoke !== "function") {
        done({ ok: false, error: "Tauri invoke bridge is unavailable" });
        return;
      }

      invoke(args.command, args.payload).then(
        (value) => done({ ok: true, value }),
        (error) =>
          done({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    },
    { command, payload },
  ) as { ok: boolean; value?: T; error?: string };

  if (!result.ok) {
    throw new Error(`Tauri invoke failed for ${command}: ${result.error ?? "unknown error"}`);
  }

  return result.value as T;
}

async function readActiveClientContext() {
  const [engine, bootstrap] = await Promise.all([
    tauriInvoke<EngineInfo>("engine_info"),
    tauriInvoke<WorkspaceList>("workspace_bootstrap"),
  ]);

  const baseUrl = trimText(engine.baseUrl);
  if (!engine.running || !baseUrl) {
    throw new Error("Engine is not ready yet");
  }

  const activeWorkspace = bootstrap.workspaces.find((workspace) => workspace.id === bootstrap.activeId);
  const directory = trimText(activeWorkspace?.directory) || trimText(activeWorkspace?.path);

  if (!activeWorkspace || !directory) {
    throw new Error("Active workspace is not ready yet");
  }

  return {
    baseUrl,
    directory,
    username: trimText(engine.opencodeUsername) || undefined,
    password: trimText(engine.opencodePassword) || undefined,
  };
}

async function readActiveWorkspaceDirectory(): Promise<string> {
  const bootstrap = await tauriInvoke<WorkspaceList>("workspace_bootstrap");
  const activeWorkspace = bootstrap.workspaces.find((workspace) => workspace.id === bootstrap.activeId);
  const directory = trimText(activeWorkspace?.directory) || trimText(activeWorkspace?.path);
  if (!activeWorkspace || !directory) {
    throw new Error("Active workspace is not ready yet");
  }

  return directory;
}

async function ensureActiveEngineStarted(selectedDirectory: string) {
  const directory = await readActiveWorkspaceDirectory();

  await tauriInvoke<EngineInfo>("engine_start", {
    projectDir: directory,
    preferSidecar: true,
    runtime: "direct",
    workspacePaths: [directory, selectedDirectory],
  });
}

async function waitForActiveClientContext() {
  let context: Awaited<ReturnType<typeof readActiveClientContext>> | null = null;

  await browser.waitUntil(
    async () => {
      try {
        context = await readActiveClientContext();
        return true;
      } catch {
        return false;
      }
    },
    {
      timeout: WAIT_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: "Active engine + workspace context did not become ready in time",
    },
  );

  return context!;
}

async function createSessionForSelectedWorkspace(): Promise<SeededSession> {
  const selectedDirectory = selectedWorkspaceRoot();
  mkdirSync(selectedDirectory, { recursive: true });
  await ensureActiveEngineStarted(selectedDirectory);
  const { baseUrl, directory, username, password } = await waitForActiveClientContext();
  // @ts-expect-error -- shared app test utilities are JS-only in this workspace.
  const { makeClient, waitForHealthy } = await import("../../app/scripts/_util.mjs");

  const client = makeClient({
    baseUrl,
    directory,
    auth: {
      username,
      password,
    },
  });

  await waitForHealthy(client, { timeoutMs: WAIT_TIMEOUT_MS, pollMs: 250 });

  const title = `e2e session capabilities ${Date.now()}`;
  const created = await client.session.create({ title, directory: selectedDirectory });
  return { id: created.id, title };
}

async function positionWindowForSessionCapabilities(): Promise<void> {
  await browser.execute(async () => {
    const { LogicalPosition, LogicalSize } = await import("@tauri-apps/api/dpi");
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.show();
    await win.unminimize();
    await win.setSize(new LogicalSize(1420, 900));
    await win.setPosition(new LogicalPosition(80, 80));
    await win.setFocus();
  }).catch(() => undefined);
}

async function forceRightSidebarVisible(hashFragment: string): Promise<void> {
  await positionWindowForSessionCapabilities();
  await browser.execute((key: string) => {
    window.localStorage.setItem(key, JSON.stringify({ left: true, right: true }));
  }, SIDEBAR_DOCKED_VISIBILITY_KEY);
  await browser.refresh();
  await waitForHashRoute(hashFragment, WAIT_TIMEOUT_MS);

  if (!(await $(CAPABILITIES_PANEL_SELECTOR).isExisting())) {
    const toggle = await $('button[aria-label="Toggle right menu"]');
    if (await toggle.isExisting()) {
      await toggle.click();
    }
  }

  await browser.waitUntil(
    async () => $(CAPABILITIES_PANEL_SELECTOR).isExisting(),
    {
      timeout: WAIT_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: "Session capabilities panel did not appear in the right sidebar.",
    },
  );
}

async function waitForPanelText(selector: string, expected: string[]): Promise<string> {
  let latestText = "";

  await browser.waitUntil(
    async () => {
      const element = await $(selector);
      if (!(await element.isExisting())) return false;
      latestText = await element.getText();
      return expected.every((value) => latestText.includes(value));
    },
    {
      timeout: WAIT_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `${selector} did not include expected text: ${expected.join(", ")}`,
    },
  );

  return latestText;
}

const runWhenIsolatedProfile = process.env.E2E_USE_EXISTING_PROFILE?.trim() === "1"
  ? describe.skip
  : describe;

runWhenIsolatedProfile("Session capabilities right menu", () => {
  it("shows local global and workspace skills and MCP servers for the selected session", async () => {
    seedSessionCapabilitiesFixture();
    const session = await createSessionForSelectedWorkspace();
    const sessionHash = `#/session/${session.id}`;

    await navigateToHash(`/session/${session.id}`);
    await waitForHashRoute(sessionHash, WAIT_TIMEOUT_MS);
    await forceRightSidebarVisible(sessionHash);

    const panel = await $(CAPABILITIES_PANEL_SELECTOR);
    await expect(panel).toExist();

    const skillsText = await waitForPanelText(CAPABILITIES_SKILLS_SELECTOR, [
      "e2e-global-session-skill",
      "e2e-workspace-session-skill",
    ]);
    const mcpText = await waitForPanelText(CAPABILITIES_MCP_SELECTOR, [
      "e2e-global-session-mcp",
      "e2e-workspace-session-mcp",
    ]);
    const panelText = await panel.getText();
    const bodyText = await browser.execute(() => document.body.innerText);

    expect(skillsText).toContain("e2e-global-session-skill");
    expect(skillsText).toContain("e2e-workspace-session-skill");
    expect(mcpText).toContain("e2e-global-session-mcp");
    expect(mcpText).toContain("e2e-workspace-session-mcp");
    expect(panelText).not.toContain("e2e-active-decoy-session-skill");
    expect(panelText).not.toContain("e2e-active-decoy-session-mcp");
    expect(bodyText).not.toContain("e2e-active-decoy-session-skill");
    expect(bodyText).not.toContain("e2e-active-decoy-session-mcp");
  });
});
