import { expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";

const WAIT_TIMEOUT_MS = 20_000;

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

function seedProgressGroupingSession(): string {
  const dbPath = opencodeDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });

  const now = Date.now();
  const sessionId = `e2e-progress-grouping-${now}`;
  const projectId = `project-${sessionId}`;
  const title = `E2E progress grouping ${now}`;
  const directory = activeWorkspaceRoot();
  const messageId = (suffix: string) => `${sessionId}-${suffix}`;

  const messages = [
    { id: messageId("001-user"), role: "user" as const, created: now + 1 },
    { id: messageId("002-tool-read"), role: "assistant" as const, created: now + 2 },
    { id: messageId("003-comment"), role: "assistant" as const, created: now + 3 },
    { id: messageId("004-final"), role: "assistant" as const, created: now + 4 },
    { id: messageId("005-user"), role: "user" as const, created: now + 5 },
    { id: messageId("006-tool-search"), role: "assistant" as const, created: now + 6 },
    { id: messageId("007-comment"), role: "assistant" as const, created: now + 7 },
    { id: messageId("008-reasoning"), role: "assistant" as const, created: now + 8 },
    { id: messageId("009-tool-edit"), role: "assistant" as const, created: now + 9 },
    { id: messageId("010-comment"), role: "assistant" as const, created: now + 10 },
    { id: messageId("011-tool-test"), role: "assistant" as const, created: now + 11 },
    { id: messageId("012-final"), role: "assistant" as const, created: now + 12 },
  ];

  const parts = [
    {
      id: `${messageId("001-user")}-part`,
      messageId: messageId("001-user"),
      part: { type: "text", text: "User turn 1 sentinel: inspect the current transcript renderer." },
    },
    {
      id: `${messageId("002-tool-read")}-part`,
      messageId: messageId("002-tool-read"),
      part: {
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: "packages/app/src/app/components/session/message-list.tsx" } },
      },
    },
    {
      id: `${messageId("003-comment")}-part`,
      messageId: messageId("003-comment"),
      part: { type: "text", text: "Progress comment turn 1 sentinel: I found the renderer entry point." },
    },
    {
      id: `${messageId("004-final")}-part`,
      messageId: messageId("004-final"),
      part: { type: "text", text: "Final answer turn 1 sentinel: the renderer path is mapped." },
    },
    {
      id: `${messageId("005-user")}-part`,
      messageId: messageId("005-user"),
      part: { type: "text", text: "User turn 2 sentinel: implement VSLO-193 and keep progress visible." },
    },
    {
      id: `${messageId("006-tool-search")}-part`,
      messageId: messageId("006-tool-search"),
      part: {
        type: "tool",
        tool: "grep",
        state: { status: "completed", input: { pattern: "session-progress-group" } },
      },
    },
    {
      id: `${messageId("007-comment")}-part`,
      messageId: messageId("007-comment"),
      part: { type: "text", text: "Progress comment turn 2 sentinel: grouping comments and actions before the final answer." },
    },
    {
      id: `${messageId("008-reasoning")}-part`,
      messageId: messageId("008-reasoning"),
      part: { type: "reasoning", text: "Hidden reasoning sentinel VSLO-193." },
    },
    {
      id: `${messageId("009-tool-edit")}-part`,
      messageId: messageId("009-tool-edit"),
      part: {
        type: "tool",
        tool: "edit",
        state: { status: "completed", input: { filePath: "packages/app/src/app/components/session/progress-grouping-model.ts" } },
      },
    },
    {
      id: `${messageId("010-comment")}-part`,
      messageId: messageId("010-comment"),
      part: { type: "text", text: "Progress comment turn 2 sentinel: the final answer boundary is now clear." },
    },
    {
      id: `${messageId("011-tool-test")}-part`,
      messageId: messageId("011-tool-test"),
      part: {
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "pnpm --filter @neatech/veslo-ui test:unit" },
        },
      },
    },
    {
      id: `${messageId("012-final")}-part`,
      messageId: messageId("012-final"),
      part: { type: "text", text: "Final answer turn 2 sentinel: progress grouping is implemented." },
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

async function transcriptBlocks(): Promise<Array<{ role: string | null; kind: string; text: string }>> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll("[data-message-role]")).map((node) => {
      const element = node as HTMLElement;
      return {
        role: element.getAttribute("data-message-role"),
        kind: element.querySelector('[data-testid="session-progress-group"]') ? "progress" : "message",
        text: element.innerText,
      };
    }),
  );
}

