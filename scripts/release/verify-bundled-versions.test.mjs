import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { findBundledVersionsManifest } from "./verify-bundled-versions.mjs";

const writeText = (filePath, value) => {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, "utf8");
};

test("finds versions.json inside the extracted macOS app bundle even when the app name is not Veslo.app", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "veslo-bundled-versions-"));

  try {
    const manifestPath = join(
      fixtureRoot,
      "Veslo by Neatech.app",
      "Contents",
      "MacOS",
      "versions.json",
    );
    writeText(manifestPath, "{\n}\n");

    const found = findBundledVersionsManifest(fixtureRoot, {
      targetTriple: "x86_64-apple-darwin",
    });

    assert.equal(found, manifestPath);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("falls back to a target-suffixed versions manifest when needed", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "veslo-bundled-versions-"));

  try {
    const manifestPath = join(
      fixtureRoot,
      "Veslo by Neatech.app",
      "Contents",
      "MacOS",
      "versions.json-aarch64-apple-darwin",
    );
    writeText(manifestPath, "{\n}\n");

    const found = findBundledVersionsManifest(fixtureRoot, {
      targetTriple: "aarch64-apple-darwin",
    });

    assert.equal(found, manifestPath);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
