import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  compareWorkspaceSkillLockfile,
  readWorkspaceSkillLockfile,
  workspaceSkillLockfilePath,
  writeWorkspaceSkillLockfile,
} from "./workspace-skill-lockfile.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

const tempWorkspace = async () => {
  const dir = await mkdtemp(join(tmpdir(), "veslo-workspace-skill-lock-"));
  tempDirs.push(dir);
  return dir;
};

const shaA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const shaB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("workspace skill lockfile", () => {
  test("uses the .opencode/veslo.skills.lock.json path", async () => {
    const workspaceRoot = await tempWorkspace();

    expect(workspaceSkillLockfilePath(workspaceRoot)).toBe(
      join(workspaceRoot, ".opencode", "veslo.skills.lock.json"),
    );
  });

  test("invalid lockfile is rejected with a repairable error", async () => {
    const workspaceRoot = await tempWorkspace();
    await mkdir(join(workspaceRoot, ".opencode"), { recursive: true });
    await writeFile(workspaceSkillLockfilePath(workspaceRoot), "{ invalid json", "utf8");

    await expect(readWorkspaceSkillLockfile(workspaceRoot)).rejects.toMatchObject({
      code: "workspace_skill_lockfile_invalid",
      repairable: true,
    });
  });

  test("write and read preserve skill set revision and version hashes", async () => {
    const workspaceRoot = await tempWorkspace();

    await writeWorkspaceSkillLockfile(workspaceRoot, {
      schemaVersion: 1,
      workspaceId: "ws_1",
      skillSetId: "set_1",
      skillSetRevision: "rev_1",
      entries: [
        {
          skillId: "skill_1",
          installationId: "install_1",
          versionId: "version_1",
          name: "research",
          packageSha256: shaA,
        },
      ],
    });

    await expect(readWorkspaceSkillLockfile(workspaceRoot)).resolves.toEqual({
      schemaVersion: 1,
      workspaceId: "ws_1",
      skillSetId: "set_1",
      skillSetRevision: "rev_1",
      entries: [
        {
          skillId: "skill_1",
          installationId: "install_1",
          versionId: "version_1",
          name: "research",
          packageSha256: shaA,
        },
      ],
    });
  });

  test("compares lockfile entries with desired server state", () => {
    const comparison = compareWorkspaceSkillLockfile(
      {
        schemaVersion: 1,
        workspaceId: "ws_1",
        skillSetId: "set_1",
        skillSetRevision: "rev_1",
        entries: [
          {
            skillId: "skill_same",
            installationId: "install_same",
            versionId: "version_1",
            name: "same",
            packageSha256: shaA,
          },
          {
            skillId: "skill_changed",
            installationId: "install_changed",
            versionId: "version_1",
            name: "changed",
            packageSha256: shaA,
          },
          {
            skillId: "skill_extra",
            installationId: "install_extra",
            versionId: "version_1",
            name: "extra",
            packageSha256: shaA,
          },
        ],
      },
      {
        workspaceId: "ws_1",
        skillSetId: "set_1",
        skillSetRevision: "rev_2",
        entries: [
          {
            skillId: "skill_same",
            installationId: "install_same",
            versionId: "version_1",
            name: "same",
            packageSha256: shaA,
          },
          {
            skillId: "skill_changed",
            installationId: "install_changed",
            versionId: "version_2",
            name: "changed",
            packageSha256: shaB,
          },
          {
            skillId: "skill_missing",
            installationId: "install_missing",
            versionId: "version_1",
            name: "missing",
            packageSha256: shaA,
          },
        ],
      },
    );

    expect(comparison.matches).toBe(false);
    expect(comparison.revisionMatches).toBe(false);
    expect(comparison.missing.map((entry) => entry.skillId)).toEqual(["skill_missing"]);
    expect(comparison.changed.map((entry) => entry.desired.skillId)).toEqual(["skill_changed"]);
    expect(comparison.extra.map((entry) => entry.skillId)).toEqual(["skill_extra"]);
  });
});
