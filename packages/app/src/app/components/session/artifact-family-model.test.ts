import assert from "node:assert/strict";
import test from "node:test";

import type { VesloSessionArtifactItem } from "../../lib/veslo-server";
import { buildArtifactFamilies, resolveArtifactFamilies } from "./artifact-family-model.js";

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
