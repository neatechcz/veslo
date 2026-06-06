import { expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";

const WAIT_TIMEOUT_MS = 20_000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const attachmentFixturePath = resolve(__dirname, "..", "fixtures", "attachment-staging-test.png");
const attachmentFixtureBytes = readFileSync(attachmentFixturePath);
const attachmentFixtureBase64 = attachmentFixtureBytes.toString("base64");

const defaultIsolatedProfileRoot = () => join(process.cwd(), ".tmp-veslo-home");
const activeWorkspaceRoot = () => join(defaultIsolatedProfileRoot(), "workspaces", "visual-workspace");
const opencodeDbPath = () => join(defaultIsolatedProfileRoot(), ".local", "share", "opencode", "opencode.db");

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

function writeCreatedOutputBitmap(): void {
  const outputPath = join(activeWorkspaceRoot(), "screenshots", "created-output.png");
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, new Uint8Array(attachmentFixtureBytes));
}

function seedMediaEvidenceSession(): string {
  const dbPath = opencodeDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  writeCreatedOutputBitmap();

  const now = Date.now();
  const sessionId = `e2e-media-evidence-${now}`;
  const projectId = `project-${sessionId}`;
  const title = `E2E media evidence ${now}`;
  const directory = activeWorkspaceRoot();
  const messageId = (suffix: string) => `${sessionId}-${suffix}`;

  const messages = [
    { id: messageId("001-user"), role: "user" as const, created: now + 1 },
    { id: messageId("002-tool-screenshot"), role: "assistant" as const, created: now + 2 },
    { id: messageId("003-tool-write"), role: "assistant" as const, created: now + 3 },
    { id: messageId("004-final"), role: "assistant" as const, created: now + 4 },
  ];

  const parts = [
    {
      id: `${messageId("001-user")}-part-text`,
      messageId: messageId("001-user"),
      part: { type: "text", text: "Analyze this screenshot sentinel." },
    },
    {
      id: `${messageId("001-user")}-part-image`,
      messageId: messageId("001-user"),
      part: {
        type: "file",
        filename: "attachment-staging-test.png",
        mime: "image/png",
        url: `data:image/png;base64,${attachmentFixtureBase64}`,
      },
    },
    {
      id: `${messageId("002-tool-screenshot")}-part`,
      messageId: messageId("002-tool-screenshot"),
      part: {
        type: "tool",
        tool: "browser_screenshot",
        state: {
          status: "completed",
          images: [
            {
              data: attachmentFixtureBase64,
              mediaType: "image/png",
              alt: "Browser screenshot sentinel",
            },
          ],
        },
      },
    },
    {
      id: `${messageId("003-tool-write")}-part`,
      messageId: messageId("003-tool-write"),
      part: {
        type: "tool",
        tool: "write",
        state: { status: "completed", input: { filePath: "screenshots/created-output.png" } },
      },
    },
    {
      id: `${messageId("004-final")}-part`,
      messageId: messageId("004-final"),
      part: { type: "text", text: "Media evidence final answer sentinel." },
    },
  ];

  const messageInserts = messages.map((message) => `
INSERT OR REPLACE INTO message (id, session_id, data)
VALUES (${sql(message.id)}, ${sql(sessionId)}, ${sql(messageData({ ...message, sessionId }))});
`).join("\n");

  const partInserts = parts.map((part) => `
INSERT OR REPLACE INTO part (id, session_id, message_id, data)
VALUES (${sql(part.id)}, ${sql(sessionId)}, ${sql(part.messageId)}, ${sql(partData({ ...part, sessionId }))});
`).join("\n");

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
CREATE TABLE IF NOT EXISTS message (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  data text NOT NULL
);
CREATE TABLE IF NOT EXISTS part (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  message_id text NOT NULL,
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

describe("Session media evidence", () => {
  it("renders media evidence in the session progress timeline", async function () {
    if (!hasSqlite3()) {
      this.skip();
    }

    const sessionId = seedMediaEvidenceSession();

    await navigateToHash(`/session/${sessionId}`);
    await waitForHashRoute(`#/session/${sessionId}`, WAIT_TIMEOUT_MS);

    await browser.waitUntil(
      async () => (await bodyText()).includes("Media evidence final answer sentinel."),
      {
        timeout: WAIT_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "Seeded media evidence final answer did not render in the desktop session transcript.",
      },
    );

    const groups = await $$('[data-testid="session-progress-group"]');
    expect(groups.length).toBe(1);

    const collapsedGroupText = (await groups[0]!.getText()).toLowerCase();
    expect(collapsedGroupText).toContain("image");
    expect(collapsedGroupText).toContain("analyzed");
    expect(collapsedGroupText).toContain("created");

    await groups[0]!.$("button").click();

    await browser.waitUntil(
      async () => browser.execute(() => document.querySelectorAll('[data-testid="session-progress-step-group"]').length >= 2),
      {
        timeout: WAIT_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "Expanded progress group did not render nested progress steps.",
      },
    );

    const stepGroupCount = await browser.execute(() => document.querySelectorAll('[data-testid="session-progress-step-group"]').length);
    for (let index = 0; index < stepGroupCount; index += 1) {
      await browser.execute((stepIndex: number) => {
        const stepGroup = document.querySelectorAll('[data-testid="session-progress-step-group"]')[stepIndex];
        stepGroup?.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      }, index);
      await browser.pause(50);
    }

    await browser.waitUntil(
      async () => browser.execute(() => document.querySelectorAll('[data-testid="media-evidence-tile"]').length >= 2),
      {
        timeout: WAIT_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "Expanded progress group did not render both media evidence tiles.",
      },
    );

    const tiles = await $$('[data-testid="media-evidence-tile"]');
    expect(tiles.length).toBeGreaterThanOrEqual(2);

    await tiles[0]!.click();
    expect(await $('[data-testid="media-evidence-detail"]').isExisting()).toBe(true);
  });
});
