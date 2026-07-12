import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  publishBundledNodeExecutable,
  resolveBundledNodeRuntimeDistribution,
  validateBundledNodeArchiveEntries,
  verifyBundledNodeArchiveChecksum,
} from "./bundled-node-runtime.mjs";

test("selects the official pinned Node distribution for Apple Silicon", () => {
  assert.deepEqual(
    resolveBundledNodeRuntimeDistribution({
      version: "22.20.0",
      platform: "darwin",
      targetTriple: "aarch64-apple-darwin",
    }),
    {
      archiveName: "node-v22.20.0-darwin-arm64.tar.gz",
      distributionDirectory: "node-v22.20.0-darwin-arm64",
      executablePathParts: ["node-v22.20.0-darwin-arm64", "bin", "node"],
      shasumsUrl: "https://nodejs.org/dist/v22.20.0/SHASUMS256.txt",
      url: "https://nodejs.org/dist/v22.20.0/node-v22.20.0-darwin-arm64.tar.gz",
    },
  );
});

test("selects the official pinned Node distribution for Intel macOS", () => {
  assert.deepEqual(
    resolveBundledNodeRuntimeDistribution({
      version: "22.20.0",
      platform: "darwin",
      targetTriple: "x86_64-apple-darwin",
    }),
    {
      archiveName: "node-v22.20.0-darwin-x64.tar.gz",
      distributionDirectory: "node-v22.20.0-darwin-x64",
      executablePathParts: ["node-v22.20.0-darwin-x64", "bin", "node"],
      shasumsUrl: "https://nodejs.org/dist/v22.20.0/SHASUMS256.txt",
      url: "https://nodejs.org/dist/v22.20.0/node-v22.20.0-darwin-x64.tar.gz",
    },
  );
});

test("rejects unsupported bundled Node targets with a stable error", () => {
  assert.throws(
    () =>
      resolveBundledNodeRuntimeDistribution({
        version: "22.20.0",
        platform: "darwin",
        targetTriple: "armv7-apple-darwin",
      }),
    {
      message: "Unsupported bundled Node.js target: darwin/armv7-apple-darwin",
    },
  );
});

test("rejects a bundled Node archive checksum mismatch", () => {
  const root = mkdtempSync(join(tmpdir(), "veslo-node-checksum-test-"));
  try {
    const archivePath = join(root, "node.tar.gz");
    writeFileSync(archivePath, "tampered archive");
    assert.throws(
      () => verifyBundledNodeArchiveChecksum({
        archivePath,
        archiveName: "node-v22.20.0-darwin-arm64.tar.gz",
        shasums: `${"0".repeat(64)}  node-v22.20.0-darwin-arm64.tar.gz\n`,
      }),
      /Bundled Node\.js archive checksum mismatch/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects traversal and unexpected bundled Node archive entries", () => {
  assert.throws(
    () => validateBundledNodeArchiveEntries({
      entries: ["node-v22.20.0-darwin-arm64/bin/node", "../escape"],
      distributionDirectory: "node-v22.20.0-darwin-arm64",
    }),
    /unsafe entry/,
  );
  assert.throws(
    () => validateBundledNodeArchiveEntries({
      entries: ["different-prefix/bin/node"],
      distributionDirectory: "node-v22.20.0-darwin-arm64",
    }),
    /unexpected entry prefix/,
  );
});

test("atomically publishes regular executable bundled Node copies", () => {
  const root = mkdtempSync(join(tmpdir(), "veslo-node-publish-test-"));
  try {
    const sourcePath = join(root, "source-node");
    const sidecarDir = join(root, "sidecars");
    const basePath = join(sidecarDir, "veslo-node");
    const targetPath = join(sidecarDir, "veslo-node-aarch64-apple-darwin");
    writeFileSync(sourcePath, "verified node executable");
    chmodSync(sourcePath, 0o755);

    publishBundledNodeExecutable({ sourcePath, targetPaths: [basePath, targetPath] });

    for (const target of [basePath, targetPath]) {
      assert.equal(readFileSync(target, "utf8"), "verified node executable");
      assert.equal(lstatSync(target).isFile(), true);
      assert.equal(lstatSync(target).isSymbolicLink(), false);
      assert.notEqual(lstatSync(target).mode & 0o111, 0);
    }
    assert.deepEqual(readdirSync(sidecarDir).sort(), [
      "veslo-node",
      "veslo-node-aarch64-apple-darwin",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
