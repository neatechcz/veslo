import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { deriveLatestRunArtifacts } from "../session-artifacts.js";
import { startServer } from "../server.js";

type FixturePart =
  | { type: "text"; text: string }
  | {
      type: "tool";
      tool: string;
      path?: string;
      files?: string[];
      sourceName?: string;
      target?: string;
      server?: string;
      title?: string;
      text?: string;
      state?: { input?: Record<string, unknown>; output?: string };
    };

type FixtureMessage = {
  id: string;
  role: "user" | "assistant";
  parts: FixturePart[];
};

type FixtureSession = {
  sessionId: string;
  workspaceId: string;
  messages: FixtureMessage[];
};

const textPart = (text: string): FixturePart => ({ type: "text", text });

const toolPart = (tool: string, props: Omit<Extract<FixturePart, { type: "tool" }>, "type" | "tool"> = {}): FixturePart => ({
  type: "tool",
  tool,
  ...props,
});

const userMessage = (id: string, text: string): FixtureMessage => ({
  id,
  role: "user",
  parts: [textPart(text)],
});

const assistantMessage = (id: string, ...parts: FixturePart[]): FixtureMessage => ({
  id,
  role: "assistant",
  parts,
});

const session = (...messages: FixtureMessage[]): FixtureSession => ({
  sessionId: "sess_1",
  workspaceId: "ws_1",
  messages,
});

const kinds = (artifacts: Array<{ kind: string }>) => artifacts.map((artifact) => artifact.kind);

const families = (artifacts: Array<{ family: string }>) => artifacts.map((artifact) => artifact.family);

const files = (artifacts: Array<{ family: string; path?: string; kind: string }>) =>
  artifacts.filter((artifact) => artifact.family === "files");

const toWslMountPath = (path: string) => {
  const normalized = path.replace(/\\/g, "/");
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (!match) return normalized;
  return `/mnt/${match[1]?.toLowerCase()}/${match[2] ?? ""}`;
};

const runningServers: Array<{ stop?: (closeActiveConnections?: boolean) => void }> = [];
const tempDirs: string[] = [];
const envRestores: Array<() => void> = [];

afterEach(async () => {
  while (runningServers.length > 0) {
    const server = runningServers.pop();
    try {
      server?.stop?.(true);
    } catch {
      // ignore
    }
  }
  while (envRestores.length > 0) {
    envRestores.pop()?.();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

const useTempVesloDataDir = async (prefix: string) => {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dataDir);
  const previous = process.env.VESLO_DATA_DIR;
  process.env.VESLO_DATA_DIR = dataDir;
  envRestores.push(() => {
    if (previous === undefined) {
      delete process.env.VESLO_DATA_DIR;
    } else {
      process.env.VESLO_DATA_DIR = previous;
    }
  });
  return dataDir;
};

const appendHostTranscript = async (input: {
  port: number;
  workspaceId: string;
  sessionId: string;
  directory: string;
  messages: Array<Record<string, unknown>>;
  partsByMessageId: Record<string, unknown[]>;
}) => {
  const response = await fetch(
    `http://127.0.0.1:${input.port}/workspace/${input.workspaceId}/sessions/${input.sessionId}/transcript`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer client-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        directory: input.directory,
        limit: input.messages.length,
        messages: input.messages,
        partsByMessageId: input.partsByMessageId,
      }),
    },
  );
  expect(response.status).toBe(200);
};

