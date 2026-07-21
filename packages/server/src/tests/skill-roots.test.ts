import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import {
  findWorkspaceRoots,
  isPathInside,
  isVesloManagedSkillRelativePath,
  personalGlobalManagedSkillsRoot,
  userConfigHomeDir,
  userGlobalSkillRoots,
  userGlobalSkillRootsForMutation,
  userHomeDir,
  workspaceManagedSkillsRoot,
  workspaceSkillRootsForMutation,
  workspaceSkillsRoot,
} from "../skill-roots.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

async function withEnv<T>(
  next: Partial<Record<"HOME" | "USERPROFILE" | "XDG_CONFIG_HOME", string | undefined>>,
  run: () => Promise<T> | T,
): Promise<T> {
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("user-global OpenCode roots prefer XDG_CONFIG_HOME and de-dupe HOME fallback", async () => {
  const homeDir = await tempDir("veslo-skill-roots-home-");
  const xdgConfigHome = await tempDir("veslo-skill-roots-xdg-");

  await withEnv({ HOME: homeDir, USERPROFILE: undefined, XDG_CONFIG_HOME: xdgConfigHome }, () => {
    expect(userConfigHomeDir()).toBe(xdgConfigHome);
    expect(userGlobalSkillRoots()).toEqual([
      join(xdgConfigHome, "opencode", "skills"),
      join(homeDir, ".config", "opencode", "skills"),
      join(homeDir, ".claude", "skills"),
      join(homeDir, ".agents", "skills"),
      join(homeDir, ".agent", "skills"),
    ]);
    expect(userGlobalSkillRootsForMutation()).toEqual(userGlobalSkillRoots());
    expect(personalGlobalManagedSkillsRoot()).toBe(
      join(xdgConfigHome, "opencode", "skills", "veslo-managed"),
    );
  });

  await withEnv({ HOME: homeDir, USERPROFILE: undefined, XDG_CONFIG_HOME: undefined }, () => {
    expect(userGlobalSkillRoots()).toEqual([
      join(homeDir, ".config", "opencode", "skills"),
      join(homeDir, ".claude", "skills"),
      join(homeDir, ".agents", "skills"),
      join(homeDir, ".agent", "skills"),
    ]);
  });
});

test("user-global roots trim empty env values and honor explicit managed root override", async () => {
  const userProfile = await tempDir("veslo-skill-roots-trimmed-userprofile-");
  const explicitRoot = join(await tempDir("veslo-skill-roots-explicit-"), "custom", "skills");

  await withEnv({ HOME: "  ", USERPROFILE: ` ${userProfile} `, XDG_CONFIG_HOME: " \t " }, () => {
    expect(userHomeDir()).toBe(userProfile);
    expect(userConfigHomeDir()).toBe(join(userProfile, ".config"));
    expect(userGlobalSkillRoots()[0]).toBe(join(userProfile, ".config", "opencode", "skills"));
    expect(personalGlobalManagedSkillsRoot(` ${explicitRoot} `)).toBe(
      join(explicitRoot, "veslo-managed"),
    );
  });
});

test("user-global roots fall back to USERPROFILE when HOME is absent", async () => {
  const userProfile = await tempDir("veslo-skill-roots-userprofile-");

  await withEnv({ HOME: undefined, USERPROFILE: userProfile, XDG_CONFIG_HOME: undefined }, () => {
    expect(userConfigHomeDir()).toBe(join(userProfile, ".config"));
    expect(userGlobalSkillRoots()[0]).toBe(join(userProfile, ".config", "opencode", "skills"));
    expect(personalGlobalManagedSkillsRoot()).toBe(
      join(userProfile, ".config", "opencode", "skills", "veslo-managed"),
    );
  });
});

test("workspace root helpers keep managed skills under the workspace skills root", async () => {
  const workspaceRoot = join(await tempDir("veslo-skill-roots-workspace-"), "repo", "app");

  expect(workspaceSkillsRoot(workspaceRoot)).toBe(join(workspaceRoot, ".opencode", "skills"));
  expect(workspaceManagedSkillsRoot(workspaceRoot)).toBe(
    join(workspaceRoot, ".opencode", "skills", "veslo-managed"),
  );
});

test("workspace mutation roots include opencode and claude roots for the workspace chain", async () => {
  const repoRoot = join(await tempDir("veslo-skill-roots-chain-"), "repo");
  const nestedRoot = join(repoRoot, "packages", "app");
  await mkdir(join(repoRoot, ".git"), { recursive: true });
  await mkdir(nestedRoot, { recursive: true });

  expect(await workspaceSkillRootsForMutation(nestedRoot, { boundaryRoot: repoRoot })).toEqual([
    join(nestedRoot, ".opencode", "skills"),
    join(nestedRoot, ".claude", "skills"),
    join(repoRoot, "packages", ".opencode", "skills"),
    join(repoRoot, "packages", ".claude", "skills"),
    join(repoRoot, ".opencode", "skills"),
    join(repoRoot, ".claude", "skills"),
  ]);
  expect(await findWorkspaceRoots(nestedRoot, { boundaryRoot: repoRoot })).toEqual([
    nestedRoot,
    join(repoRoot, "packages"),
    repoRoot,
  ]);
});

test("workspace root traversal is bounded for a gitless registered workspace", async () => {
  const parent = await tempDir("veslo-skill-roots-gitless-");
  const workspaceRoot = join(parent, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  expect(await findWorkspaceRoots(workspaceRoot)).toEqual([workspaceRoot]);
  expect(await workspaceSkillRootsForMutation(workspaceRoot)).toEqual([
    join(workspaceRoot, ".opencode", "skills"),
    join(workspaceRoot, ".claude", "skills"),
  ]);
});

test("path-inside predicate rejects sibling prefix escapes", async () => {
  const baseDir = await tempDir("veslo-skill-roots-boundary-");
  const parent = join(baseDir, "repo");

  expect(isPathInside(parent, parent)).toBe(true);
  expect(isPathInside(parent, join(parent, ".opencode", "skills", "local", "SKILL.md"))).toBe(true);
  expect(isPathInside(parent, join(baseDir, "repo-other", "skills", "SKILL.md"))).toBe(false);
  expect(isPathInside(parent, join(baseDir, "repo2", "skills", "SKILL.md"))).toBe(false);
});

test("managed skill relative path predicate only matches veslo-managed paths", () => {
  expect(isVesloManagedSkillRelativePath("veslo-managed")).toBe(true);
  expect(isVesloManagedSkillRelativePath("veslo-managed/veslo-docx/SKILL.md")).toBe(true);
  expect(isVesloManagedSkillRelativePath("veslo-managed\\veslo-docx\\SKILL.md")).toBe(true);
  expect(isVesloManagedSkillRelativePath("veslo-managed/veslo-docx/scripts/pack.py")).toBe(true);
  expect(isVesloManagedSkillRelativePath("veslo-managed/other/SKILL.md")).toBe(true);
  expect(isVesloManagedSkillRelativePath("veslo-managed-other/veslo-docx/SKILL.md")).toBe(false);
  expect(isVesloManagedSkillRelativePath("nested/veslo-managed/veslo-docx/SKILL.md")).toBe(false);
  expect(isVesloManagedSkillRelativePath("veslo-user/veslo-docx/SKILL.md")).toBe(false);
  expect(isVesloManagedSkillRelativePath("research/SKILL.md")).toBe(false);
});
