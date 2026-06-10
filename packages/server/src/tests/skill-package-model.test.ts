import { expect, test } from "bun:test";

import {
  buildSkillPackageManifest,
  normalizeSkillPackageFiles,
  validateSkillPackageManifest,
} from "../skill-package-model.js";
import type { SkillPackageFile } from "../skill-package-model.js";

const sha = (character: string) => character.repeat(64);

const packageFile = (overrides: Partial<SkillPackageFile> = {}): SkillPackageFile => ({
  path: "SKILL.md",
  sha256: sha("a"),
  sizeBytes: 12,
  mediaType: "text/markdown",
  ...overrides,
});

test("a package requires SKILL.md", async () => {
  await expect(
    buildSkillPackageManifest({
      metadata: { name: "research" },
      files: [packageFile({ path: "README.md" })],
    }),
  ).rejects.toThrow(/SKILL\.md/);
});

test("package file paths must be relative", () => {
  expect(() => normalizeSkillPackageFiles([packageFile({ path: "/SKILL.md" })])).toThrow(/relative/);
});

test("package file paths reject traversal", () => {
  expect(() => normalizeSkillPackageFiles([packageFile({ path: "docs/../SKILL.md" })])).toThrow(/\.\./);
});

test("package file paths reject colons", () => {
  expect(() => normalizeSkillPackageFiles([packageFile({ path: "scripts/setup:ads.sh" })])).toThrow(/:/);
});

test("package file paths reject Windows reserved basenames", () => {
  expect(() => normalizeSkillPackageFiles([packageFile({ path: "scripts/CON.txt" })])).toThrow(/reserved/i);
  expect(() => normalizeSkillPackageFiles([packageFile({ path: "scripts/com1.sh" })])).toThrow(/reserved/i);
});

test("package file paths reject segments ending in spaces or dots", () => {
  expect(() => normalizeSkillPackageFiles([packageFile({ path: "scripts/setup./SKILL.md" })])).toThrow(/end/i);
  expect(() => normalizeSkillPackageFiles([packageFile({ path: "scripts/setup /SKILL.md" })])).toThrow(/end/i);
});

test("duplicate normalized package file paths are rejected", () => {
  expect(() =>
    normalizeSkillPackageFiles([
      packageFile({ path: "SKILL.md" }),
      packageFile({ path: "./SKILL.md", sha256: sha("b") }),
    ]),
  ).toThrow(/duplicate/i);
});

test("executable metadata is preserved", async () => {
  const manifest = await buildSkillPackageManifest({
    metadata: { name: "research" },
    files: [
      packageFile(),
      packageFile({
        path: "scripts/./install.sh",
        sha256: sha("b"),
        sizeBytes: 24,
        mediaType: "text/x-shellscript",
        executable: true,
      }),
    ],
  });

  expect(manifest.files.find((file) => file.path === "scripts/install.sh")?.executable).toBe(true);
});

test("package hash changes when any file content hash changes", async () => {
  const first = await buildSkillPackageManifest({
    metadata: { name: "research" },
    files: [packageFile({ sha256: sha("a") })],
  });
  const second = await buildSkillPackageManifest({
    metadata: { name: "research" },
    files: [packageFile({ sha256: sha("b") })],
  });

  expect(first.packageSha256).not.toBe(second.packageSha256);
});

test("manifest validation rejects a package hash that does not match normalized content", async () => {
  const manifest = await buildSkillPackageManifest({
    metadata: { name: "research", description: "Research skill" },
    files: [packageFile()],
  });

  await expect(
    (async () =>
      validateSkillPackageManifest({
        ...manifest,
        files: [{ ...manifest.files[0]!, sha256: sha("b") }],
      }))(),
  ).rejects.toThrow(/packageSha256/);
});

test("manifest validation rejects embedded text tampering", async () => {
  const manifest = await buildSkillPackageManifest({
    metadata: { name: "research" },
    files: [packageFile({ text: "# Original skill\n" })],
  });

  await expect(
    (async () =>
      validateSkillPackageManifest({
        ...manifest,
        files: [{ ...manifest.files[0]!, text: "# Tampered skill\n" }],
      }))(),
  ).rejects.toThrow(/packageSha256/);
});