describe("deriveLatestRunArtifacts", () => {
  test("derives file_discovered artifacts only from concrete workspace files the run opened", () => {
    const artifacts = deriveLatestRunArtifacts(
      session(
        userMessage("msg_1", "Inspect the relevant files."),
        assistantMessage(
          "msg_2",
          toolPart("read", { path: "src/app.ts" }),
          toolPart("search", { files: ["docs/guide.md"] }),
          toolPart("list", { files: ["packages/app/src/app.tsx"] }),
          toolPart("glob", { files: ["packages/server/src/server.ts"] }),
        ),
      ),
    );

    expect(files(artifacts).map((artifact) => [artifact.kind, artifact.path])).toEqual([
      ["file_discovered", "src/app.ts"],
    ]);
  });

  test("derives opened file artifacts only from explicit read activity", () => {
    const artifacts = deriveLatestRunArtifacts(
      session(
        userMessage("msg_1", "Inspect the relevant files."),
        assistantMessage(
          "msg_2",
          toolPart("read", { path: "src/opened.ts" }),
          toolPart("search", { state: { input: { files: ["src/search-result.ts"] } } }),
          toolPart("list", { state: { input: { paths: ["src/list-result.ts"] } } }),
          toolPart("glob", { state: { input: { files: ["src/glob-result.ts"] } } }),
        ),
      ),
    );

    expect(files(artifacts).map((artifact) => [artifact.kind, artifact.path])).toEqual([
      ["file_discovered", "src/opened.ts"],
    ]);
  });

  test("does not derive file artifacts from search list or glob exploration", () => {
    const artifacts = deriveLatestRunArtifacts(
      session(
        userMessage("msg_1", "Find likely files."),
        assistantMessage(
          "msg_2",
          toolPart("search", { state: { input: { files: ["src/search-result.ts"] } } }),
          toolPart("list", { state: { input: { paths: ["src/list-result.ts"] } } }),
          toolPart("glob", { state: { input: { files: ["src/glob-result.ts"] } } }),
        ),
      ),
    );

    expect(files(artifacts)).toEqual([]);
  });

  test("modified file artifacts win over opened duplicates", () => {
    const artifacts = deriveLatestRunArtifacts(
      session(
        userMessage("msg_1", "Open and update the same file."),
        assistantMessage(
          "msg_2",
          toolPart("edit", { path: "src/app.ts" }),
          toolPart("read", { path: "src/app.ts" }),
        ),
      ),
    );

    expect(files(artifacts).map((artifact) => [artifact.kind, artifact.path])).toEqual([
      ["file_output", "src/app.ts"],
    ]);
  });

  test("preserves absolute unix paths for file artifacts", () => {
    const artifacts = deriveLatestRunArtifacts(
      session(
        userMessage("msg_1", "Inspect the file."),
        assistantMessage(
          "msg_2",
          toolPart("read", { path: "/tmp/veslo-artifact-fixture/project/notes.md" }),
        ),
      ),
    );

    expect(files(artifacts).map((artifact) => [artifact.kind, artifact.path])).toEqual([
      ["file_discovered", "/tmp/veslo-artifact-fixture/project/notes.md"],
    ]);
  });

  test("maps WSL and host absolute artifact paths to workspace-relative files when workspace root is known", () => {
    const artifacts = deriveLatestRunArtifacts(
      session(
        userMessage("msg_1", "Inspect and update files."),
        assistantMessage(
          "msg_2",
          toolPart("read", { path: "/workspace/src/opened.ts" }),
          toolPart("write", { path: "C:\\Users\\alice\\AppData\\Local\\Veslo\\fixtures\\artifact-workspace\\src\\changed.ts" }),
          toolPart("edit", { path: "/mnt/c/Users/alice/AppData/Local/Veslo/fixtures/artifact-workspace/src/from-wsl-mount.ts" }),
        ),
      ),
      { workspaceRoot: "C:\\Users\\alice\\AppData\\Local\\Veslo\\fixtures\\artifact-workspace" },
    );

    expect(files(artifacts).map((artifact) => [artifact.kind, artifact.path])).toEqual([
      ["file_discovered", "src/opened.ts"],
      ["file_output", "src/changed.ts"],
      ["file_output", "src/from-wsl-mount.ts"],
    ]);
  });

  test("drops absolute file artifacts outside the known workspace root", () => {
    const artifacts = deriveLatestRunArtifacts(
      session(
        userMessage("msg_1", "Inspect files."),
        assistantMessage(
          "msg_2",
          toolPart("read", { path: "/tmp/veslo-artifact-fixture/project/src/inside.ts" }),
          toolPart("read", { path: "/tmp/veslo-artifact-fixture/other/outside.ts" }),
          toolPart("write", { path: "D:/outside/result.ts" }),
        ),
      ),
      { workspaceRoot: "/tmp/veslo-artifact-fixture/project" },
    );

    expect(files(artifacts).map((artifact) => [artifact.kind, artifact.path])).toEqual([
      ["file_discovered", "src/inside.ts"],
    ]);
  });

  test("derives file_output artifacts from write/edit/apply-patch activity", () => {
    const artifacts = deriveLatestRunArtifacts(
      session(
        userMessage("msg_1", "Make the requested edits."),
        assistantMessage(
          "msg_2",
          toolPart("write", { path: "src/output.md" }),
          toolPart("edit", { path: "src/app.ts" }),
          toolPart("apply_patch", { path: "packages/server/src/server.ts" }),
        ),
      ),
    );

    expect(files(artifacts).map((artifact) => [artifact.kind, artifact.path])).toEqual([
      ["file_output", "src/output.md"],
      ["file_output", "src/app.ts"],
      ["file_output", "packages/server/src/server.ts"],
    ]);
  });

  test("derives apply_patch file outputs from patch input headers", () => {
    const artifacts = deriveLatestRunArtifacts(
      session(
        userMessage("msg_1", "Patch the requested files."),
        assistantMessage(
          "msg_2",
          toolPart("apply_patch", {
            state: {
              input: {
                patch: [
                  "*** Begin Patch",
                  "*** Update File: src/patched.ts",
                  "@@",
                  "-export const value = 1;",
                  "+export const value = 2;",
                  "*** End Patch",
                ].join("\n"),
              },
            },
          }),
          toolPart("apply_patch", {
            state: {
              input: {
                patch: [
                  "*** Begin Patch",
                  "*** Update File: src/old-name.ts",
                  "*** Move to: src/new-name.ts",
                  "@@",
                  "-export const name = 'old';",
                  "+export const name = 'new';",
                  "*** End Patch",
                ].join("\n"),
              },
            },
          }),
        ),
      ),
    );

    expect(files(artifacts).map((artifact) => [artifact.kind, artifact.path])).toEqual([
      ["file_output", "src/patched.ts"],
      ["file_output", "src/new-name.ts"],
    ]);
    expect(files(artifacts).some((artifact) => artifact.path === "src/old-name.ts")).toBe(false);
  });

  test("derives skill_used artifacts from explicit skill tool usage", () => {
    const artifacts = deriveLatestRunArtifacts(
      session(
        userMessage("msg_1", "Think through the design."),
        assistantMessage("msg_2", toolPart("skill", { title: "brainstorming", sourceName: "brainstorming" })),
      ),
    );

    expect(artifacts).toEqual([
      expect.objectContaining({
        family: "skills",
        kind: "skill_used",
        title: "brainstorming",
      }),
    ]);
  });

  test("derives mcp_used artifacts from a concrete MCP-backed Chrome DevTools call", () => {
    const artifacts = deriveLatestRunArtifacts(
      session(
        userMessage("msg_1", "Inspect the browser page."),
        assistantMessage("msg_2", toolPart("chrome-devtools.evaluate", { server: "chrome-devtools", title: "Chrome DevTools" })),
      ),
    );

    expect(artifacts).toEqual([
      expect.objectContaining({
        family: "mcp",
        kind: "mcp_used",
        title: "Chrome DevTools",
        sourceName: "chrome-devtools",
      }),
    ]);
  });

  test("keeps soul_memory_used and heartbeat_used separate internally", () => {
    const artifacts = deriveLatestRunArtifacts(
      session(
        userMessage("msg_1", "Review Soul state."),
        assistantMessage(
          "msg_2",
          toolPart("read", { path: ".opencode/soul.md" }),
          toolPart("write", { path: ".opencode/soul/heartbeat.jsonl" }),
        ),
      ),
    );

    expect(artifacts).toEqual([
      expect.objectContaining({
        family: "soul",
        kind: "soul_memory_used",
      }),
      expect.objectContaining({
        family: "soul",
        kind: "heartbeat_used",
      }),
    ]);
  });

  test("treats Soul as eligible when memory and heartbeat appear in one run", () => {
    const artifacts = deriveLatestRunArtifacts(
      session(
        userMessage("msg_1", "Refresh Soul."),
        assistantMessage(
          "msg_2",
          toolPart("read", { path: ".opencode/soul.md" }),
          toolPart("write", { path: ".opencode/soul/heartbeat.jsonl" }),
        ),
      ),
    );

    expect(families(artifacts)).toContain("soul");
    expect(kinds(artifacts)).toEqual(["soul_memory_used", "heartbeat_used"]);
    expect(files(artifacts)).toEqual([]);
  });

  test("maps WSL Soul paths before classifying semantic Soul artifacts", () => {
    const artifacts = deriveLatestRunArtifacts(
      session(
        userMessage("msg_1", "Refresh Soul."),
        assistantMessage(
          "msg_2",
          toolPart("read", { path: "/workspace/.opencode/soul.md" }),
          toolPart("write", { path: "/workspace/.opencode/soul/heartbeat.jsonl" }),
        ),
      ),
      { workspaceRoot: "C:\\Users\\alice\\AppData\\Local\\Veslo\\fixtures\\artifact-workspace" },
    );

    expect(kinds(artifacts)).toEqual(["soul_memory_used", "heartbeat_used"]);
    expect(files(artifacts)).toEqual([]);
  });

  test("does not turn SKILL.md, internal prompts, AGENTS.md, or .opencode plumbing into generic Files artifacts", () => {
    const artifacts = deriveLatestRunArtifacts(
      session(
        userMessage("msg_1", "Inspect the internal setup."),
        assistantMessage(
          "msg_2",
          toolPart("read", { path: ".opencode/skills/brainstorming/SKILL.md" }),
          toolPart("search", { path: ".opencode/veslo/internal/skill-creator/SKILL.md" }),
          toolPart("glob", { path: "AGENTS.md" }),
          toolPart("list", { path: ".opencode" }),
          toolPart("read", { path: ".opencode/veslo/internal/prompts/internal-review.md" }),
        ),
      ),
    );

    expect(files(artifacts)).toEqual([]);
  });

  test("uses only the most recent run boundary when deriving artifacts", () => {
    const artifacts = deriveLatestRunArtifacts(
      session(
        userMessage("msg_1", "Inspect the older files."),
        assistantMessage(
          "msg_2",
          toolPart("read", { path: "old/file.md" }),
          toolPart("write", { path: "old/output.md" }),
          toolPart("skill", { title: "brainstorming" }),
        ),
        userMessage("msg_3", "Do a review pass."),
        assistantMessage("msg_4", toolPart("skill", { title: "requesting-code-review" }), textPart("latest run prompt")),
      ),
    );

    expect(kinds(artifacts)).toEqual(["skill_used"]);
    expect(artifacts).toEqual([
      expect.objectContaining({
        family: "skills",
        kind: "skill_used",
        title: "requesting-code-review",
      }),
    ]);
    expect(files(artifacts).map((artifact) => artifact.path)).toEqual([]);
    expect(artifacts.some((artifact) => artifact.path === "old/file.md" || artifact.path === "old/output.md")).toBe(false);
  });
});

