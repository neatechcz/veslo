import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configIncludesSoulInstruction,
  getSoulStatus,
  LEGACY_SOUL_MEMORY_PATH,
  listSoulHeartbeats,
  parseSoulHeartbeatEntries,
  SOUL_HEARTBEAT_PATH,
  SOUL_INSTRUCTIONS,
  SOUL_MANIFEST_PATH,
  soulMaterializationApprovalPaths,
} from "../soul-runtime.js";

async function tempWorkspace(label: string) {
  return await mkdtemp(join(tmpdir(), `veslo-soul-runtime-${label}-`));
}

describe("soul runtime owner", () => {
  test("owns the materialization approval paths for the current Soul runtime contract", async () => {
    const workspaceRoot = await tempWorkspace("approval-paths");
    try {
      const paths = soulMaterializationApprovalPaths(workspaceRoot);

      expect(paths).toEqual([
        join(workspaceRoot, "opencode.jsonc"),
        ...SOUL_INSTRUCTIONS.map((relativePath) => join(workspaceRoot, relativePath)),
        join(workspaceRoot, SOUL_MANIFEST_PATH),
      ]);
      expect(new Set(paths).size).toBe(paths.length);
      expect(paths).not.toContain(join(workspaceRoot, LEGACY_SOUL_MEMORY_PATH));
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("detects current and legacy Soul instruction config without matching unrelated paths", () => {
    for (const relativePath of SOUL_INSTRUCTIONS) {
      expect(configIncludesSoulInstruction({ instructions: [relativePath] })).toBe(true);
      expect(configIncludesSoulInstruction({ instructions: `Load ${relativePath} before answering.` })).toBe(true);
    }

    expect(configIncludesSoulInstruction({ instructions: [LEGACY_SOUL_MEMORY_PATH] })).toBe(true);
    expect(configIncludesSoulInstruction({ instructions: [".opencode/not-soul.md"] })).toBe(false);
    expect(configIncludesSoulInstruction({ instructions: 123 })).toBe(false);
  });

  test("parses heartbeat logs newest first and ignores malformed lines", () => {
    const heartbeats = parseSoulHeartbeatEntries([
      JSON.stringify({
        ts: "2026-07-01T10:00:00.000Z",
        workspace: "ws_1",
        loose_ends: ["Review deployment", "Update docs"],
      }),
      "not json",
      JSON.stringify({
        ts: 1_782_901_800_000,
        workspace: "ws_1",
        summary: "Deployment done",
        next_action: "Watch metrics",
      }),
    ].join("\n"));

    expect(heartbeats).toHaveLength(2);
    expect(heartbeats[0]).toMatchObject({
      ts: "2026-07-01T10:30:00.000Z",
      workspace: "ws_1",
      summary: "Deployment done",
      nextAction: "Watch metrics",
    });
    expect(heartbeats[1]).toMatchObject({
      ts: "2026-07-01T10:00:00.000Z",
      summary: "Loose ends: Review deployment; Update docs",
      looseEnds: ["Review deployment", "Update docs"],
    });
  });

  test("reports status from current Soul runtime files while preserving legacy memory fallback", async () => {
    const workspaceRoot = await tempWorkspace("status");
    try {
      await mkdir(join(workspaceRoot, ".opencode", "soul"), { recursive: true });
      await writeFile(
        join(workspaceRoot, "opencode.jsonc"),
        JSON.stringify({ instructions: [SOUL_INSTRUCTIONS[1]] }, null, 2),
        "utf8",
      );
      await writeFile(join(workspaceRoot, SOUL_INSTRUCTIONS[1]), "User runtime memory\n", "utf8");
      await writeFile(
        join(workspaceRoot, SOUL_HEARTBEAT_PATH),
        `${JSON.stringify({ ts: "2026-07-01T12:00:00.000Z", summary: "Ready" })}\n`,
        "utf8",
      );

      const status = await getSoulStatus(workspaceRoot);

      expect(status.enabled).toBe(true);
      expect(status.state).toBe("healthy");
      expect(status.memoryEnabled).toBe(true);
      expect(status.instructionsEnabled).toBe(true);
      expect(status.heartbeatLogExists).toBe(true);
      expect(status.heartbeatCount).toBe(1);
      expect(status.lastHeartbeatAt).toBe("2026-07-01T12:00:00.000Z");
      expect(status.lastHeartbeatSummary).toBe("Ready");
      expect(status.memoryPath).toBe(SOUL_INSTRUCTIONS[0]);
      expect(status.memoryPaths).toEqual([...SOUL_INSTRUCTIONS]);
      expect(status.heartbeatPath).toBe(SOUL_HEARTBEAT_PATH);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("legacy Soul memory keeps status enabled without changing the current runtime contract", async () => {
    const workspaceRoot = await tempWorkspace("legacy");
    try {
      await mkdir(join(workspaceRoot, ".opencode"), { recursive: true });
      await writeFile(join(workspaceRoot, LEGACY_SOUL_MEMORY_PATH), "Legacy memory\n", "utf8");

      const status = await getSoulStatus(workspaceRoot);

      expect(status.enabled).toBe(true);
      expect(status.memoryEnabled).toBe(true);
      expect(status.instructionsEnabled).toBe(false);
      expect(status.memoryPath).toBe(SOUL_INSTRUCTIONS[0]);
      expect(status.memoryPaths).toEqual([...SOUL_INSTRUCTIONS]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("listSoulHeartbeats returns a stable empty payload when the log is missing", async () => {
    const workspaceRoot = await tempWorkspace("missing-heartbeats");
    try {
      await expect(listSoulHeartbeats(workspaceRoot, 10)).resolves.toEqual({
        items: [],
        total: 0,
        path: SOUL_HEARTBEAT_PATH,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
