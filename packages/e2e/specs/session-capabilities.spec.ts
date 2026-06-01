import { expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";

type EngineInfo = {
  running: boolean;
  baseUrl: string | null;
  projectDir: string | null;
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
const SESSION_DIRECTORY_OVERRIDE_KEY = "veslo.session-workspace-override.v1";
const CAPABILITIES_PANEL_SELECTOR = '[data-testid="session-capabilities-panel"]';
const CAPABILITIES_SKILLS_SELECTOR = '[data-testid="session-capabilities-skills"]';
const CAPABILITIES_MCP_SELECTOR = '[data-testid="session-capabilities-mcp"]';

const defaultIsolatedProfileRoot = () => join(process.cwd(), ".tmp-veslo-home");
const activeWorkspaceRoot = () => join(defaultIsolatedProfileRoot(), "workspaces", "visual-workspace");
const selectedWorkspaceRoot = () =>
  join(defaultIsolatedProfileRoot(), "workspaces", "session-capabilities-selected-workspace");
const globalSkillsRoot = () => join(defaultIsolatedProfileRoot(), ".config", "opencode", "skills");
const activeWorkspaceSkillsRoot = () => join(activeWorkspaceRoot(), ".opencode", "skills");
const selectedWorkspaceSkillsRoot = () => join(selectedWorkspaceRoot(), ".opencode", "skills");
const globalMcpConfigPath = () => join(defaultIsolatedProfileRoot(), ".config", "opencode", "opencode.jsonc");
const activeWorkspaceMcpConfigPath = () => join(activeWorkspaceRoot(), "opencode.jsonc");
const selectedWorkspaceMcpConfigPath = () => join(selectedWorkspaceRoot(), "opencode.jsonc");
const opencodeDbPath = () => join(defaultIsolatedProfileRoot(), ".local", "share", "opencode", "opencode.db");

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

function normalizePath(value: string | null | undefined): string {
  return trimText(value).replace(/\\/g, "/").replace(/\/+$/, "");
}

function hasSqlite3(): boolean {
  if (existsSync("/usr/bin/sqlite3") || existsSync("/opt/homebrew/bin/sqlite3")) return true;
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function sqlite3Command(): string {
  if (existsSync("/usr/bin/sqlite3")) return "/usr/bin/sqlite3";
  if (existsSync("/opt/homebrew/bin/sqlite3")) return "/opt/homebrew/bin/sqlite3";
  return "sqlite3";
}

function sql(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

function seedOpenCodeDbSession(input: { id: string; title: string; directory: string }): void {
  const dbPath = opencodeDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const now = Date.now();
  const projectId = `project-${input.id}`;
  const script = `
PRAGMA foreign_keys = OFF;
CREATE TABLE IF NOT EXISTS project (
  id text PRIMARY KEY,
  worktree text NOT NULL,
  vcs text,
  name text,
  icon_url text,
  icon_color text,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  time_initialized integer,
  sandboxes text NOT NULL,
  commands text,
  icon_url_override text
);
CREATE TABLE IF NOT EXISTS session (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  parent_id text,
  slug text NOT NULL,
  directory text NOT NULL,
  title text NOT NULL,
  version text NOT NULL,
  share_url text,
  summary_additions integer,
  summary_deletions integer,
  summary_files integer,
  summary_diffs text,
  revert text,
  permission text,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  time_compacting integer,
  time_archived integer,
  workspace_id text,
  path text
);
INSERT OR REPLACE INTO project (
  id, worktree, vcs, name, icon_url, icon_color, time_created, time_updated, time_initialized, sandboxes, commands, icon_url_override
) VALUES (
  ${sql(projectId)}, ${sql(input.directory)}, NULL, ${sql("Selected Workspace")}, NULL, NULL, ${sql(now)}, ${sql(now)}, NULL, ${sql("[]")}, NULL, NULL
);
INSERT OR REPLACE INTO session (
  id, project_id, parent_id, slug, directory, title, version, share_url,
  summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission,
  time_created, time_updated, time_compacting, time_archived, workspace_id, path
) VALUES (
  ${sql(input.id)}, ${sql(projectId)}, NULL, ${sql(input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"))},
  ${sql(input.directory)}, ${sql(input.title)}, ${sql("0.0.0")}, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, ${sql(now)}, ${sql(now)}, NULL, NULL, NULL, ${sql(input.directory)}
);
`;
  execFileSync(sqlite3Command(), [dbPath], { input: script });
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

async function ensureActiveEngineStarted() {
  const directory = await readActiveWorkspaceDirectory();

  await tauriInvoke<EngineInfo>("engine_start", {
    projectDir: directory,
    preferSidecar: true,
    runtime: "direct",
    workspacePaths: [directory],
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

async function createSessionInActiveWorkspace(): Promise<SeededSession> {
  await ensureActiveEngineStarted();
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
  const created = await client.session.create({ title, directory });
  return { id: created.id, title };
}

async function overrideSessionDirectory(sessionId: string, directory: string): Promise<void> {
  await browser.execute(
    (key: string, id: string, value: string) => {
      window.localStorage.setItem(key, JSON.stringify({ [id]: value }));
    },
    SESSION_DIRECTORY_OVERRIDE_KEY,
    sessionId,
    directory,
  );
}

async function registerSelectedWorkspaceWithoutLoadingRuntime(): Promise<string> {
  mkdirSync(selectedWorkspaceRoot(), { recursive: true });
  const before = await tauriInvoke<WorkspaceList>("workspace_bootstrap");
  const activeWorkspaceId = before.activeId;
  let selected = before.workspaces.find((workspace) => normalizePath(workspace.path) === normalizePath(selectedWorkspaceRoot()));

  if (!selected) {
    await tauriInvoke<WorkspaceList>("workspace_create", {
      folderPath: selectedWorkspaceRoot(),
      name: "Session Capabilities Selected Workspace",
      preset: "starter",
    });
    const afterCreate = await tauriInvoke<WorkspaceList>("workspace_bootstrap");
    selected = afterCreate.workspaces.find((workspace) => normalizePath(workspace.path) === normalizePath(selectedWorkspaceRoot()));
  }

  if (activeWorkspaceId) {
    await tauriInvoke<WorkspaceList>("workspace_set_active", {
      workspaceId: activeWorkspaceId,
      promoteToFront: false,
    });
  }

  if (!selected?.id) {
    throw new Error("Selected workspace fixture was not registered.");
  }
  return selected.id;
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

async function setDockedSidebarsVisible(hashFragment: string): Promise<void> {
  await positionWindowForSessionCapabilities();
  await browser.execute((key: string) => {
    window.localStorage.setItem(key, JSON.stringify({ left: true, right: true }));
  }, SIDEBAR_DOCKED_VISIBILITY_KEY);
  await browser.refresh();
  await waitForHashRoute(hashFragment, WAIT_TIMEOUT_MS);
}

async function forceRightSidebarVisible(hashFragment: string): Promise<void> {
  await setDockedSidebarsVisible(hashFragment);

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

  try {
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
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nLast ${selector} text:\n${latestText}`,
    );
  }

  return latestText;
}

async function clickSidebarSessionRow(expectedText: string): Promise<void> {
  let matchingRow: WebdriverIO.Element | null = null;
  let latestRowsText = "";

  try {
    await browser.waitUntil(
      async () => {
        const rows = await $$('[data-session-sidebar-row="true"]');
        const texts: string[] = [];
        for (const row of rows) {
          const text = await row.getText().catch(() => "");
          texts.push(text);
          if (text.includes(expectedText)) {
            matchingRow = row;
            return true;
          }
        }
        latestRowsText = texts.join("\n---\n");
        return false;
      },
      {
        timeout: WAIT_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: `Sidebar session row did not appear: ${expectedText}`,
      },
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nLast sidebar rows:\n${latestRowsText}`,
    );
  }

  await matchingRow!.click();
}

async function waitForSessionHashRoute(hashFragment: string): Promise<void> {
  try {
    await waitForHashRoute(hashFragment, WAIT_TIMEOUT_MS);
  } catch (error) {
    const [currentHash, rowsText, bodyText] = await Promise.all([
      browser.execute(() => window.location.hash).catch(() => ""),
      browser
        .execute(async () =>
          Array.from(document.querySelectorAll('[data-session-sidebar-row="true"]'))
            .map((row) => row.textContent?.trim() ?? "")
            .filter(Boolean)
            .join("\n---\n"),
        )
        .catch(() => ""),
      browser.execute(() => document.body.innerText).catch(() => ""),
    ]);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nCurrent hash: ${currentHash}\nSidebar rows:\n${rowsText}\nBody:\n${bodyText}`,
    );
  }
}

// Custom E2E_OPENCODE_HOME does not rewrite HOME/XDG_CONFIG_HOME in the launcher,
// so global capability fixtures are deterministic only in the default isolated profile.
const runWhenDefaultIsolatedProfile =
  process.env.E2E_USE_EXISTING_PROFILE?.trim() === "1" || process.env.E2E_OPENCODE_HOME?.trim()
  ? describe.skip
  : describe;

runWhenDefaultIsolatedProfile("Session capabilities right menu", () => {
  it("shows local global and workspace skills and MCP servers for the selected session", async () => {
    seedSessionCapabilitiesFixture();
    const session = await createSessionInActiveWorkspace();
    const sessionHash = `#/session/${session.id}`;

    await overrideSessionDirectory(session.id, selectedWorkspaceRoot());
    await navigateToHash(`/session/${session.id}`);
    await waitForHashRoute(sessionHash, WAIT_TIMEOUT_MS);
    await browser.refresh();
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

  it("shows inherited global skills when opening a DB-backed session from another workspace without loading its runtime", async function () {
    if (!hasSqlite3()) this.skip();

    seedSessionCapabilitiesFixture();
    await registerSelectedWorkspaceWithoutLoadingRuntime();

    const session = {
      id: `e2e-db-session-capabilities-${Date.now()}`,
      title: `E2E DB session capabilities ${Date.now()}`,
    };
    seedOpenCodeDbSession({
      ...session,
      directory: selectedWorkspaceRoot(),
    });
    await tauriInvoke<EngineInfo>("engine_stop");

    await navigateToHash("/session");
    await waitForHashRoute("#/session", WAIT_TIMEOUT_MS);
    await browser.refresh();
    await waitForHashRoute("#/session", WAIT_TIMEOUT_MS);
    await setDockedSidebarsVisible("#/session");

    const engineBefore = await tauriInvoke<EngineInfo>("engine_info").catch(() => null);
    await clickSidebarSessionRow(session.title);
    const sessionHash = `#/session/${session.id}`;
    await navigateToHash(`/session/${session.id}`);
    await waitForSessionHashRoute(sessionHash);
    await forceRightSidebarVisible(sessionHash);

    const skillsText = await waitForPanelText(CAPABILITIES_SKILLS_SELECTOR, [
      "e2e-global-session-skill",
      "e2e-workspace-session-skill",
    ]);
    const mcpText = await waitForPanelText(CAPABILITIES_MCP_SELECTOR, [
      "e2e-global-session-mcp",
      "e2e-workspace-session-mcp",
    ]);

    expect(skillsText).toContain("e2e-global-session-skill");
    expect(skillsText).toContain("e2e-workspace-session-skill");
    expect(mcpText).toContain("e2e-global-session-mcp");
    expect(mcpText).toContain("e2e-workspace-session-mcp");

    const engineAfter = await tauriInvoke<EngineInfo>("engine_info").catch(() => null);
    expect(engineBefore?.running).toBe(false);
    expect(engineAfter?.running).toBe(false);
    expect(normalizePath(engineAfter?.projectDir)).not.toBe(normalizePath(selectedWorkspaceRoot()));
  });
});
