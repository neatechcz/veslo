import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import type { SkillPackageFile } from "../skill-package-model.js";
import { buildSkillPackageManifest } from "../skill-package-model.js";
import type { SkillPackageArchive } from "../skill-packages.js";
import { listSkills } from "../skills.js";
import {
  materializeSkillPackageToRoot,
  materializeWorkspaceSkillSet,
  readSkillMaterializationManifest,
} from "../skill-materializer.js";
import { workspaceManagedSkillsRoot } from "../skill-roots.js";

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

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

const archiveFile = (
  path: string,
  content: Buffer | string,
  overrides: Partial<SkillPackageFile & { contentBase64: string }> = {},
): SkillPackageFile & { contentBase64: string } => {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const mediaType = path.endsWith(".md") ? "text/markdown" : path.endsWith(".sh") ? "text/x-shellscript" : "text/plain";
  return {
    path,
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    mediaType,
    ...(mediaType.startsWith("text/") ? { text: bytes.toString("utf8") } : {}),
    contentBase64: bytes.toString("base64"),
    ...overrides,
  };
};

const archive = async (name: string, body: string, extraFiles: Array<SkillPackageFile & { contentBase64: string }> = []): Promise<SkillPackageArchive> => {
  const files = [
    archiveFile("SKILL.md", `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}`),
    ...extraFiles,
  ];
  return {
    ...(await buildSkillPackageManifest({ metadata: { name, description: `${name} description` }, files })),
    files,
  };
};

const materialization = (name: string, pkg: SkillPackageArchive) => ({
  installationId: `install-${name}`,
  skillId: `skill-${name}`,
  name,
  versionId: `version-${name}`,
  packageSha256: pkg.packageSha256,
  source: "workspace" as const,
  target: "workspace" as const,
  removalPolicy: "user_removable" as const,
});

test("materializes a full package tree with root and per-skill managed markers", async () => {
  const workspaceRoot = await tempDir("veslo-materializer-workspace-");
  const rootDir = workspaceManagedSkillsRoot(workspaceRoot);
  const pkg = await archive("managed-tool", "# Managed\n", [
    archiveFile("scripts/setup.sh", "#!/bin/sh\necho setup\n", { executable: true }),
    archiveFile("examples/example.txt", "example\n"),
  ]);

  const result = await materializeSkillPackageToRoot({
    rootDir,
    dataDir: await tempDir("veslo-materializer-data-"),
    skill: materialization("managed-tool", pkg),
    archive: pkg,
  });

  expect(result.skillDir).toBe(join(rootDir, "managed-tool"));
  expect(await readFile(join(rootDir, "managed-tool", "SKILL.md"), "utf8")).toContain("# Managed");
  expect(await readFile(join(rootDir, "managed-tool", "examples", "example.txt"), "utf8")).toBe("example\n");
  expect(JSON.parse(await readFile(join(rootDir, "managed-tool", ".veslo-managed.json"), "utf8"))).toMatchObject({
    schemaVersion: 1,
    name: "managed-tool",
    packageSha256: pkg.packageSha256,
  });

  const manifest = await readSkillMaterializationManifest(rootDir);
  expect(manifest?.entries).toMatchObject([
    {
      name: "managed-tool",
      installationId: "install-managed-tool",
      packageSha256: pkg.packageSha256,
    },
  ]);
});

test("replaces managed directories atomically and creates a pre-change backup", async () => {
  const rootDir = join(await tempDir("veslo-materializer-replace-"), "skills", "veslo-managed");
  const dataDir = await tempDir("veslo-materializer-backups-");
  const first = await archive("replace-me", "# First\n");
  const second = await archive("replace-me", "# Second\n");

  await materializeSkillPackageToRoot({
    rootDir,
    dataDir,
    skill: materialization("replace-me", first),
    archive: first,
  });
  await writeFile(join(rootDir, "replace-me", "stale.txt"), "remove me\n", "utf8");

  const result = await materializeSkillPackageToRoot({
    rootDir,
    dataDir,
    skill: materialization("replace-me", second),
    archive: second,
  });

  expect(result.backupDir).toBeTruthy();
  expect(await readFile(join(rootDir, "replace-me", "SKILL.md"), "utf8")).toContain("# Second");
  await expect(readFile(join(rootDir, "replace-me", "stale.txt"), "utf8")).rejects.toThrow();
  expect(await readFile(join(result.backupDir ?? "", "SKILL.md"), "utf8")).toContain("# First");
});

