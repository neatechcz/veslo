import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename as fsRename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import type { SkillPackageFile } from "./skill-package-model.js";
import { buildSkillPackageManifest, validateSkillPackageManifest } from "./skill-package-model.js";
import {
  MAX_SKILL_PACKAGE_FILE_COUNT,
  MAX_SKILL_PACKAGE_FILE_SIZE_BYTES,
  MAX_SKILL_PACKAGE_TOTAL_SIZE_BYTES,
  __skillPackageTestHooks,
  packSkillDirectory,
  unpackSkillPackage,
} from "./skill-packages.js";

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

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

const archiveFromFiles = async (
  files: Array<SkillPackageFile & { contentBase64: string }>,
  metadata = { name: "archive-test" },
) => ({
  ...(await buildSkillPackageManifest({ metadata, files })),
  files,
});

const archiveFile = (
  path: string,
  bytes: Buffer | string,
  overrides: Partial<SkillPackageFile & { contentBase64: string }> = {},
): SkillPackageFile & { contentBase64: string } => {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
  return {
    path,
    sha256: sha256(buffer),
    sizeBytes: buffer.byteLength,
    mediaType: path.endsWith(".md") ? "text/markdown" : "application/octet-stream",
    ...(path.endsWith(".md") ? { text: buffer.toString("utf8") } : {}),
    contentBase64: buffer.toString("base64"),
    ...overrides,
  };
};

test("packSkillDirectory includes valid files in deterministic order and skips ignored system files", async () => {
  const skillDir = await tempDir("veslo-skill-package-pack-");
  const scriptPath = join(skillDir, "scripts", "nested", "install.sh");
  const assetBytes = Buffer.from([0, 1, 2, 3, 255]);

  await mkdir(join(skillDir, "scripts", "nested"), { recursive: true });
  await mkdir(join(skillDir, "assets"), { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: research\ndescription: Research helper\n---\n\n# Research\n",
    "utf8",
  );
  await writeFile(scriptPath, "#!/usr/bin/env bash\necho setup\n", "utf8");
  await chmod(scriptPath, 0o755);
  await writeFile(join(skillDir, "assets", "icon.bin"), assetBytes);
  await writeFile(join(skillDir, ".DS_Store"), "ignored", "utf8");
  await writeFile(join(skillDir, "scripts", ".DS_Store"), "ignored", "utf8");

  const archive = await packSkillDirectory(skillDir);

  expect(archive.files.map((file) => file.path)).toEqual([
    "SKILL.md",
    "assets/icon.bin",
    "scripts/nested/install.sh",
  ]);
  expect(archive.files.find((file) => file.path === "SKILL.md")?.text).toContain("# Research");
  expect(archive.files.find((file) => file.path === "assets/icon.bin")?.contentBase64).toBe(
    assetBytes.toString("base64"),
  );
  if (process.platform !== "win32") {
    expect(archive.files.find((file) => file.path === "scripts/nested/install.sh")?.executable).toBe(true);
  }

  const manifest = validateSkillPackageManifest(archive);
  expect(manifest.packageSha256).toBe(archive.packageSha256);
});

test("packSkillDirectory derives manifest metadata through the shared skill parser", async () => {
  const skillDir = await tempDir("veslo-skill-package-metadata-");
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: package-helper",
      "description:   Package helper   ",
      "when: Use when packaging skills.",
      "tags:",
      "  - packaging",
      "  - skills",
      "language: cs",
      "---",
      "",
      "# Package helper",
      "",
    ].join("\n"),
    "utf8",
  );

  const archive = await packSkillDirectory(skillDir);

  expect(archive.metadata).toEqual({
    name: "package-helper",
    description: "Package helper",
    trigger: "Use when packaging skills.",
    tags: ["packaging", "skills"],
    language: "cs",
  });
});

test("packSkillDirectory rejects invalid package paths", async () => {
  if (process.platform === "win32") return;

  const skillDir = await tempDir("veslo-skill-package-invalid-path-");
  await writeFile(join(skillDir, "SKILL.md"), "# Invalid path skill\n", "utf8");
  await writeFile(join(skillDir, String.raw`bad\path.txt`), "not portable\n", "utf8");

  await expect(packSkillDirectory(skillDir)).rejects.toThrow(/invalid package path/i);
});