describe("latest-run artifact route", () => {
  test("returns typed artifacts for the latest session run from the host transcript store", async () => {
    await useTempVesloDataDir("veslo-session-artifacts-data-");
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-session-artifacts-"));
    const sessionId = "sess_1";

    try {
      const server = startServer({
        host: "127.0.0.1",
        port: 0,
        token: "client-token",
        hostToken: "host-token",
        approval: { mode: "auto", timeoutMs: 1_000 },
        corsOrigins: ["*"],
        workspaces: [
          {
            id: "ws_1",
            name: "Workspace",
            path: workspaceRoot,
            workspaceType: "local",
          },
        ],
        authorizedRoots: [workspaceRoot],
        readOnly: false,
        startedAt: Date.now(),
        tokenSource: "cli",
        hostTokenSource: "cli",
        logFormat: "pretty",
        logRequests: false,
        debugLogs: {
          enabled: false,
          ingestUrl: null,
          ingestToken: null,
          batchMaxEvents: 200,
          batchMaxBytes: 256 * 1024,
          spoolMaxBytes: 100 * 1024 * 1024,
          flushIntervalMs: 5000,
        },
      });
      runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });

      await appendHostTranscript({
        port: server.port,
        workspaceId: "ws_1",
        sessionId,
        directory: workspaceRoot,
        messages: [
          { id: "msg-001-user", sessionID: sessionId, role: "user" },
          { id: "msg-002-assistant", sessionID: sessionId, role: "assistant" },
          { id: "msg-003-user", sessionID: sessionId, role: "user" },
          { id: "msg-004-assistant", sessionID: sessionId, role: "assistant" },
        ],
        partsByMessageId: {
          "msg-001-user": [{ id: "part-001", type: "text", text: "old run" }],
          "msg-002-assistant": [
            { id: "part-002", type: "tool", tool: "skill", title: "brainstorming", sourceName: "brainstorming" },
          ],
          "msg-003-user": [{ id: "part-003", type: "text", text: "latest run" }],
          "msg-004-assistant": [
            { id: "part-004", type: "tool", tool: "read", state: { input: { path: "src/app.ts" } } },
            { id: "part-005", type: "tool", tool: "chrome-devtools.evaluate", server: "chrome-devtools", title: "Chrome DevTools" },
            { id: "part-006", type: "tool", tool: "read", state: { input: { path: ".opencode/soul.md" } } },
          ],
        },
      });

      const response = await fetch(
        `http://127.0.0.1:${server.port}/workspace/ws_1/sessions/${sessionId}/artifacts/latest-run?directory=${encodeURIComponent(workspaceRoot)}`,
        {
          headers: { Authorization: "Bearer client-token" },
        },
      );

      expect(response.status).toBe(200);
      const payload = await response.json() as {
        sessionId: string;
        workspaceId: string;
        runId: string | null;
        items: Array<{ family: string; kind: string; status: string; path?: string; title?: string }>;
      };

      expect(payload.sessionId).toBe(sessionId);
      expect(payload.workspaceId).toBe("ws_1");
      expect(payload.runId).toBe("msg-003-user");

      expect(payload.items).toEqual([
        expect.objectContaining({
          family: "files",
          kind: "file_discovered",
          status: "scanned",
          path: "src/app.ts",
        }),
        expect.objectContaining({
          family: "mcp",
          kind: "mcp_used",
          status: "used",
          title: "Chrome DevTools",
        }),
        expect.objectContaining({
          family: "soul",
          kind: "soul_memory_used",
          status: "used",
        }),
      ]);
      expect(payload.items.some((artifact) => artifact.title === "brainstorming")).toBe(false);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("accepts WSL mount directories and derives artifacts relative to the requested directory", async () => {
    if (process.platform !== "win32") return;

    await useTempVesloDataDir("veslo-session-artifacts-wsl-data-");
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-session-artifacts-wsl-"));
    const conversationDirectory = join(workspaceRoot, "nested");
    await mkdir(conversationDirectory, { recursive: true });
    const requestedDirectory = toWslMountPath(conversationDirectory);
    const sessionId = "sess_wsl";

    try {
      const server = startServer({
        host: "127.0.0.1",
        port: 0,
        token: "client-token",
        hostToken: "host-token",
        approval: { mode: "auto", timeoutMs: 1_000 },
        corsOrigins: ["*"],
        workspaces: [
          {
            id: "ws_1",
            name: "Workspace",
            path: workspaceRoot,
            workspaceType: "local",
          },
        ],
        authorizedRoots: [workspaceRoot],
        readOnly: false,
        startedAt: Date.now(),
        tokenSource: "cli",
        hostTokenSource: "cli",
        logFormat: "pretty",
        logRequests: false,
        debugLogs: {
          enabled: false,
          ingestUrl: null,
          ingestToken: null,
          batchMaxEvents: 200,
          batchMaxBytes: 256 * 1024,
          spoolMaxBytes: 100 * 1024 * 1024,
          flushIntervalMs: 5000,
        },
      });
      runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });

      await appendHostTranscript({
        port: server.port,
        workspaceId: "ws_1",
        sessionId,
        directory: requestedDirectory,
        messages: [
          { id: "msg-001-user", sessionID: sessionId, role: "user" },
          { id: "msg-002-assistant", sessionID: sessionId, role: "assistant" },
        ],
        partsByMessageId: {
          "msg-001-user": [{ id: "part-001", type: "text", text: "latest run" }],
          "msg-002-assistant": [
            {
              id: "part-002",
              type: "tool",
              tool: "read",
              state: {
                input: {
                  path: `${requestedDirectory}/src/from-wsl.ts`,
                },
              },
            },
          ],
        },
      });

      const response = await fetch(
        `http://127.0.0.1:${server.port}/workspace/ws_1/sessions/${sessionId}/artifacts/latest-run?directory=${encodeURIComponent(requestedDirectory)}`,
        {
          headers: { Authorization: "Bearer client-token" },
        },
      );

      expect(response.status).toBe(200);
      const payload = await response.json() as {
        items: Array<{ family: string; kind: string; path?: string }>;
      };

      expect(files(payload.items).map((artifact) => artifact.path)).toEqual(["src/from-wsl.ts"]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("maps /workspace directory requests to the effective OpenCode directory", async () => {
    await useTempVesloDataDir("veslo-session-artifacts-alias-data-");
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-session-artifacts-directory-root-"));
    const conversationDirectory = join(workspaceRoot, "opencode-working-dir");
    await mkdir(conversationDirectory, { recursive: true });
    const sessionId = "sess_directory_alias";

    try {
      const server = startServer({
        host: "127.0.0.1",
        port: 0,
        token: "client-token",
        hostToken: "host-token",
        approval: { mode: "auto", timeoutMs: 1_000 },
        corsOrigins: ["*"],
        workspaces: [
          {
            id: "ws_1",
            name: "Workspace",
            path: workspaceRoot,
            directory: conversationDirectory,
            workspaceType: "local",
          },
        ],
        authorizedRoots: [workspaceRoot],
        readOnly: false,
        startedAt: Date.now(),
        tokenSource: "cli",
        hostTokenSource: "cli",
        logFormat: "pretty",
        logRequests: false,
        debugLogs: {
          enabled: false,
          ingestUrl: null,
          ingestToken: null,
          batchMaxEvents: 200,
          batchMaxBytes: 256 * 1024,
          spoolMaxBytes: 100 * 1024 * 1024,
          flushIntervalMs: 5000,
        },
      });
      runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });

      await appendHostTranscript({
        port: server.port,
        workspaceId: "ws_1",
        sessionId,
        directory: "/workspace",
        messages: [
          { id: "msg-001-user", sessionID: sessionId, role: "user" },
          { id: "msg-002-assistant", sessionID: sessionId, role: "assistant" },
        ],
        partsByMessageId: {
          "msg-001-user": [{ id: "part-001", type: "text", text: "latest run" }],
          "msg-002-assistant": [
            { id: "part-002", type: "tool", tool: "read", state: { input: { path: "/workspace/src/from-alias.ts" } } },
          ],
        },
      });

      const response = await fetch(
        `http://127.0.0.1:${server.port}/workspace/ws_1/sessions/${sessionId}/artifacts/latest-run?directory=${encodeURIComponent("/workspace")}`,
        {
          headers: { Authorization: "Bearer client-token" },
        },
      );

      expect(response.status).toBe(200);
      const payload = await response.json() as {
        items: Array<{ family: string; kind: string; path?: string }>;
      };

      expect(files(payload.items).map((artifact) => artifact.path)).toEqual(["src/from-alias.ts"]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
