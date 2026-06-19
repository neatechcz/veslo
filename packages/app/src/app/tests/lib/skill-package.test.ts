import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSkillPackageManifest,
  normalizeSkillPackageFiles,
  validateSkillPackageManifest,
} from "../../lib/skill-package.js";
import type { SkillPackageFile } from "../../types.js";

const sha = (character: string) => character.repeat(64);

const packageFile = (overrides: Partial<SkillPackageFile> = {}): SkillPackageFile => ({
  path: "SKILL.md",
  sha256: sha("a"),
  sizeBytes: 12,
  mediaType: "text/markdown",
  ...overrides,
});

test("a package requires SKILL.md", async () => {
  await assert.rejects(
    buildSkillPackageManifest({
      metadata: { name: "research" },
      files: [packageFile({ path: "README.md" })],
    }),
    /SKILL\.md/,
  );
});

test("package file paths must be relative", () => {
  assert.throws(
    () => normalizeSkillPackageFiles([packageFile({ path: "/SKILL.md" })]),
    /relative/,
  );
});

test("package file paths reject traversal", () => {
  assert.throws(
    () => normalizeSkillPackageFiles([packageFile({ path: "docs/../SKILL.md" })]),
    /\.\./,
  );
});

test("package file paths reject colons", () => {
  assert.throws(
    () => normalizeSkillPackageFiles([packageFile({ path: "scripts/setup:ads.sh" })]),
    /:/,
  );
});

test("package file paths reject Windows reserved basenames", () => {
  assert.throws(
    () => normalizeSkillPackageFiles([packageFile({ path: "scripts/CON.txt" })]),
    /reserved/i,
  );
  assert.throws(
    () => normalizeSkillPackageFiles([packageFile({ path: "scripts/com1.sh" })]),
    /reserved/i,
  );
});

test("package file paths reject segments ending in spaces or dots", () => {
  assert.throws(
    () => normalizeSkillPackageFiles([packageFile({ path: "scripts/setup./SKILL.md" })]),
    /end/i,
  );
  assert.throws(
    () => normalizeSkillPackageFiles([packageFile({ path: "scripts/setup /SKILL.md" })]),
    /end/i,
  );
});

test("duplicate normalized package file paths are rejected", () => {
  assert.throws(
    () =>
      normalizeSkillPackageFiles([
        packageFile({ path: "SKILL.md" }),
        packageFile({ path: "./SKILL.md", sha256: sha("b") }),
      ]),
    /duplicate/i,
  );
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

  assert.equal(manifest.files.find((file) => file.path === "scripts/install.sh")?.executable, true);
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

  assert.notEqual(first.packageSha256, second.packageSha256);
});

test("manifest validation rejects a package hash that does not match normalized content", async () => {
  const manifest = await buildSkillPackageManifest({
    metadata: { name: "research", description: "Research skill" },
    files: [packageFile()],
  });

  await assert.rejects(
    async () =>
      validateSkillPackageManifest({
        ...manifest,
        files: [{ ...manifest.files[0]!, sha256: sha("b") }],
      }),
    /packageSha256/,
  );
});

test("manifest validation rejects embedded text tampering", async () => {
  const manifest = await buildSkillPackageManifest({
    metadata: { name: "research" },
    files: [packageFile({ text: "# Original skill\n" })],
  });

  await assert.rejects(
    async () =>
      validateSkillPackageManifest({
        ...manifest,
        files: [{ ...manifest.files[0]!, text: "# Tampered skill\n" }],
      }),
    /packageSha256/,
  );
});
