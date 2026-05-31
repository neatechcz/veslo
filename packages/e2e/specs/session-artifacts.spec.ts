import { expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";

const WAIT_TIMEOUT_MS = 20_000;
const SIDEBAR_DOCKED_VISIBILITY_KEY = "veslo.global.sidebar.docked.v1";
const ARTIFACTS_PANEL_SELECTOR = "#sidebar-artifacts";
const MODIFIED_FILES_SELECTOR = '[data-testid="session-artifact-files-modified"]';
const OPENED_FILES_SELECTOR = '[data-testid="session-artifact-files-opened"]';
const ACTIVE_WORKSPACE_ID = "e2e-visual-workspace";

const defaultIsolatedProfileRoot = () => join(process.cwd(), ".tmp-veslo-home");
const activeWorkspaceRoot = () => join(defaultIsolatedProfileRoot(), "workspaces", "visual-workspace");
const opencodeDbPath = () => join(defaultIsolatedProfileRoot(), ".local", "share", "opencode", "opencode.db");

type EngineInfo = {
  running: boolean;
  baseUrl: string | null;
  projectDir: string | null;
};

type VesloServerInfo = {
  running: boolean;
  baseUrl: string | null;
  clientToken: string | null;
  lastStderr?: string | null;
};

type LatestRunArtifactItem = {
  family: string;
  kind: string;
  status: string;
  title?: string;
  subtitle?: string;
  path?: string;
};

type LatestRunArtifactsResponse = {
  sessionId: string;
  workspaceId: string;
  runId: string | null;
  items: LatestRunArtifactItem[];
};

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

function trimBaseUrl(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function trimToken(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function messageData(input: { id: string; sessionId: string; role: "user" | "assistant"; created: number }): string {
  return JSON.stringify({
    id: input.id,
    sessionID: input.sessionId,
    role: input.role,
    time: { created: input.created },
    parentID: "",
    modelID: "",
    providerID: "",
    mode: "",
    agent: "",
    path: { cwd: activeWorkspaceRoot(), root: activeWorkspaceRoot() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  });
}

function partData(input: { id: string; sessionId: string; messageId: string; part: Record<string, unknown> }): string {
  return JSON.stringify({
    id: input.id,
    sessionID: input.sessionId,
    messageID: input.messageId,
    synthetic: false,
    ignored: false,
    ...input.part,
  });
}

function seedWorkspaceFixtures(): void {
  const workspaceRoot = activeWorkspaceRoot();
  mkdirSync(join(workspaceRoot, "src"), { recursive: true });
  writeFileSync(join(workspaceRoot, "src", "opened-only.ts"), "export const openedOnly = true;\n");
  writeFileSync(join(workspaceRoot, "src", "changed.ts"), "export const changed = true;\n");
  writeFileSync(join(workspaceRoot, "src", "search-noise.ts"), "export const searchNoise = true;\n");

  const skillRoot = join(workspaceRoot, ".opencode", "skills", "brainstorming");
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(
    join(skillRoot, "SKILL.md"),
    [
      "# brainstorming",
      "",
      "Fixture skill content for the session artifact panel E2E test.",
      "",
    ].join("\n"),
  );
}

function seedSessionArtifactSession(): string {
  const dbPath = opencodeDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });

  const now = Date.now();
  const sessionId = `ses_e2e_session_artifacts_${now}`;
  const projectId = `project-${sessionId}`;
  const title = `E2E session artifacts ${now}`;
  const directory = activeWorkspaceRoot();
  const messageId = (suffix: string) => `${sessionId}-${suffix}`;

  const messages = [
    { id: messageId("001-user"), role: "user" as const, created: now + 1 },
    { id: messageId("002-tool-read-opened"), role: "assistant" as const, created: now + 2 },
    { id: messageId("003-tool-search-noise"), role: "assistant" as const, created: now + 3 },
    { id: messageId("004-tool-glob-noise"), role: "assistant" as const, created: now + 4 },
    { id: messageId("005-tool-list-noise"), role: "assistant" as const, created: now + 5 },
    { id: messageId("006-tool-read-changed"), role: "assistant" as const, created: now + 6 },
    { id: messageId("007-tool-edit-changed"), role: "assistant" as const, created: now + 7 },
    { id: messageId("008-tool-skill"), role: "assistant" as const, created: now + 8 },
    { id: messageId("009-tool-read-skill"), role: "assistant" as const, created: now + 9 },
    { id: messageId("010-final"), role: "assistant" as const, created: now + 10 },
  ];

  const parts = [
    {
      id: `${messageId("001-user")}-part`,
      messageId: messageId("001-user"),
      part: { type: "text", text: "User artifact sentinel: inspect and update the workspace files." },
    },
    {
      id: `${messageId("002-tool-read-opened")}-part`,
      messageId: messageId("002-tool-read-opened"),
      part: {
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: "src/opened-only.ts" } },
      },
    },
    {
      id: `${messageId("003-tool-search-noise")}-part`,
      messageId: messageId("003-tool-search-noise"),
      part: {
        type: "tool",
        tool: "search",
        state: {
          status: "completed",
          input: {
            query: "src/search-noise.ts",
            path: "src/search-noise.ts",
            files: ["src/search-noise.ts"],
          },
          files: ["src/search-noise.ts"],
          output: "src/search-noise.ts",
        },
      },
    },
    {
      id: `${messageId("004-tool-glob-noise")}-part`,
      messageId: messageId("004-tool-glob-noise"),
      part: {
        type: "tool",
        tool: "glob",
        state: {
          status: "completed",
          input: {
            pattern: "src/search-noise.ts",
            path: "src/search-noise.ts",
            files: ["src/search-noise.ts"],
          },
          paths: ["src/search-noise.ts"],
          output: "src/search-noise.ts",
        },
      },
    },
    {
      id: `${messageId("005-tool-list-noise")}-part`,
      messageId: messageId("005-tool-list-noise"),
      part: {
        type: "tool",
        tool: "list",
        state: {
          status: "completed",
          input: {
            path: "src/search-noise.ts",
            files: ["src/search-noise.ts"],
          },
          files: ["src/search-noise.ts"],
          output: "src/search-noise.ts",
        },
      },
    },
    {
      id: `${messageId("006-tool-read-changed")}-part`,
      messageId: messageId("006-tool-read-changed"),
      part: {
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: "src/changed.ts" } },
      },
    },
    {
      id: `${messageId("007-tool-edit-changed")}-part`,
      messageId: messageId("007-tool-edit-changed"),
      part: {
        type: "tool",
        tool: "edit",
        state: { status: "completed", input: { filePath: "src/changed.ts" } },
      },
    },
    {
      id: `${messageId("008-tool-skill")}-part`,
      messageId: messageId("008-tool-skill"),
      part: {
        type: "tool",
        tool: "skill",
        title: "brainstorming",
        sourceName: "brainstorming",
        state: {
          status: "completed",
          input: { name: "brainstorming" },
          metadata: { name: "brainstorming" },
        },
      },
    },
    {
      id: `${messageId("009-tool-read-skill")}-part`,
      messageId: messageId("009-tool-read-skill"),
      part: {
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: ".opencode/skills/brainstorming/SKILL.md" } },
      },
    },
    {
      id: `${messageId("010-final")}-part`,
      messageId: messageId("010-final"),
      part: { type: "text", text: "Final assistant artifact sentinel: the file artifact grouping is ready." },
    },
  ];

  const messageCreatedById = new Map(messages.map((message) => [message.id, message.created] as const));

  const messageInserts = messages.map((message) => `
INSERT OR REPLACE INTO message (id, session_id, time_created, time_updated, data)
VALUES (${sql(message.id)}, ${sql(sessionId)}, ${sql(message.created)}, ${sql(message.created)}, ${sql(messageData({ ...message, sessionId }))});
`).join("\n");

  const partInserts = parts.map((part) => `
INSERT OR REPLACE INTO part (id, session_id, message_id, time_created, time_updated, data)
VALUES (${sql(part.id)}, ${sql(sessionId)}, ${sql(part.messageId)}, ${sql(messageCreatedById.get(part.messageId) ?? now)}, ${sql(messageCreatedById.get(part.messageId) ?? now)}, ${sql(partData({ ...part, sessionId }))});
`).join("\n");

  const script = `
PRAGMA foreign_keys = OFF;
PRAGMA busy_timeout = 5000;
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
CREATE TABLE IF NOT EXISTS message (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  data text NOT NULL
);
CREATE TABLE IF NOT EXISTS part (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  message_id text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  data text NOT NULL
);
INSERT OR REPLACE INTO project (
  id, worktree, vcs, name, icon_url, icon_color, time_created, time_updated, time_initialized, sandboxes, commands, icon_url_override
) VALUES (
  ${sql(projectId)}, ${sql(directory)}, NULL, ${sql("Visual Workspace")}, NULL, NULL, ${sql(now)}, ${sql(now)}, NULL, ${sql("[]")}, NULL, NULL
);
INSERT OR REPLACE INTO session (
  id, project_id, parent_id, slug, directory, title, version, share_url,
  summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission,
  time_created, time_updated, time_compacting, time_archived, workspace_id, path
) VALUES (
  ${sql(sessionId)}, ${sql(projectId)}, NULL, ${sql(title.toLowerCase().replace(/[^a-z0-9]+/g, "-"))},
  ${sql(directory)}, ${sql(title)}, ${sql("0.0.0")}, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, ${sql(now)}, ${sql(now)}, NULL, NULL, NULL, ${sql(directory)}
);
${messageInserts}
${partInserts}
`;

  execFileSync(sqlite3Command(), [dbPath], { input: script });
  return sessionId;
}