test("packSkillDirectory enforces file count and size limits", async () => {
  const tooManyFilesDir = await tempDir("veslo-skill-package-count-limit-");
  await writeFile(join(tooManyFilesDir, "SKILL.md"), "# Too many files\n", "utf8");
  for (let index = 0; index < MAX_SKILL_PACKAGE_FILE_COUNT; index += 1) {
    await writeFile(join(tooManyFilesDir, `file-${index}.txt`), `${index}\n`, "utf8");
  }

  await expect(packSkillDirectory(tooManyFilesDir)).rejects.toThrow(/too many files/i);

  const tooLargeDir = await tempDir("veslo-skill-package-size-limit-");
  await writeFile(join(tooLargeDir, "SKILL.md"), "# Too large\n", "utf8");
  const largeFilePath = join(tooLargeDir, "large.bin");
  await writeFile(largeFilePath, "");
  await truncate(largeFilePath, MAX_SKILL_PACKAGE_FILE_SIZE_BYTES + 1);

  await expect(packSkillDirectory(tooLargeDir)).rejects.toThrow(/too large/i);
});

test("packSkillDirectory enforces total size limits", async () => {
  const skillDir = await tempDir("veslo-skill-package-total-size-limit-");
  await writeFile(join(skillDir, "SKILL.md"), "# Too large overall\n", "utf8");

  const firstSize = MAX_SKILL_PACKAGE_FILE_SIZE_BYTES - 1;
  const secondSize = MAX_SKILL_PACKAGE_FILE_SIZE_BYTES - 1;
  const thirdSize = MAX_SKILL_PACKAGE_TOTAL_SIZE_BYTES - firstSize - secondSize + 1;

  await writeFile(join(skillDir, "first.bin"), "");
  await writeFile(join(skillDir, "second.bin"), "");
  await writeFile(join(skillDir, "third.bin"), "");
  await truncate(join(skillDir, "first.bin"), firstSize);
  await truncate(join(skillDir, "second.bin"), secondSize);
  await truncate(join(skillDir, "third.bin"), thirdSize);

  await expect(packSkillDirectory(skillDir)).rejects.toThrow(/too large/i);
});

test("unpackSkillPackage restores file bytes and executable metadata", async () => {
  const sourceDir = await tempDir("veslo-skill-package-unpack-source-");
  const targetDir = await tempDir("veslo-skill-package-unpack-target-");
  const scriptPath = join(sourceDir, "scripts", "setup.sh");
  const assetBytes = Buffer.from([12, 34, 56, 78]);

  await mkdir(join(sourceDir, "scripts"), { recursive: true });
  await mkdir(join(sourceDir, "assets"), { recursive: true });
  await writeFile(join(sourceDir, "SKILL.md"), "# Restored\n", "utf8");
  await writeFile(scriptPath, "#!/bin/sh\necho restored\n", "utf8");
  await chmod(scriptPath, 0o755);
  await writeFile(join(sourceDir, "assets", "data.bin"), assetBytes);

  await writeFile(join(targetDir, "stale.txt"), "remove me\n", "utf8");
  const archive = await packSkillDirectory(sourceDir);

  await unpackSkillPackage({ archive, targetDir });

  expect(await readFile(join(targetDir, "SKILL.md"), "utf8")).toBe("# Restored\n");
  expect(await readFile(join(targetDir, "assets", "data.bin"))).toEqual(assetBytes);
  if (process.platform !== "win32") {
    expect((await stat(join(targetDir, "scripts", "setup.sh"))).mode & 0o111).toBeGreaterThan(0);
  }
  await expect(readFile(join(targetDir, "stale.txt"), "utf8")).rejects.toThrow();
});

test("unpackSkillPackage rejects oversized base64 before decoding archive content", async () => {
  const targetDir = await tempDir("veslo-skill-package-unpack-encoded-limit-");
  const archive = await archiveFromFiles([
    archiveFile("SKILL.md", "#", {
      contentBase64: Buffer.alloc(6).toString("base64"),
    }),
  ]);

  await expect(unpackSkillPackage({ archive, targetDir })).rejects.toThrow(/base64 content is too large/i);
});

