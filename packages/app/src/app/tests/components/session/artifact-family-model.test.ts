import assert from "node:assert/strict";
import test from "node:test";

import type { VesloSessionArtifactItem } from "../../../lib/veslo-server";
import { buildArtifactFamilies, resolveArtifactFamilies } from "../../../components/session/artifact-family-model.js";

type ArtifactFixture = Omit<VesloSessionArtifactItem, "sessionId" | "workspaceId" | "runId"> &
  Partial<Pick<VesloSessionArtifactItem, "sessionId" | "workspaceId" | "runId">>;

const artifact = (fixture: ArtifactFixture): VesloSessionArtifactItem => ({
  sessionId: "sess_1",
  workspaceId: "ws_1",
  runId: "run_1",
  ...fixture,
});

const familyLabel = (family: Record<string, unknown>) =>
  String(family.label ?? family.name ?? family.family ?? family.kind ?? "");

const familyItems = (family: Record<string, unknown>) => {
  const items = family.items;
  return Array.isArray(items) ? items : [];
};

const familyKinds = (family: Record<string, unknown>) =>
  familyItems(family).map((item) => String((item as Record<string, unknown>).kind ?? ""));

const fileRows = (family: Record<string, unknown>) =>
  familyItems(family).map((item) => {
    const record = item as Record<string, unknown>;
    return {
      kind: String(record.kind ?? ""),
      path: String(record.path ?? ""),
      fileInteraction: String(record.fileInteraction ?? ""),
    };
  });

test("buildArtifactFamilies groups server latest-run artifacts into Files, Skills, MCP, and Soul families", () => {
  const families = buildArtifactFamilies({
    artifacts: [
      artifact({
        id: "files-updated",
        family: "files",
        kind: "file_output",
        status: "updated",
        title: "app.ts",
        path: "src/app.ts",
        timestamp: 120,
      }),
      artifact({
        id: "files-scanned",
        family: "files",
        kind: "file_discovered",
        status: "scanned",
        title: "guide.md",
        path: "docs/guide.md",
        timestamp: 100,
      }),
      artifact({
        id: "skill-1",
        family: "skills",
        kind: "skill_used",
        status: "used",
        title: "brainstorming",
        sourceName: "brainstorming",
        timestamp: 90,
      }),
      artifact({
        id: "mcp-1",
        family: "mcp",
        kind: "mcp_used",
        status: "used",
        title: "Chrome DevTools",
        sourceName: "chrome-devtools",
        timestamp: 80,
      }),
      artifact({
        id: "soul-memory",
        family: "soul",
        kind: "soul_memory_used",
        status: "active",
        title: "Soul memory",
        sourceName: "soul",
        timestamp: 70,
      }),
      artifact({
        id: "soul-heartbeat",
        family: "soul",
        kind: "heartbeat_used",
        status: "active",
        title: "Heartbeat",
        sourceName: "soul",
        timestamp: 60,
      }),
    ],
  });

  assert.deepEqual(families.map(familyLabel), ["Files", "Skills", "MCP", "Soul"]);
  assert.deepEqual(familyKinds(families[0] as Record<string, unknown>), ["file_output", "file_discovered"]);
  assert.deepEqual(familyKinds(families[3] as Record<string, unknown>), ["soul_memory_used", "heartbeat_used"]);
});

test("file artifacts carry modified and opened interactions for right menu grouping", () => {
  const families = buildArtifactFamilies({
    artifacts: [
      artifact({
        id: "opened",
        family: "files",
        kind: "file_discovered",
        status: "scanned",
        title: "opened.ts",
        path: "src/opened.ts",
        timestamp: 30,
      }),
      artifact({
        id: "modified",
        family: "files",
        kind: "file_output",
        status: "updated",
        title: "modified.ts",
        path: "src/modified.ts",
        timestamp: 10,
      }),
    ],
  });

  assert.deepEqual(fileRows(families[0] as Record<string, unknown>), [
    { kind: "file_output", path: "src/modified.ts", fileInteraction: "modified" },
    { kind: "file_discovered", path: "src/opened.ts", fileInteraction: "opened" },
  ]);
});