async function bodyText(): Promise<string> {
  return browser.execute(() => document.body.innerText);
}

async function positionWindowForArtifacts(): Promise<void> {
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

async function ensureActiveEngineStarted(): Promise<void> {
  const workspaceRoot = activeWorkspaceRoot();

  await tauriInvoke<EngineInfo>("engine_start", {
    projectDir: workspaceRoot,
    preferSidecar: true,
    runtime: "direct",
    workspacePaths: [workspaceRoot],
  });

  await browser.waitUntil(
    async () => {
      const info = await tauriInvoke<EngineInfo>("engine_info").catch(() => null);
      return Boolean(info?.running && info.baseUrl?.trim());
    },
    {
      timeout: WAIT_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: "Active OpenCode engine did not become ready for session artifact loading.",
    },
  );
}

async function waitForVesloServerReady(timeoutMs = 45_000): Promise<VesloServerInfo> {
  let latest: VesloServerInfo | null = null;

  await browser.waitUntil(
    async () => {
      try {
        const info = await tauriInvoke<VesloServerInfo>("veslo_server_info");
        latest = info;

        if (!info.running) return false;
        const baseUrl = trimBaseUrl(info.baseUrl);
        const token = trimToken(info.clientToken);
        if (!baseUrl || !token) return false;

        const response = await fetch(`${baseUrl}/health`);
        if (!response.ok) return false;

        const health = (await response.json()) as { ok?: boolean };
        return health.ok === true;
      } catch {
        return false;
      }
    },
    {
      timeout: timeoutMs,
      interval: 500,
      timeoutMsg: "Veslo server did not become healthy for session artifact loading.",
    },
  );

  if (!latest) {
    throw new Error("Veslo server readiness check returned no status data.");
  }

  return latest;
}

function artifactSearchText(item: LatestRunArtifactItem): string {
  return [item.path, item.title, item.subtitle].filter(Boolean).join("\n");
}

function hasServerBackedArtifacts(payload: LatestRunArtifactsResponse): boolean {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const hasModifiedFile = items.some(
    (item) => item.family === "files" && item.kind === "file_output" && item.path === "src/changed.ts",
  );
  const hasOpenedFile = items.some(
    (item) => item.family === "files" && item.kind === "file_discovered" && item.path === "src/opened-only.ts",
  );
  const hasSkill = items.some(
    (item) => item.family === "skills" && item.kind === "skill_used" && item.title === "brainstorming",
  );
  const hasSearchNoise = items.some((item) => artifactSearchText(item).includes("search-noise.ts"));
  const hasSkillFile = items.some((item) => artifactSearchText(item).includes("SKILL.md"));

  return hasModifiedFile && hasOpenedFile && hasSkill && !hasSearchNoise && !hasSkillFile;
}

async function waitForServerLatestRunArtifacts(sessionId: string): Promise<LatestRunArtifactsResponse> {
  const info = await waitForVesloServerReady();
  const baseUrl = trimBaseUrl(info.baseUrl);
  const token = trimToken(info.clientToken);
  let latestPayload: LatestRunArtifactsResponse | null = null;
  let latestDebug = "";

  try {
    await browser.waitUntil(
      async () => {
        try {
          const response = await fetch(
            `${baseUrl}/workspace/${ACTIVE_WORKSPACE_ID}/sessions/${encodeURIComponent(sessionId)}/artifacts/latest-run`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
              },
            },
          );
          const text = await response.text();
          latestDebug = `${response.status} ${response.statusText}\n${text.slice(0, 2_000)}`;
          if (!response.ok) return false;

          latestPayload = JSON.parse(text) as LatestRunArtifactsResponse;
          return hasServerBackedArtifacts(latestPayload);
        } catch (error) {
          latestDebug = error instanceof Error ? error.stack ?? error.message : String(error);
          return false;
        }
      },
      {
        timeout: WAIT_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: "Server latest-run artifacts did not include the expected classified artifacts.",
      },
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nLast latest-run response:\n${latestDebug}`,
    );
  }

  if (!latestPayload) {
    throw new Error("Server latest-run artifacts returned no payload.");
  }

  return latestPayload;
}

async function forceRightMenuVisibleAndNavigate(sessionId: string): Promise<void> {
  const sessionHash = `#/session/${sessionId}`;

  await positionWindowForArtifacts();
  await browser.execute((key: string) => {
    window.localStorage.setItem(key, JSON.stringify({ left: true, right: true }));
  }, SIDEBAR_DOCKED_VISIBILITY_KEY);
  await browser.refresh();
  await navigateToHash(`/session/${sessionId}`);
  await waitForHashRoute(sessionHash, WAIT_TIMEOUT_MS);

  await browser.waitUntil(
    async () => (await $(ARTIFACTS_PANEL_SELECTOR).isExisting()),
    {
      timeout: WAIT_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: "Artifacts panel did not appear in the right sidebar.",
    },
  );
}

async function waitForArtifactsPanelText(): Promise<string> {
  let latestText = "";

  try {
    await browser.waitUntil(
      async () => {
        const panel = await $(ARTIFACTS_PANEL_SELECTOR);
        if (!(await panel.isExisting())) return false;
        latestText = await panel.getText();
        const lower = latestText.toLowerCase();
        return (
          latestText.includes("Modified") &&
          latestText.includes("Opened") &&
          latestText.includes("changed.ts") &&
          latestText.includes("opened-only.ts") &&
          lower.includes("brainstorming")
        );
      },
      {
        timeout: WAIT_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "Artifacts panel did not include the expected latest-run artifacts.",
      },
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nLast artifacts panel text:\n${latestText}`,
    );
  }

  return latestText;
}

const runWhenDefaultIsolatedProfile =
  process.env.E2E_USE_EXISTING_PROFILE?.trim() === "1" || process.env.E2E_OPENCODE_HOME?.trim()
  ? describe.skip
  : describe;

runWhenDefaultIsolatedProfile("Session right menu artifacts", () => {
  it("groups latest-run modified and opened files while filtering search noise and skill files", async function () {
    if (!hasSqlite3()) {
      this.skip();
    }

    seedWorkspaceFixtures();
    await ensureActiveEngineStarted();
    const sessionId = seedSessionArtifactSession();
    await waitForServerLatestRunArtifacts(sessionId);

    await forceRightMenuVisibleAndNavigate(sessionId);
    await browser.waitUntil(
      async () => (await bodyText()).includes("Final assistant artifact sentinel: the file artifact grouping is ready."),
      {
        timeout: WAIT_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "Seeded final answer did not render in the desktop session transcript.",
      },
    );

    const panelText = await waitForArtifactsPanelText();
    const modifiedGroup = await $(MODIFIED_FILES_SELECTOR);
    const openedGroup = await $(OPENED_FILES_SELECTOR);
    const modifiedText = await modifiedGroup.getText();
    const openedText = await openedGroup.getText();

    expect(panelText).toContain("Modified");
    expect(panelText).toContain("Opened");
    expect(panelText).toContain("changed.ts");
    expect(panelText).toContain("opened-only.ts");
    expect(panelText.toLowerCase()).toContain("brainstorming");
    expect(modifiedText).toContain("changed.ts");
    expect(modifiedText).not.toContain("opened-only.ts");
    expect(openedText).toContain("opened-only.ts");
    expect(openedText).not.toContain("changed.ts");
    expect(panelText).not.toContain("search-noise.ts");
    expect(panelText).not.toContain("SKILL.md");
  });
});