test("unpackSkillPackage rejects invalid paths without writing outside the target", async () => {
  const targetDir = await tempDir("veslo-skill-package-unpack-invalid-path-");
  const escapePath = join(targetDir, "..", "escape.txt");
  await rm(escapePath, { force: true });

  const invalidFile: SkillPackageFile & { contentBase64: string } = {
    path: "../escape.txt",
    sha256: sha256("escape"),
    sizeBytes: Buffer.byteLength("escape"),
    mediaType: "text/plain",
    text: "escape",
    contentBase64: Buffer.from("escape").toString("base64"),
  };

  await expect(
    unpackSkillPackage({
      archive: {
        schemaVersion: 1,
        entrypoint: "SKILL.md",
        metadata: { name: "invalid" },
        files: [invalidFile],
        packageSha256: "0".repeat(64),
      },
      targetDir,
    }),
  ).rejects.toThrow(/\.\.|path/i);

  await expect(readFile(escapePath, "utf8")).rejects.toThrow();
});

test("unpackSkillPackage validates archive bytes before replacing an existing directory", async () => {
  const targetDir = await tempDir("veslo-skill-package-unpack-rollback-");
  await writeFile(join(targetDir, "existing.txt"), "keep me\n", "utf8");

  const bytes = Buffer.from("# Original\n", "utf8");
  const file: SkillPackageFile & { contentBase64: string } = {
    path: "SKILL.md",
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    mediaType: "text/markdown",
    text: "# Original\n",
    contentBase64: Buffer.from("# Tampered\n", "utf8").toString("base64"),
  };
  const manifest = await buildSkillPackageManifest({
    metadata: { name: "rollback" },
    files: [file],
  });

  await expect(
    unpackSkillPackage({
      archive: {
        ...manifest,
        files: [file],
      },
      targetDir,
    }),
  ).rejects.toThrow(/sha256/i);

  expect(await readFile(join(targetDir, "existing.txt"), "utf8")).toBe("keep me\n");
});

test("unpackSkillPackage restores the previous target if install rename fails after backup", async () => {
  const targetDir = await tempDir("veslo-skill-package-unpack-install-failure-");
  const sourceDir = await tempDir("veslo-skill-package-unpack-install-source-");
  await writeFile(join(targetDir, "existing.txt"), "keep me\n", "utf8");
  await writeFile(join(sourceDir, "SKILL.md"), "# New target\n", "utf8");
  const archive = await packSkillDirectory(sourceDir);

  let movedExistingTarget = false;
  await expect(
    __skillPackageTestHooks.unpackSkillPackageWithFileSystem(
      { archive, targetDir },
      {
        rename: async (from, to) => {
          if (from === targetDir && to.includes(".backup-")) {
            movedExistingTarget = true;
          }
          if (movedExistingTarget && from.includes(".tmp-") && to === targetDir) {
            throw new Error("install rename failed");
          }
          await fsRename(from, to);
        },
      },
    ),
  ).rejects.toThrow(/install rename failed/);

  expect(await readFile(join(targetDir, "existing.txt"), "utf8")).toBe("keep me\n");
});

test("unpackSkillPackage ignores backup cleanup failure after the new target is installed", async () => {
  const targetDir = await tempDir("veslo-skill-package-unpack-cleanup-failure-");
  const sourceDir = await tempDir("veslo-skill-package-unpack-cleanup-source-");
  await writeFile(join(targetDir, "existing.txt"), "remove me\n", "utf8");
  await writeFile(join(sourceDir, "SKILL.md"), "# Installed\n", "utf8");
  const archive = await packSkillDirectory(sourceDir);
  let backupPath: string | undefined;

  await __skillPackageTestHooks.unpackSkillPackageWithFileSystem(
    { archive, targetDir },
    {
      rm: async (path, options) => {
        if (String(path).includes(".backup-")) {
          backupPath = String(path);
          throw new Error("cleanup failed");
        }
        await rm(path, options);
      },
    },
  );

  expect(await readFile(join(targetDir, "SKILL.md"), "utf8")).toBe("# Installed\n");
  await expect(readFile(join(targetDir, "existing.txt"), "utf8")).rejects.toThrow();
  if (backupPath) {
    await rm(backupPath, { recursive: true, force: true });
  }
});