test("modified file artifacts replace opened duplicates in the app family model", () => {
  const families = buildArtifactFamilies({
    artifacts: [
      artifact({
        id: "opened",
        family: "files",
        kind: "file_discovered",
        status: "scanned",
        title: "app.ts",
        path: "src/app.ts",
        timestamp: 30,
      }),
      artifact({
        id: "modified",
        family: "files",
        kind: "file_output",
        status: "updated",
        title: "app.ts",
        path: "src/app.ts",
        timestamp: 20,
      }),
    ],
  });

  assert.deepEqual(fileRows(families[0] as Record<string, unknown>), [
    { kind: "file_output", path: "src/app.ts", fileInteraction: "modified" },
  ]);
});

test("same-rank file duplicates use the latest row when timestamps match", () => {
  const families = buildArtifactFamilies({
    artifacts: [
      artifact({
        id: "first",
        family: "files",
        kind: "file_output",
        status: "updated",
        title: "first.ts",
        path: "src/shared.ts",
        timestamp: 20,
      }),
      artifact({
        id: "second",
        family: "files",
        kind: "file_output",
        status: "updated",
        title: "second.ts",
        path: "src/shared.ts",
        timestamp: 20,
      }),
    ],
  });

  const [fileItem] = familyItems(families[0] as Record<string, unknown>) as Array<Record<string, unknown>>;
  assert.equal(fileItem.id, "second");
});

test("resolveArtifactFamilies falls back to legacy ArtifactItem data only when server artifacts are absent", () => {
  const legacyOnly = resolveArtifactFamilies({
    serverArtifacts: [],
    legacyArtifacts: [
      {
        id: "legacy-file",
        name: "notes.md",
        path: "notes.md",
        kind: "file",
      },
    ],
  });

  assert.deepEqual(legacyOnly.map(familyLabel), ["Files"]);
  assert.equal(familyItems(legacyOnly[0] as Record<string, unknown>).length, 1);

  const serverPreferred = resolveArtifactFamilies({
    serverArtifacts: [
      artifact({
        id: "skill-1",
        family: "skills",
        kind: "skill_used",
        status: "used",
        title: "requesting-code-review",
        sourceName: "requesting-code-review",
        timestamp: 90,
      }),
    ],
    legacyArtifacts: [
      {
        id: "legacy-file",
        name: "notes.md",
        path: "notes.md",
        kind: "file",
      },
    ],
  });

  assert.deepEqual(serverPreferred.map(familyLabel), ["Skills"]);
});

test("resolveArtifactFamilies maps legacy file interactions to server-like file artifacts", () => {
  const families = resolveArtifactFamilies({
    serverArtifacts: undefined,
    legacyArtifacts: [
      {
        id: "opened",
        name: "opened.ts",
        path: "src/opened.ts",
        kind: "file",
        fileInteraction: "opened",
      },
      {
        id: "modified",
        name: "modified.ts",
        path: "src/modified.ts",
        kind: "file",
        fileInteraction: "modified",
      },
    ],
  });

  assert.deepEqual(
    familyItems(families[0] as Record<string, unknown>).map((item) => {
      const record = item as Record<string, unknown>;
      return {
        kind: record.kind,
        status: record.status,
        path: record.path,
        fileInteraction: record.fileInteraction,
      };
    }),
    [
      {
        kind: "file_output",
        status: "updated",
        path: "src/modified.ts",
        fileInteraction: "modified",
      },
      {
        kind: "file_discovered",
        status: "scanned",
        path: "src/opened.ts",
        fileInteraction: "opened",
      },
    ],
  );
});

test("resolveArtifactFamilies keeps an empty server response authoritative when preferServerArtifacts is enabled", () => {
  const families = resolveArtifactFamilies({
    serverArtifacts: [],
    preferServerArtifacts: true,
    legacyArtifacts: [
      {
        id: "legacy-file",
        name: "notes.md",
        path: "notes.md",
        kind: "file",
      },
    ],
  });

  assert.deepEqual(families, []);
});

test("technical and noisy generic file paths do not create non-file families", () => {
  const families = buildArtifactFamilies({
    artifacts: [
      artifact({
        id: "skill-md",
        family: "files",
        kind: "file_discovered",
        status: "scanned",
        title: "SKILL.md",
        path: ".opencode/skills/brainstorming/SKILL.md",
        timestamp: 10,
      }),
      artifact({
        id: "agents-md",
        family: "files",
        kind: "file_discovered",
        status: "scanned",
        title: "AGENTS.md",
        path: "AGENTS.md",
        timestamp: 9,
      }),
      artifact({
        id: "soul-md",
        family: "files",
        kind: "file_discovered",
        status: "scanned",
        title: "soul.md",
        path: ".opencode/soul.md",
        timestamp: 8,
      }),
      artifact({
        id: "heartbeat-jsonl",
        family: "files",
        kind: "file_discovered",
        status: "scanned",
        title: "heartbeat.jsonl",
        path: ".opencode/soul/heartbeat.jsonl",
        timestamp: 7,
      }),
    ],
  });

  assert.ok(families.length === 0 || families.every((family) => familyLabel(family as Record<string, unknown>) === "Files"));
});