test("skips unchanged managed directories without backup churn", async () => {
  const workspaceRoot = await tempDir("veslo-materializer-idempotent-");
  const dataDir = await tempDir("veslo-materializer-idempotent-data-");
  const pkg = await archive("stable-skill", "# Stable\n");

  const first = await materializeWorkspaceSkillSet({
    workspaceRoot,
    dataDir,
    skills: [materialization("stable-skill", pkg)],
    loadPackage: async () => pkg,
  });
  const markerPath = join(workspaceManagedSkillsRoot(workspaceRoot), "stable-skill", ".veslo-managed.json");
  const markerBefore = await readFile(markerPath, "utf8");

  const second = await materializeWorkspaceSkillSet({
    workspaceRoot,
    dataDir,
    skills: [materialization("stable-skill", pkg)],
    loadPackage: async () => pkg,
  });

  expect(first.backupDirs).toEqual([]);
  expect(second.backupDirs).toEqual([]);
  expect(second.materializedSkills).toEqual([{ skillDir: join(workspaceManagedSkillsRoot(workspaceRoot), "stable-skill") }]);
  expect(await readFile(markerPath, "utf8")).toBe(markerBefore);
});

test("repairs mutated managed package files even when marker fields match", async () => {
  const workspaceRoot = await tempDir("veslo-materializer-mutated-");
  const dataDir = await tempDir("veslo-materializer-mutated-data-");
  const pkg = await archive("stable-skill", "# Stable\n", [
    archiveFile("examples/example.txt", "example\n"),
  ]);

  await materializeWorkspaceSkillSet({
    workspaceRoot,
    dataDir,
    skills: [materialization("stable-skill", pkg)],
    loadPackage: async () => pkg,
  });

  const skillDir = join(workspaceManagedSkillsRoot(workspaceRoot), "stable-skill");
  await writeFile(join(skillDir, "SKILL.md"), "# User mutation\n", "utf8");
  await writeFile(join(skillDir, "examples", "example.txt"), "changed\n", "utf8");

  const result = await materializeWorkspaceSkillSet({
    workspaceRoot,
    dataDir,
    skills: [materialization("stable-skill", pkg)],
    loadPackage: async () => pkg,
  });

  expect(result.backupDirs.length).toBe(1);
  expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toContain("# Stable");
  expect(await readFile(join(skillDir, "examples", "example.txt"), "utf8")).toBe("example\n");
});

test("repairs missing managed entrypoint even when marker fields match", async () => {
  const workspaceRoot = await tempDir("veslo-materializer-missing-entry-");
  const dataDir = await tempDir("veslo-materializer-missing-entry-data-");
  const pkg = await archive("stable-skill", "# Stable\n");

  await materializeWorkspaceSkillSet({
    workspaceRoot,
    dataDir,
    skills: [materialization("stable-skill", pkg)],
    loadPackage: async () => pkg,
  });

  const skillDir = join(workspaceManagedSkillsRoot(workspaceRoot), "stable-skill");
  await rm(join(skillDir, "SKILL.md"), { force: true });

  const result = await materializeWorkspaceSkillSet({
    workspaceRoot,
    dataDir,
    skills: [materialization("stable-skill", pkg)],
    loadPackage: async () => pkg,
  });

  expect(result.backupDirs.length).toBe(1);
  expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toContain("# Stable");
});