describe("Session progress grouping", () => {
  it("renders a completed multi-turn chat with turn-scoped collapsible progress before each final answer", async function () {
    if (!hasSqlite3()) {
      this.skip();
    }

    const sessionId = seedProgressGroupingSession();

    await navigateToHash(`/session/${sessionId}`);
    await waitForHashRoute(`#/session/${sessionId}`, WAIT_TIMEOUT_MS);

    await browser.waitUntil(
      async () => (await bodyText()).includes("Final answer turn 2 sentinel: progress grouping is implemented."),
      {
        timeout: WAIT_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "Seeded final answer did not render in the desktop session transcript.",
      },
    );

    const collapsedBlocks = await transcriptBlocks();
    expect(collapsedBlocks.map((block) => `${block.role}:${block.kind}`)).toEqual([
      "user:message",
      "assistant:progress",
      "assistant:message",
      "user:message",
      "assistant:progress",
      "assistant:message",
    ]);
    expect(collapsedBlocks[0]?.text).toContain("User turn 1 sentinel");
    expect(collapsedBlocks[1]?.text).not.toContain("Progress comment turn 1 sentinel");
    expect(collapsedBlocks[2]?.text).toContain("Final answer turn 1 sentinel");
    expect(collapsedBlocks[3]?.text).toContain("User turn 2 sentinel");
    expect(collapsedBlocks[4]?.text).not.toContain("Progress comment turn 2 sentinel");
    expect(collapsedBlocks[5]?.text).toContain("Final answer turn 2 sentinel");

    const collapsedText = await bodyText();
    expect(collapsedText).toContain("Final answer turn 1 sentinel: the renderer path is mapped.");
    expect(collapsedText).toContain("Final answer turn 2 sentinel: progress grouping is implemented.");
    expect(collapsedText).not.toContain("Progress comment turn 1 sentinel");
    expect(collapsedText).not.toContain("Progress comment turn 2 sentinel");
    expect(collapsedText).not.toContain("Hidden reasoning sentinel VSLO-193.");

    const groups = await $$('[data-testid="session-progress-group"]');
    expect(groups.length).toBe(2);
    await groups[1]!.$("button").click();

    await browser.waitUntil(
      async () => (await bodyText()).includes("Progress comment turn 2 sentinel: grouping comments and actions before the final answer."),
      {
        timeout: WAIT_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "Expanded progress group did not show the intermediate assistant comment.",
      },
    );

    const expandedGroups = await $$('[data-testid="session-progress-group"]');
    const expandedSecondGroup = expandedGroups[1]!;
    const expandedSecondGroupText = await expandedSecondGroup.getText();
    expect(expandedSecondGroupText).toContain("Progress comment turn 2 sentinel: grouping comments and actions before the final answer.");
    expect(expandedSecondGroupText).toContain("Progress comment turn 2 sentinel: the final answer boundary is now clear.");
    expect(expandedSecondGroupText).toContain("session-progress-group");
    expect(expandedSecondGroupText).toContain("progress-grouping-model.ts");
    expect(expandedSecondGroupText).toContain("Run pnpm --filter @neatech/veslo-ui");
    expect(expandedSecondGroupText).not.toContain("Technical detail");
    expect(expandedSecondGroupText).not.toContain("Hidden reasoning sentinel VSLO-193.");
    expect((await expandedSecondGroup.$$('[data-testid="session-progress-comment"]')).length).toBe(2);
    const commentStyles = await browser.execute(() =>
      Array.from(document.querySelectorAll('[data-testid="session-progress-comment"]')).map((node) => {
        const style = window.getComputedStyle(node as HTMLElement);
        return {
          backgroundColor: style.backgroundColor,
          borderRadius: style.borderRadius,
          borderTopWidth: style.borderTopWidth,
        };
      }),
    );
    expect(commentStyles.every((style) => style.backgroundColor === "rgba(0, 0, 0, 0)")).toBe(true);
    expect(commentStyles.every((style) => style.borderRadius === "0px")).toBe(true);
    expect(commentStyles.every((style) => style.borderTopWidth === "0px")).toBe(true);
    expect((await expandedSecondGroup.$$('[data-testid="session-progress-step-group"]')).length).toBe(3);
    expect((await expandedSecondGroup.$$('[data-testid="session-progress-row"]')).length).toBe(0);
    expect((await expandedSecondGroup.$$("details")).length).toBe(0);

    await (await expandedSecondGroup.$$('[data-testid="session-progress-step-group"]'))[0]!.$("button").click();
    await browser.waitUntil(
      async () => (await (await $$('[data-testid="session-progress-group"]'))[1]!.getText()).includes("Technical detail"),
      {
        timeout: WAIT_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "Nested progress action did not expand to show its detail.",
      },
    );

    const expandedNestedGroupText = await (await $$('[data-testid="session-progress-group"]'))[1]!.getText();
    expect(expandedNestedGroupText).toContain("Technical detail");
    expect((await (await $$('[data-testid="session-progress-group"]'))[1]!.$$('[data-testid="session-progress-row"]')).length).toBeGreaterThan(0);
    expect(expandedNestedGroupText).not.toContain("Hidden reasoning sentinel VSLO-193.");

    const expandedText = await bodyText();
    expect(expandedText).not.toContain("Progress comment turn 1 sentinel");
    expect(expandedText).toContain("Final answer turn 1 sentinel: the renderer path is mapped.");
    expect(expandedText).toContain("Final answer turn 2 sentinel: progress grouping is implemented.");
    expect(expandedText).not.toContain("Hidden reasoning sentinel VSLO-193.");

    await (await $$('[data-testid="session-progress-group"]'))[1]!.$("button").click();
    await browser.waitUntil(
      async () => !(await bodyText()).includes("Progress comment turn 2 sentinel: grouping comments and actions before the final answer."),
      {
        timeout: WAIT_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: "Collapsed progress group still showed the intermediate assistant comment.",
      },
    );

    const recollapsedText = await bodyText();
    expect(recollapsedText).toContain("Final answer turn 2 sentinel: progress grouping is implemented.");
    expect(recollapsedText).not.toContain("Progress comment turn 2 sentinel");
    expect(recollapsedText).not.toContain("Hidden reasoning sentinel VSLO-193.");
  });
});