test("absolute system paths outside workspace root are filtered from file artifacts", () => {
  const families = resolveArtifactFamilies({
    serverArtifacts: [
      artifact({
        id: "external-skill-md",
        family: "files",
        kind: "file_discovered",
        status: "scanned",
        title: "SKILL.md",
        path: "/Users/vaclavsoukup/.codex/skills/systematic-debugging/SKILL.md",
        timestamp: 20,
      }),
      artifact({
        id: "workspace-file",
        family: "files",
        kind: "file_discovered",
        status: "scanned",
        title: "session.tsx",
        path: "/Users/vaclavsoukup/AI agent projects/Veslo/packages/app/src/app/pages/session.tsx",
        timestamp: 10,
      }),
    ],
    preferServerArtifacts: true,
    workspaceRoot: "/Users/vaclavsoukup/AI agent projects/Veslo",
  });

  assert.deepEqual(families.map(familyLabel), ["Files"]);
  const filesFamily = families[0] as Record<string, unknown>;
  const paths = familyItems(filesFamily).map((item) => String((item as Record<string, unknown>).path ?? ""));
  assert.deepEqual(paths, ["packages/app/src/app/pages/session.tsx"]);
});

test("maps WSL and host absolute server artifact paths to workspace-relative file rows", () => {
  const families = resolveArtifactFamilies({
    serverArtifacts: [
      artifact({
        id: "wsl-workspace-file",
        family: "files",
        kind: "file_output",
        status: "updated",
        title: "changed.ts",
        path: "/workspace/src/changed.ts",
        timestamp: 30,
      }),
      artifact({
        id: "wsl-mount-file",
        family: "files",
        kind: "file_discovered",
        status: "scanned",
        title: "opened.md",
        path: "/mnt/c/Users/me/project/docs/opened.md",
        timestamp: 20,
      }),
      artifact({
        id: "host-file",
        family: "files",
        kind: "file_discovered",
        status: "scanned",
        title: "host.ts",
        path: "C:/Users/me/project/src/host.ts",
        timestamp: 10,
      }),
    ],
    preferServerArtifacts: true,
    workspaceRoot: "C:/Users/me/project",
  });

  assert.deepEqual(families.map(familyLabel), ["Files"]);
  const filesFamily = families[0] as Record<string, unknown>;
  const paths = familyItems(filesFamily).map((item) => String((item as Record<string, unknown>).path ?? "")).sort();
  assert.deepEqual(paths, ["docs/opened.md", "src/changed.ts", "src/host.ts"]);
});

test("maps WSL paths in legacy fallback artifacts", () => {
  const families = resolveArtifactFamilies({
    legacyArtifacts: [
      {
        id: "legacy-wsl",
        name: "changed.ts",
        path: "/workspace/src/changed.ts",
        kind: "file",
        fileInteraction: "modified",
      },
      {
        id: "legacy-mount",
        name: "opened.md",
        path: "/mnt/c/Users/me/project/docs/opened.md",
        kind: "file",
        fileInteraction: "opened",
      },
    ],
    workspaceRoot: "C:/Users/me/project",
  });

  assert.deepEqual(families.map(familyLabel), ["Files"]);
  const filesFamily = families[0] as Record<string, unknown>;
  const rows = fileRows(filesFamily).sort((left, right) => left.path.localeCompare(right.path));
  assert.deepEqual(rows, [
    { kind: "file_discovered", path: "docs/opened.md", fileInteraction: "opened" },
    { kind: "file_output", path: "src/changed.ts", fileInteraction: "modified" },
  ]);
});

