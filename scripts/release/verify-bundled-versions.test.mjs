import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  findBundledVersionsManifest,
  verifyBundledSidecars,
} from "./verify-bundled-versions.mjs";

const writeText = (filePath, value) => {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, "utf8");
};

const executableContent = "#!/bin/sh\nexit 0\n";
const managedDepsContent = "{}\n";
const sha256Text = (value) => createHash("sha256").update(value).digest("hex");

const writeExecutable = (filePath) => {
  writeText(filePath, executableContent);
  chmodSync(filePath, 0o755);
};

const versionsManifest = (overrides = {}) =>
  JSON.stringify(
    {
    "veslo-code": {
      version: "1.0.0",
      sha256: sha256Text(executableContent),
    },
    "veslo-server": {
      version: "1.0.0",
      sha256: sha256Text(executableContent),
    },
    "veslo-code-router": {
      version: "1.0.0",
      sha256: sha256Text(executableContent),
    },
    "veslo-orchestrator": {
      version: "1.0.0",
      sha256: sha256Text(executableContent),
    },
    "chrome-devtools-mcp": {
      version: "1.0.0",
      sha256: sha256Text(executableContent),
    },
    "opencode-managed-deps": {
      version: "1.0.0",
      sha256: sha256Text(managedDepsContent),
    },
    ...overrides,
    },
    null,
    2,
  );

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

test("verifies bundled sidecars and manifest hashes in an extracted macOS app bundle", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "veslo-bundled-sidecars-"));

  try {
    const appPath = join(fixtureRoot, "Veslo by Neatech.app");
    const macosPath = join(appPath, "Contents", "MacOS");
    const targetTriple = "aarch64-apple-darwin";
    writeText(join(macosPath, `versions.json-${targetTriple}`), versionsManifest());
    for (const name of [
      "veslo-code",
      "opencode",
      "veslo-server",
      "veslo-code-router",
      "veslo-orchestrator",
      "chrome-devtools-mcp",
    ]) {
      writeExecutable(join(macosPath, `${name}-${targetTriple}`));
    }
    writeText(join(macosPath, `opencode-managed-deps.json-${targetTriple}`), managedDepsContent);

    const result = verifyBundledSidecars(fixtureRoot, { targetTriple });

    assert.equal(result.manifestPath, join(macosPath, `versions.json-${targetTriple}`));
    assert.deepEqual(
      result.sidecars.map((sidecar) => sidecar.name),
      [
        "veslo-code",
        "opencode",
        "veslo-server",
        "veslo-code-router",
        "veslo-orchestrator",
        "chrome-devtools-mcp",
        "opencode-managed-deps.json",
      ],
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("fails when the bundled Veslo server sidecar is missing", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "veslo-bundled-sidecars-missing-"));

  try {
    const appPath = join(fixtureRoot, "Veslo by Neatech.app");
    const macosPath = join(appPath, "Contents", "MacOS");
    const targetTriple = "aarch64-apple-darwin";
    writeText(join(macosPath, `versions.json-${targetTriple}`), versionsManifest());
    for (const name of [
      "veslo-code",
      "opencode",
      "veslo-code-router",
      "veslo-orchestrator",
      "chrome-devtools-mcp",
    ]) {
      writeExecutable(join(macosPath, `${name}-${targetTriple}`));
    }
    writeText(join(macosPath, `opencode-managed-deps.json-${targetTriple}`), managedDepsContent);

    assert.throws(
      () => verifyBundledSidecars(fixtureRoot, { targetTriple }),
      /veslo-server missing from bundle/,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("verifies bundled sidecars in a Windows target release directory", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "veslo-bundled-windows-sidecars-"));

  try {
    const targetTriple = "x86_64-pc-windows-msvc";
    writeText(join(fixtureRoot, `versions.json-${targetTriple}.exe`), versionsManifest());
    for (const name of [
      "veslo-code",
      "opencode",
      "veslo-server",
      "veslo-code-router",
      "veslo-orchestrator",
      "chrome-devtools-mcp",
    ]) {
      writeExecutable(join(fixtureRoot, `${name}-${targetTriple}.exe`));
    }
    writeText(join(fixtureRoot, `opencode-managed-deps.json-${targetTriple}.exe`), managedDepsContent);

    const result = verifyBundledSidecars(fixtureRoot, { targetTriple });

    assert.equal(result.appPath, fixtureRoot);
    assert.equal(result.manifestPath, join(fixtureRoot, `versions.json-${targetTriple}.exe`));
    assert.deepEqual(
      result.sidecars.map((sidecar) => sidecar.name),
      [
        "veslo-code",
        "opencode",
        "veslo-server",
        "veslo-code-router",
        "veslo-orchestrator",
        "chrome-devtools-mcp",
        "opencode-managed-deps.json",
      ],
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("fails when the bundled sidecar hash does not match versions.json", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "veslo-bundled-sidecars-hash-mismatch-"));

  try {
    const appPath = join(fixtureRoot, "Veslo by Neatech.app");
    const macosPath = join(appPath, "Contents", "MacOS");
    const targetTriple = "aarch64-apple-darwin";
    writeText(
      join(macosPath, `versions.json-${targetTriple}`),
      versionsManifest({
        "veslo-server": {
          version: "1.0.0",
          sha256: "0".repeat(64),
        },
      }),
    );
    for (const name of [
      "veslo-code",
      "opencode",
      "veslo-server",
      "veslo-code-router",
      "veslo-orchestrator",
      "chrome-devtools-mcp",
    ]) {
      writeExecutable(join(macosPath, `${name}-${targetTriple}`));
    }
    writeText(join(macosPath, `opencode-managed-deps.json-${targetTriple}`), managedDepsContent);

    assert.throws(
      () => verifyBundledSidecars(fixtureRoot, { targetTriple }),
      /sha256 mismatch for veslo-server/,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