test("refuses to overwrite an unmanaged skill directory", async () => {
  const rootDir = join(await tempDir("veslo-materializer-unmanaged-"), "skills", "veslo-managed");
  await mkdir(join(rootDir, "unsafe"), { recursive: true });
  await writeFile(join(rootDir, "unsafe", "SKILL.md"), "# User file\n", "utf8");
  const pkg = await archive("unsafe", "# Managed\n");

  await expect(
    materializeSkillPackageToRoot({
      rootDir,
      dataDir: await tempDir("veslo-materializer-data-"),
      skill: materialization("unsafe", pkg),
      archive: pkg,
    }),
  ).rejects.toThrow(/unmanaged/i);

  expect(await readFile(join(rootDir, "unsafe", "SKILL.md"), "utf8")).toBe("# User file\n");
});

test("materializes a workspace skill set, removes stale managed skills, and preserves unmanaged skills", async () => {
  const workspaceRoot = await tempDir("veslo-materializer-set-");
  const dataDir = await tempDir("veslo-materializer-set-data-");
  const first = await archive("first-skill", "# First\n");
  const stale = await archive("stale-skill", "# Stale\n");
  const next = await archive("next-skill", "# Next\n");

  await materializeWorkspaceSkillSet({
    workspaceRoot,
    dataDir,
    skills: [materialization("first-skill", first), materialization("stale-skill", stale)],
    loadPackage: async (skill) => skill.name === "first-skill" ? first : stale,
  });
  await mkdir(join(workspaceRoot, ".opencode", "skills", "unmanaged"), { recursive: true });
  await writeFile(join(workspaceRoot, ".opencode", "skills", "unmanaged", "SKILL.md"), "---\nname: unmanaged\n---\n# Unmanaged\n");

  const result = await materializeWorkspaceSkillSet({
    workspaceRoot,
    dataDir,
    skills: [materialization("first-skill", first), materialization("next-skill", next)],
    loadPackage: async (skill) => skill.name === "first-skill" ? first : next,
  });

  const rootDir = workspaceManagedSkillsRoot(workspaceRoot);
  expect(result.removedSkillNames).toEqual(["stale-skill"]);
  await expect(stat(join(rootDir, "stale-skill"))).rejects.toThrow();
  expect(await readFile(join(rootDir, "next-skill", "SKILL.md"), "utf8")).toContain("# Next");
  expect(await readFile(join(workspaceRoot, ".opencode", "skills", "unmanaged", "SKILL.md"), "utf8")).toContain("# Unmanaged");
});

test("rejects duplicate desired skill names before mutating managed files", async () => {
  const workspaceRoot = await tempDir("veslo-materializer-duplicates-");
  const dataDir = await tempDir("veslo-materializer-duplicates-data-");
  const original = await archive("duplicate-skill", "# Original\n");
  const replacement = await archive("duplicate-skill", "# Replacement\n");

  await materializeWorkspaceSkillSet({
    workspaceRoot,
    dataDir,
    skills: [materialization("duplicate-skill", original)],
    loadPackage: async () => original,
  });

  await expect(
    materializeWorkspaceSkillSet({
      workspaceRoot,
      dataDir,
      skills: [
        materialization("duplicate-skill", replacement),
        {
          ...materialization("duplicate-skill", replacement),
          installationId: "install-duplicate-skill-copy",
          skillId: "skill-duplicate-skill-copy",
        },
      ],
      loadPackage: async () => replacement,
    }),
  ).rejects.toThrow(/duplicate/i);

  expect(
    await readFile(join(workspaceManagedSkillsRoot(workspaceRoot), "duplicate-skill", "SKILL.md"), "utf8"),
  ).toContain("# Original");
});

test("materialized workspace skills are visible through existing one-level category discovery", async () => {
  const workspaceRoot = await tempDir("veslo-materializer-discovery-");
  const pkg = await archive("discoverable-skill", "# Discoverable\n");

  await materializeWorkspaceSkillSet({
    workspaceRoot,
    dataDir: await tempDir("veslo-materializer-discovery-data-"),
    skills: [materialization("discoverable-skill", pkg)],
    loadPackage: async () => pkg,
  });

  const skills = await listSkills(workspaceRoot, false);
  expect(skills.map((skill) => skill.name)).toContain("discoverable-skill");
});
