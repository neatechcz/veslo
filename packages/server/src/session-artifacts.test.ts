import { describe, expect, test } from "bun:test";

import { deriveLatestRunArtifacts } from "./session-artifacts.js";

type FixturePart =
  | { type: "text"; text: string }
  | {
      type: "tool";
      tool: string;
      path?: string;
      sourceName?: string;
      target?: string;
      server?: string;
      title?: string;
      text?: string;
    };

type FixtureMessage = {
  id: string;
  parts: FixturePart[];
};

type FixtureRun = {
  id: string;
  messages: FixtureMessage[];
};

type FixtureSession = {
  sessionId: string;
  workspaceId: string;
  runs: FixtureRun[];
};

const textPart = (text: string): FixturePart => ({ type: "text", text });

const toolPart = (tool: string, props: Omit<Extract<FixturePart, { type: "tool" }>, "type" | "tool"> = {}): FixturePart => ({
  type: "tool",
  tool,
  ...props,
});

const run = (id: string, ...parts: FixturePart[]): FixtureRun => ({
  id,
  messages: [
    {
      id: `${id}:message-1`,
      parts,
    },
  ],
});

const session = (...runs: FixtureRun[]): FixtureSession => ({
  sessionId: "sess_1",
  workspaceId: "ws_1",
  runs,
});

const kinds = (artifacts: Array<{ kind: string }>) => artifacts.map((artifact) => artifact.kind);

const families = (artifacts: Array<{ family: string }>) => artifacts.map((artifact) => artifact.family);

const files = (artifacts: Array<{ family: string; path?: string; kind: string }>) =>
  artifacts.filter((artifact) => artifact.family === "files");

describe("deriveLatestRunArtifacts", () => {
  test("derives file_discovered artifacts from read/search/list/glob activity", () => {
    const artifacts = deriveLatestRunArtifacts(
      session(
        run(
          "run_1",
          toolPart("read", { path: "src/app.ts" }),
          toolPart("search", { path: "docs/guide.md" }),
          toolPart("list", { path: "packages/app/src" }),
          toolPart("glob", { path: "packages/server/src/**/*.ts" }),
        ),
      ),
    );

    expect(files(artifacts).map((artifact) => [artifact.kind, artifact.path])).toEqual([
      ["file_discovered", "src/app.ts"],
      ["file_discovered", "docs/guide.md"],
      ["file_discovered", "packages/app/src"],
      ["file_discovered", "packages/server/src/**/*.ts"],
    ]);
  });

  test("derives file_output artifacts from write/edit/apply-patch activity", () => {
    const artifacts = deriveLatestRunArtifacts(
      session(
        run(
          "run_1",
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

  test("derives skill_used artifacts from explicit skill tool usage", () => {
    const artifacts = deriveLatestRunArtifacts(
      session(run("run_1", toolPart("skill", { title: "brainstorming", sourceName: "brainstorming" }))),
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
      session(run("run_1", toolPart("chrome-devtools.evaluate", { server: "chrome-devtools", title: "Chrome DevTools" }))),
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
      session(run("run_1", toolPart("soul.memory"), toolPart("soul.heartbeat"))),
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
      session(run("run_1", toolPart("soul.memory"), toolPart("soul.heartbeat"))),
    );

    expect(families(artifacts)).toContain("soul");
    expect(kinds(artifacts)).toEqual(["soul_memory_used", "heartbeat_used"]);
  });

  test("does not turn SKILL.md, internal prompts, AGENTS.md, or .opencode plumbing into generic Files artifacts", () => {
    const artifacts = deriveLatestRunArtifacts(
      session(
        run(
          "run_1",
          toolPart("read", { path: ".opencode/skills/brainstorming/SKILL.md" }),
          toolPart("search", { path: ".opencode/veslo/internal/skill-creator/SKILL.md" }),
          toolPart("glob", { path: "AGENTS.md" }),
          toolPart("list", { path: ".opencode" }),
          toolPart("read", { path: "prompts/internal-review.md" }),
        ),
      ),
    );

    expect(files(artifacts)).toEqual([]);
  });

  test("uses only the most recent run boundary when deriving artifacts", () => {
    const artifacts = deriveLatestRunArtifacts(
      session(
        run(
          "run_1",
          toolPart("read", { path: "old/file.md" }),
          toolPart("write", { path: "old/output.md" }),
          toolPart("skill", { title: "brainstorming" }),
        ),
        run("run_2", toolPart("skill", { title: "requesting-code-review" }), textPart("latest run prompt")),
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
