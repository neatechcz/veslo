import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  readPublishedSharedSkillViewRevision,
  requiresSharedSkillViewForProxy,
} from "../shared-skill-view-policy.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("shared skill-view proxy policy", () => {
  test("prepares a view before opening a workspace event stream", () => {
    expect(requiresSharedSkillViewForProxy("GET", "/event")).toBe(true);
    expect(requiresSharedSkillViewForProxy("get", "/event/")).toBe(true);
  });

  test("keeps ordinary GET and HEAD probes passive", () => {
    expect(requiresSharedSkillViewForProxy("GET", "/global/health")).toBe(false);
    expect(requiresSharedSkillViewForProxy("GET", "/mcp")).toBe(false);
    expect(requiresSharedSkillViewForProxy("HEAD", "/event")).toBe(false);
  });

  test("prepares a view for every mutating proxy request", () => {
    expect(requiresSharedSkillViewForProxy("POST", "/session/a/prompt_async")).toBe(true);
    expect(requiresSharedSkillViewForProxy("DELETE", "/session/a")).toBe(true);
  });

  test("uses a valid published runtime revision for an event stream", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "veslo-shared-skill-view-"));
    temporaryRoots.push(workspace);
    await mkdir(join(workspace, ".opencode"));
    await writeFile(
      join(workspace, ".opencode", "veslo.runtime.skills.json"),
      JSON.stringify({
        schemaVersion: 2,
        workspaceRoot: resolve(workspace),
        revision: "runtime-view-a",
        entries: [],
      }),
    );

    await expect(readPublishedSharedSkillViewRevision(workspace)).resolves.toBe("runtime-view-a");
  });

  test("does not trust a manifest published for a different workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "veslo-shared-skill-view-"));
    temporaryRoots.push(workspace);
    await mkdir(join(workspace, ".opencode"));
    await writeFile(
      join(workspace, ".opencode", "veslo.runtime.skills.json"),
      JSON.stringify({ schemaVersion: 2, workspaceRoot: join(workspace, "other"), revision: "wrong-root", entries: [] }),
    );

    await expect(readPublishedSharedSkillViewRevision(workspace)).resolves.toBeUndefined();
  });
});
