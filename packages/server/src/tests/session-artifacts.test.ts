import { mkdtemp, rm } from "node:fs/promises";
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

const runningServers: Array<{ stop?: (closeActiveConnections?: boolean) => void }> = [];

afterEach(async () => {
  while (runningServers.length > 0) {
    const server = runningServers.pop();
    try {
      server?.stop?.(true);
    } catch {
      // ignore
    }
  }
});

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
          toolPart("read", { path: "/Users/vaclavsoukup/project/notes.md" }),
        ),
      ),
    );

    expect(files(artifacts).map((artifact) => [artifact.kind, artifact.path])).toEqual([
      ["file_discovered", "/Users/vaclavsoukup/project/notes.md"],
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
  test("returns typed artifacts for the latest session run via Veslo server", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-session-artifacts-"));
    const sessionId = "sess_1";

    try {
      const upstream = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === `/session/${sessionId}/message`) {
            return Response.json([
              {
                info: { id: "msg-old-user", role: "user" },
                parts: [{ type: "text", text: "old run" }],
              },
              {
                info: { id: "msg-old-assistant", role: "assistant" },
                parts: [{ type: "tool", tool: "skill", title: "brainstorming", sourceName: "brainstorming" }],
              },
              {
                info: { id: "msg-new-user", role: "user" },
                parts: [{ type: "text", text: "latest run" }],
              },
              {
                info: { id: "msg-new-assistant", role: "assistant" },
                parts: [
                  { type: "tool", tool: "read", state: { input: { path: "src/app.ts" } } },
                  { type: "tool", tool: "chrome-devtools.evaluate", server: "chrome-devtools", title: "Chrome DevTools" },
                  { type: "tool", tool: "read", state: { input: { path: ".opencode/soul.md" } } },
                ],
              },
            ]);
          }
          return new Response("not found", { status: 404 });
        },
      });
      runningServers.push(upstream as { stop?: (closeActiveConnections?: boolean) => void });

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
            baseUrl: `http://127.0.0.1:${upstream.port}`,
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

      const response = await fetch(
        `http://127.0.0.1:${server.port}/workspace/ws_1/sessions/${sessionId}/artifacts/latest-run`,
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
      expect(payload.runId).toBe("msg-new-user");

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
});
