import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

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

const writeFakeTool = (binDir, name) => {
  if (process.platform === "win32") {
    writeText(join(binDir, `${name}.cmd`), `@echo off\r\necho ${name} 1.0.0\r\nexit /b 0\r\n`);
    return;
  }
  const path = join(binDir, name);
  writeText(path, `#!/bin/sh\necho "${name} 1.0.0"\nexit 0\n`);
  chmodSync(path, 0o755);
};

const createRuntimeFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "veslo-document-runtime-cli-"));
  const active = join(root, "2026.7.0");
  const bin = join(active, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(active, "fonts"), { recursive: true });
  writeText(join(root, "active.json"), JSON.stringify({ version: "2026.7.0" }, null, 2));
  writeText(join(active, "manifest.json"), JSON.stringify(manifest, null, 2));
  for (const name of ["soffice", "pandoc", "pdftoppm", "pdftotext", "pdfimages", "qpdf", "weasyprint", "python", "node"]) {
    writeFakeTool(bin, name);
  }
  return { root, active };
};

test("CLI doctor --json emits stable machine-readable diagnostics", () => {
  const fixture = createRuntimeFixture();
  try {
    const result = spawnSync(process.execPath, ["src/cli.mjs", "doctor", "--json"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        VESLO_DOCUMENT_RUNTIME_ROOT: fixture.root,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "ready");
    assert.equal(payload.packageId, "veslo-document-runtime");
    assert.equal(payload.packageVersion, "2026.7.0");
    assert.ok(Array.isArray(payload.checks));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("CLI path --json does not expose host PATH as managed PATH", () => {
  const fixture = createRuntimeFixture();
  try {
    const result = spawnSync(process.execPath, ["src/cli.mjs", "path", "--json"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        PATH: "host-path",
        VESLO_DOCUMENT_RUNTIME_ROOT: fixture.root,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.notEqual(payload.env.PATH, "host-path");
    assert.match(payload.env.PATH, /bin$/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("CLI exec resolves commands from the managed runtime bin directory", () => {
  const fixture = createRuntimeFixture();
  try {
    const result = spawnSync(process.execPath, ["src/cli.mjs", "exec", "--", "node", "--version"], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        PATH: "host-path",
        VESLO_DOCUMENT_RUNTIME_ROOT: fixture.root,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /node 1\.0\.0/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("CLI stage --headless stages and activates an expanded runtime package", () => {
  const source = createRuntimeFixture();
  const runtimeRoot = mkdtempSync(join(tmpdir(), "veslo-document-runtime-cli-stage-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["src/cli.mjs", "stage", "--headless", "--source", source.active, "--activate"],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          VESLO_DOCUMENT_RUNTIME_ROOT: runtimeRoot,
        },
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.staged, true);
    assert.equal(payload.activated, true);
    const pointer = JSON.parse(readFileSync(join(runtimeRoot, "active.json"), "utf8"));
    assert.equal(pointer.activePath, "packages/2026.7.0");
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("CLI pack and install --headless create and activate a package artifact", () => {
  const source = createRuntimeFixture();
  const packageRoot = mkdtempSync(join(tmpdir(), "veslo-document-runtime-cli-package-"));
  const runtimeRoot = mkdtempSync(join(tmpdir(), "veslo-document-runtime-cli-install-"));
  const packagePath = join(packageRoot, "veslo-document-runtime-windows-native-x64-2026.7.0.veslopkg");
  try {
    const packResult = spawnSync(
      process.execPath,
      ["src/cli.mjs", "pack", "--headless", "--source", source.active, "--output", packagePath],
      {
        cwd: new URL("..", import.meta.url),
        env: process.env,
        encoding: "utf8",
      },
    );

    assert.equal(packResult.status, 0, packResult.stderr);
    const packed = JSON.parse(packResult.stdout);
    assert.equal(packed.ok, true);
    assert.equal(packed.status, "packed");
    assert.equal(packed.contentSha256.length, 64);

    const installResult = spawnSync(
      process.execPath,
      [
        "src/cli.mjs",
        "install",
        "--headless",
        "--package",
        packagePath,
        "--sha256",
        packed.contentSha256,
        "--activate",
      ],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          VESLO_DOCUMENT_RUNTIME_ROOT: runtimeRoot,
        },
        encoding: "utf8",
      },
    );

    assert.equal(installResult.status, 0, installResult.stderr);
    const installed = JSON.parse(installResult.stdout);
    assert.equal(installed.ok, true);
    assert.equal(installed.installed, true);
    assert.equal(installed.activated, true);
    const pointer = JSON.parse(readFileSync(join(runtimeRoot, "active.json"), "utf8"));
    assert.equal(pointer.activePath, "packages/2026.7.0");
  } finally {
    rmSync(source.root, { recursive: true, force: true });
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
