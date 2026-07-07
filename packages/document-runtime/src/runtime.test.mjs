import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  buildManagedEnv,
  doctor,
  installPackageArchive,
  packExpandedPackage,
  pathInfo,
  repairHeadless,
  resolveActiveRuntime,
  resolveManagedCommand,
  stageExpandedPackage,
} from "./runtime.mjs";

const sha = (char) => char.repeat(64);

const manifest = {
  schemaVersion: 1,
  packageId: "veslo-document-runtime",
  runtimeId: "veslo-document-runtime",
  packageVersion: "2026.7.0",
  version: "2026.7.0",
  platform: "windows-native-x64",
  channel: "stable",
  minimumAppVersion: "2026.7.0",
  tools: {
    soffice: "24.8.x",
    pandoc: "3.6.x",
    poppler: "24.x",
    qpdf: "11.x",
    python: "3.11.x",
    node: "22.x",
  },
  manifestSha256: sha("1"),
  pythonPackagesHash: sha("2"),
  nodePackagesHash: sha("3"),
  fontsHash: sha("4"),
};

const writeText = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
};

const writeArchive = (path, entries) => {
  writeFileSync(path, gzipSync(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`));
};

const writeFakeTool = (binDir, name, output = `${name} ok`) => {
  if (process.platform === "win32") {
    const path = join(binDir, `${name}.cmd`);
    writeText(path, `@echo off\r\necho ${output}\r\nexit /b 0\r\n`);
    return path;
  }
  const path = join(binDir, name);
  writeText(path, `#!/bin/sh\necho "${output}"\nexit 0\n`);
  chmodSync(path, 0o755);
  return path;
};

const createRuntimeFixture = (options = {}) => {
  const root = mkdtempSync(join(tmpdir(), "veslo-document-runtime-"));
  const activeRelative = options.activeRelative ?? "2026.7.0";
  const active = join(root, activeRelative);
  const bin = join(active, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(active, "fonts"), { recursive: true });
  if (options.writeActivePointer !== false) {
    writeText(join(root, "active.json"), JSON.stringify({ activePath: activeRelative.replace(/\\/g, "/") }, null, 2));
  }
  writeText(join(active, "manifest.json"), JSON.stringify(manifest, null, 2));
  for (const name of ["soffice", "pandoc", "pdftoppm", "pdftotext", "pdfimages", "qpdf", "weasyprint", "python", "node"]) {
    writeFakeTool(bin, name, `${name} 1.0.0`);
  }
  return { root, active, bin };
};

test("doctor returns ready JSON for a complete managed runtime package", async () => {
  const fixture = createRuntimeFixture();
  try {
    const result = await doctor({
      env: { VESLO_DOCUMENT_RUNTIME_ROOT: fixture.root },
      timeoutMs: 1000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "ready");
    assert.equal(result.packageId, "veslo-document-runtime");
    assert.equal(result.packageVersion, "2026.7.0");
    assert.equal(result.checks.every((check) => check.ok), true);
    assert.deepEqual(
      result.checks.map((check) => check.id),
      [
        "manifest",
        "soffice",
        "pandoc",
        "poppler-pdftoppm",
        "poppler-pdftotext",
        "poppler-pdfimages",
        "qpdf",
        "weasyprint",
        "python-imports",
        "node-modules",
        "fonts",
      ],
    );
    assert.ok(result.checks.find((check) => check.id === "python-imports"));
    assert.ok(result.checks.find((check) => check.id === "node-modules"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("doctor reports missing instead of falling back to host PATH", async () => {
  const fixture = createRuntimeFixture();
  try {
    const missingName = process.platform === "win32" ? "soffice.cmd" : "soffice";
    rmSync(join(fixture.bin, missingName), { force: true });

    const result = await doctor({
      env: {
        VESLO_DOCUMENT_RUNTIME_ROOT: fixture.root,
        PATH: process.env.PATH || "",
      },
      timeoutMs: 1000,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.match(
      result.checks.find((check) => check.id === "soffice").error,
      /Managed command 'soffice' not found/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("doctor fails when a documented managed PDF command is missing", async () => {
  const fixture = createRuntimeFixture();
  try {
    const missingName = process.platform === "win32" ? "qpdf.cmd" : "qpdf";
    rmSync(join(fixture.bin, missingName), { force: true });

    const result = await doctor({
      env: { VESLO_DOCUMENT_RUNTIME_ROOT: fixture.root },
      timeoutMs: 1000,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.match(
      result.checks.find((check) => check.id === "qpdf").error,
      /Managed command 'qpdf' not found/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("managed env is isolated from the host PATH", () => {
  const active = join("C:", "runtime", "2026.7.0");
  const env = buildManagedEnv(active, { env: { PATH: "host-path", NODE_PATH: "host-node" } });
  assert.equal(env.PATH, join(active, "bin"));
  assert.equal(env.NODE_PATH, join(active, "node_modules"));
  assert.equal(env.PYTHONPATH.includes("site-packages"), true);
});

test("path info exposes deterministic managed locations", async () => {
  const fixture = createRuntimeFixture();
  try {
    const result = await pathInfo({ env: { VESLO_DOCUMENT_RUNTIME_ROOT: fixture.root } });
    assert.equal(result.ok, true);
    assert.equal(result.activePath, fixture.active);
    assert.equal(result.binDir, fixture.bin);
    assert.equal(result.env.PATH, fixture.bin);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("resolveManagedCommand rejects command paths", async () => {
  const fixture = createRuntimeFixture();
  try {
    await assert.rejects(
      () => resolveManagedCommand(fixture.active, `.${basename(fixture.active)}`),
      /not found/,
    );
    await assert.rejects(
      () => resolveManagedCommand(fixture.active, `bin${process.platform === "win32" ? "\\" : "/"}node`),
      /bare command name/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("headless repair reports current readiness without package-manager side effects", async () => {
  const fixture = createRuntimeFixture();
  try {
    const result = await repairHeadless({
      env: { VESLO_DOCUMENT_RUNTIME_ROOT: fixture.root },
      timeoutMs: 1000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.repaired, false);
    assert.equal(result.status, "ready");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("headless repair activates a ready staged package when active pointer is missing", async () => {
  const fixture = createRuntimeFixture({
    activeRelative: join("packages", "2026.7.0"),
    writeActivePointer: false,
  });
  try {
    const beforeRepair = await doctor({
      env: { VESLO_DOCUMENT_RUNTIME_ROOT: fixture.root },
      timeoutMs: 1000,
    });
    assert.equal(beforeRepair.ok, false);
    assert.equal(beforeRepair.status, "missing");
    assert.equal(beforeRepair.repairAvailable, true);

    const result = await repairHeadless({
      env: { VESLO_DOCUMENT_RUNTIME_ROOT: fixture.root },
      timeoutMs: 1000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "ready");
    assert.equal(result.repaired, true);
    assert.match(result.reason, /Activated staged document runtime package 2026\.7\.0/);

    const pointer = JSON.parse(readFileSync(join(fixture.root, "active.json"), "utf8"));
    assert.equal(pointer.activePath, "packages/2026.7.0");

    const repairedPath = await pathInfo({ env: { VESLO_DOCUMENT_RUNTIME_ROOT: fixture.root } });
    assert.equal(repairedPath.ok, true);
    assert.equal(repairedPath.activePath, fixture.active);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});


test("resolveActiveRuntime falls back to bundled resource runtime when active pointer is missing", async () => {
  const bundled = createRuntimeFixture({ writeActivePointer: false });
  const runtimeRoot = mkdtempSync(join(tmpdir(), "veslo-document-runtime-empty-root-"));
  try {
    const result = await resolveActiveRuntime({
      env: {
        VESLO_DOCUMENT_RUNTIME_ROOT: runtimeRoot,
        VESLO_DOCUMENT_RUNTIME_BUNDLED_DIR: bundled.active,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.source, "bundled-resource");
    assert.equal(result.activePath, bundled.active);
    assert.equal(result.runtimeRoot, runtimeRoot);
  } finally {
    rmSync(bundled.root, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("resolveActiveRuntime keeps staged active pointer ahead of bundled resource fallback", async () => {
  const active = createRuntimeFixture();
  const bundled = createRuntimeFixture({ writeActivePointer: false });
  try {
    const result = await resolveActiveRuntime({
      env: {
        VESLO_DOCUMENT_RUNTIME_ROOT: active.root,
        VESLO_DOCUMENT_RUNTIME_BUNDLED_DIR: bundled.active,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.source, "active.json");
    assert.equal(result.activePath, active.active);
  } finally {
    rmSync(active.root, { recursive: true, force: true });
    rmSync(bundled.root, { recursive: true, force: true });
  }
});
test("stageExpandedPackage copies, doctors, and activates an expanded package", async () => {
  const source = createRuntimeFixture();
  const runtimeRoot = mkdtempSync(join(tmpdir(), "veslo-document-runtime-stage-target-"));
  try {
    const result = await stageExpandedPackage({
      sourceDir: source.active,
      env: { VESLO_DOCUMENT_RUNTIME_ROOT: runtimeRoot },
      activate: true,
      timeoutMs: 1000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.staged, true);
    assert.equal(result.activated, true);
    assert.equal(result.packageVersion, "2026.7.0");
    assert.equal(result.activePath, join(runtimeRoot, "packages", "2026.7.0"));

    const pointer = JSON.parse(readFileSync(join(runtimeRoot, "active.json"), "utf8"));
    assert.equal(pointer.activePath, "packages/2026.7.0");

    const stagedPath = await pathInfo({ env: { VESLO_DOCUMENT_RUNTIME_ROOT: runtimeRoot } });
    assert.equal(stagedPath.ok, true);
    assert.equal(stagedPath.activePath, result.activePath);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("stageExpandedPackage rejects expanded packages that fail doctor checks", async () => {
  const source = createRuntimeFixture();
  const runtimeRoot = mkdtempSync(join(tmpdir(), "veslo-document-runtime-stage-target-"));
  try {
    const missingName = process.platform === "win32" ? "node.cmd" : "node";
    rmSync(join(source.bin, missingName), { force: true });

    const result = await stageExpandedPackage({
      sourceDir: source.active,
      env: { VESLO_DOCUMENT_RUNTIME_ROOT: runtimeRoot },
      activate: true,
      timeoutMs: 1000,
    });

    assert.equal(result.ok, false);
    assert.equal(result.staged, false);
    assert.equal(result.activated, false);
    assert.match(
      result.doctor.checks.find((check) => check.id === "node-modules").error,
      /Managed command 'node' not found/,
    );
    const info = await pathInfo({ env: { VESLO_DOCUMENT_RUNTIME_ROOT: runtimeRoot } });
    assert.equal(info.ok, false);
    assert.throws(() => readFileSync(join(runtimeRoot, "active.json"), "utf8"));
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("package archive packs, verifies, installs, doctors, and activates headlessly", async () => {
  const source = createRuntimeFixture();
  const packageRoot = mkdtempSync(join(tmpdir(), "veslo-document-runtime-archive-"));
  const runtimeRoot = mkdtempSync(join(tmpdir(), "veslo-document-runtime-install-target-"));
  const packagePath = join(packageRoot, "veslo-document-runtime-windows-native-x64-2026.7.0.veslopkg");
  try {
    const packed = await packExpandedPackage({
      sourceDir: source.active,
      outputPath: packagePath,
    });

    assert.equal(packed.ok, true);
    assert.equal(packed.status, "packed");
    assert.equal(packed.fileCount > 0, true);
    assert.equal(packed.contentSha256.length, 64);

    const result = await installPackageArchive({
      packagePath,
      expectedSha256: packed.contentSha256,
      env: { VESLO_DOCUMENT_RUNTIME_ROOT: runtimeRoot },
      activate: true,
      timeoutMs: 1000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.installed, true);
    assert.equal(result.activated, true);
    assert.equal(result.packageVersion, "2026.7.0");
    assert.equal(result.artifactSha256, packed.contentSha256);

    const pointer = JSON.parse(readFileSync(join(runtimeRoot, "active.json"), "utf8"));
    assert.equal(pointer.activePath, "packages/2026.7.0");
    const installedPath = await pathInfo({ env: { VESLO_DOCUMENT_RUNTIME_ROOT: runtimeRoot } });
    assert.equal(installedPath.ok, true);
    assert.equal(installedPath.activePath, join(runtimeRoot, "packages", "2026.7.0"));
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("package archive install rejects sha256 mismatches without activating", async () => {
  const source = createRuntimeFixture();
  const packageRoot = mkdtempSync(join(tmpdir(), "veslo-document-runtime-archive-"));
  const runtimeRoot = mkdtempSync(join(tmpdir(), "veslo-document-runtime-install-target-"));
  const packagePath = join(packageRoot, "veslo-document-runtime-windows-native-x64-2026.7.0.veslopkg");
  try {
    await packExpandedPackage({
      sourceDir: source.active,
      outputPath: packagePath,
    });

    const result = await installPackageArchive({
      packagePath,
      expectedSha256: sha("0"),
      env: { VESLO_DOCUMENT_RUNTIME_ROOT: runtimeRoot },
      activate: true,
      timeoutMs: 1000,
    });

    assert.equal(result.ok, false);
    assert.equal(result.installed, false);
    assert.equal(result.activated, false);
    assert.match(result.reason, /sha256 mismatch/);

    const info = await pathInfo({ env: { VESLO_DOCUMENT_RUNTIME_ROOT: runtimeRoot } });
    assert.equal(info.ok, false);
    assert.throws(() => readFileSync(join(runtimeRoot, "active.json"), "utf8"));
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("package archive install rejects unsafe archive paths without activating", async () => {
  const packageRoot = mkdtempSync(join(tmpdir(), "veslo-document-runtime-unsafe-archive-"));
  const runtimeRoot = mkdtempSync(join(tmpdir(), "veslo-document-runtime-unsafe-install-"));
  const packagePath = join(packageRoot, "veslo-document-runtime-windows-native-x64-2026.7.0.veslopkg");
  try {
    writeArchive(packagePath, [
      {
        schemaVersion: 1,
        type: "header",
        packageId: "veslo-document-runtime",
        archiveFormat: "veslo-document-runtime-package-v1",
        packageVersion: "2026.7.0",
        runtimeVersion: "2026.7.0",
        platform: "windows-native-x64",
        createdAt: "2026-07-02T00:00:00.000Z",
      },
      {
        type: "file",
        path: "../manifest.json",
        mode: 0o644,
        sizeBytes: 0,
      },
      {
        type: "endArchive",
        directoryCount: 0,
        fileCount: 0,
      },
    ]);

    const result = await installPackageArchive({
      packagePath,
      env: { VESLO_DOCUMENT_RUNTIME_ROOT: runtimeRoot },
      activate: true,
      timeoutMs: 1000,
    });

    assert.equal(result.ok, false);
    assert.equal(result.installed, false);
    assert.equal(result.activated, false);
    assert.match(result.reason, /unsafe/);

    const info = await pathInfo({ env: { VESLO_DOCUMENT_RUNTIME_ROOT: runtimeRoot } });
    assert.equal(info.ok, false);
    assert.throws(() => readFileSync(join(runtimeRoot, "active.json"), "utf8"));
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