test("technical config and instruction files are filtered in fallback data", () => {
  const families = resolveArtifactFamilies({
    serverArtifacts: undefined,
    legacyArtifacts: [
      {
        id: "agents-doc",
        name: "AGENTS.md",
        path: "AGENTS.md",
        kind: "file",
      },
      {
        id: "claude-doc",
        name: "CLAUDE.md",
        path: "CLAUDE.md",
        kind: "file",
      },
      {
        id: "workspace-config",
        name: "opencode.json",
        path: "opencode.json",
        kind: "file",
      },
      {
        id: "real-file",
        name: "session.tsx",
        path: "packages/app/src/app/pages/session.tsx",
        kind: "file",
      },
    ],
    workspaceRoot: "/Users/vaclavsoukup/AI agent projects/Veslo",
  });

  assert.deepEqual(families.map(familyLabel), ["Files"]);
  const filesFamily = families[0] as Record<string, unknown>;
  const paths = familyItems(filesFamily).map((item) => String((item as Record<string, unknown>).path ?? ""));
  assert.deepEqual(paths, ["packages/app/src/app/pages/session.tsx"]);
});

test("right sidebar artifacts keep user files and hide helper cache build and skill implementation paths", () => {
  const families = buildArtifactFamilies({
    artifacts: [
      artifact({
        id: "user-file",
        family: "files",
        kind: "file_output",
        status: "updated",
        title: "context-panel.tsx",
        path: "packages/app/src/app/components/session/context-panel.tsx",
        timestamp: 30,
      }),
      artifact({
        id: "cache-file",
        family: "files",
        kind: "file_discovered",
        status: "scanned",
        title: "worker.json",
        path: ".cache/veslo/worker.json",
        timestamp: 29,
      }),
      artifact({
        id: "build-file",
        family: "files",
        kind: "file_output",
        status: "updated",
        title: "bundle.js",
        path: "packages/app/dist/assets/bundle.js",
        timestamp: 28,
      }),
      artifact({
        id: "temp-file",
        family: "files",
        kind: "file_discovered",
        status: "scanned",
        title: "scratch.txt",
        path: "tmp/scratch.txt",
        timestamp: 27,
      }),
      artifact({
        id: "skill-row",
        family: "skills",
        kind: "skill_used",
        status: "used",
        title: "SKILL.md",
        path: "/Users/vaclavsoukup/.codex/skills/systematic-debugging/SKILL.md",
        timestamp: 26,
      }),
      artifact({
        id: "source-cache-file",
        family: "files",
        kind: "file_output",
        status: "updated",
        title: "client.ts",
        path: "src/cache/client.ts",
        timestamp: 25,
      }),
      artifact({
        id: "source-build-file",
        family: "files",
        kind: "file_output",
        status: "updated",
        title: "index.ts",
        path: "src/build/index.ts",
        timestamp: 24,
      }),
    ],
  });

  assert.deepEqual(families.map(familyLabel), ["Files", "Skills"]);

  const filesFamily = families[0] as Record<string, unknown>;
  const filePaths = familyItems(filesFamily).map((item) => String((item as Record<string, unknown>).path ?? ""));
  assert.deepEqual(filePaths, [
    "packages/app/src/app/components/session/context-panel.tsx",
    "src/cache/client.ts",
    "src/build/index.ts",
  ]);

  const skillsFamily = families[1] as Record<string, unknown>;
  const [skillItem] = familyItems(skillsFamily) as Array<Record<string, unknown>>;
  assert.equal(skillItem.title, "Systematic Debugging");
  assert.equal(skillItem.path, undefined);
});

test("family ordering prefers active families in Files, Skills, MCP, Soul order", () => {
  const families = buildArtifactFamilies({
    artifacts: [
      artifact({
        id: "soul-memory",
        family: "soul",
        kind: "soul_memory_used",
        status: "active",
        title: "Soul memory",
        sourceName: "soul",
        timestamp: 30,
      }),
      artifact({
        id: "mcp-1",
        family: "mcp",
        kind: "mcp_used",
        status: "used",
        title: "Chrome DevTools",
        sourceName: "chrome-devtools",
        timestamp: 40,
      }),
      artifact({
        id: "skill-1",
        family: "skills",
        kind: "skill_used",
        status: "used",
        title: "brainstorming",
        sourceName: "brainstorming",
        timestamp: 50,
      }),
      artifact({
        id: "files-1",
        family: "files",
        kind: "file_output",
        status: "updated",
        title: "session.tsx",
        path: "packages/app/src/app/pages/session.tsx",
        timestamp: 60,
      }),
    ],
  });

  assert.deepEqual(families.map(familyLabel), ["Files", "Skills", "MCP", "Soul"]);
});
