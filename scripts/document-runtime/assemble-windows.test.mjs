import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  assembleWindowsDocumentRuntime,
  buildRuntimeManifest,
  computeManifestSha256,
  ensureDownloadedSources,
  extractArchive,
  findFileByName,
  fixVenvPyvenvCfg,
  installNode,
  runCommandWithRetry,
  runMsiAdministrativeInstall,
  verifyDownloadedSource,
} from "./assemble-windows.mjs";
import { validateDocumentRuntimeManifest } from "../../packages/document-runtime/src/index.mjs";

const sha = (char) => char.repeat(64);

const inventory = {
  pythonPackages: ["defusedxml", "weasyprint"],
  nodePackages: ["docx", "pdf-lib"],
  fonts: ["DejaVu", "Noto Core"],
};

const template = {
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

const writeText = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
};

test("computes stable manifest hashes from assembled package directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "veslo-docrt-manifest-"));
  try {
    await writeText(join(root, "fonts", "NotoSans", "NotoSans-Regular.ttf"), "font-bytes");
    await writeText(join(root, "python", "venv", "Lib", "site-packages", "weasyprint.py"), "python-bytes");
    await writeText(join(root, "node_modules", "pdf-lib", "index.js"), "node-bytes");

    const manifest = await buildRuntimeManifest({ targetDir: root, inventory, targetTemplate: template });
    validateDocumentRuntimeManifest(manifest);

    assert.match(manifest.manifestSha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.manifestSha256, computeManifestSha256(manifest));
    assert.notEqual(manifest.pythonPackagesHash, template.pythonPackagesHash);
    assert.notEqual(manifest.nodePackagesHash, template.nodePackagesHash);
    assert.notEqual(manifest.fontsHash, template.fontsHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dry-run assembly creates the expected runtime layout and manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "veslo-docrt-layout-"));
  try {
    const targetDir = join(root, "runtime");
    const result = await assembleWindowsDocumentRuntime({ targetDir, dryRun: true });

    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.manifest.platform, "windows-native-x64");
    assert.match(result.manifest.manifestSha256, /^[a-f0-9]{64}$/);

    for (const command of ["soffice", "pandoc", "pdftoppm", "pdftotext", "pdfimages", "qpdf", "python", "node", "weasyprint"]) {
      await assert.doesNotReject(() => import("node:fs/promises").then(({ stat }) => stat(join(targetDir, "bin", `${command}.cmd`))));
    }
    await assert.doesNotReject(() => import("node:fs/promises").then(({ stat }) => stat(join(targetDir, "fonts", "DejaVu", "DejaVuSans.ttf"))));
    await assert.doesNotReject(() => import("node:fs/promises").then(({ stat }) => stat(join(targetDir, "node_modules", ".dry-run"))));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("download lock rejects sha256 mismatches", async () => {
  const root = await mkdtemp(join(tmpdir(), "veslo-docrt-hash-"));
  try {
    const artifact = join(root, "artifact.zip");
    await writeText(artifact, "real-bytes");

    await assert.rejects(
      () => verifyDownloadedSource({
        source: { id: "fixture", sizeBytes: 10 },
        filePath: artifact,
        lockEntry: { sha256: sha("0"), sizeBytes: 10 },
      }),
      /sha256 mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mocked downloader records TOFU lock values without network", async () => {
  const root = await mkdtemp(join(tmpdir(), "veslo-docrt-lock-"));
  try {
    const manifest = {
      schemaVersion: 1,
      packageId: "veslo-document-runtime",
      platform: "windows-native-x64",
      sources: [
        { id: "libreoffice", version: "1", url: "https://example.test/libre.msi", sizeBytes: 5, kind: "msi" },
        { id: "poppler", version: "1", url: "https://example.test/poppler.zip", sizeBytes: 5, kind: "zip" },
        { id: "pandoc", version: "1", url: "https://example.test/pandoc.zip", sizeBytes: null, kind: "zip" },
        { id: "qpdf", version: "1", url: "https://example.test/qpdf.zip", sizeBytes: null, kind: "zip" },
        { id: "python", version: "1", url: "https://example.test/python.tar.gz", sizeBytes: 5, kind: "tar.gz" },
        { id: "node", version: "1", url: "https://example.test/node.zip", sizeBytes: 5, kind: "zip" },
        { id: "dejavu-fonts", version: "1", url: "https://example.test/dejavu.zip", sizeBytes: 5, kind: "zip" },
        { id: "noto-sans", version: "1", url: "https://example.test/noto.zip", sizeBytes: 5, kind: "zip" },
        { id: "liberation-fonts", kind: "deferred", status: "deferred" },
      ],
    };

    const lockPath = join(root, "windows-native-x64.lock.json");
    const result = await ensureDownloadedSources({
      manifest,
      cacheDir: join(root, "cache"),
      lockPath,
      downloader: async (_source, outputPath) => {
        await writeText(outputPath, "12345");
      },
    });

    assert.equal(result.lockChanged, true);
    assert.equal(Object.keys(result.downloads).length, 8);
    const lock = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(lockPath, "utf8")));
    assert.match(lock.entries.libreoffice.sha256, /^[a-f0-9]{64}$/);
    assert.equal(lock.entries.pandoc.sizeBytes, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("msiexec administrative install logs verbosely and retries once", async () => {
  const root = await mkdtemp(join(tmpdir(), "veslo-docrt-msi-retry-"));
  try {
    const adminDir = join(root, "lo");
    const logPath = join(root, "lo-msi.log");
    const calls = [];

    await runMsiAdministrativeInstall({
      msiPath: join(root, "LibreOffice.msi"),
      adminDir,
      logPath,
      runner: async (command, args, options) => {
        calls.push({ command, args, options });
        if (calls.length === 1) throw new Error("transient lock");
      },
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].command, "msiexec.exe");
    assert.deepEqual(calls[1].args, calls[0].args);
    assert.ok(calls[0].args.includes("/L*V"));
    assert.equal(calls[0].args[calls[0].args.indexOf("/L*V") + 1], logPath);
    assert.ok(calls[0].args.includes(`TARGETDIR=${adminDir}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("msiexec administrative install failure includes utf16 verbose log tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "veslo-docrt-msi-log-"));
  try {
    const logPath = join(root, "lo-msi.log");
    await assert.rejects(
      () => runMsiAdministrativeInstall({
        msiPath: join(root, "LibreOffice.msi"),
        adminDir: join(root, "lo"),
        logPath,
        runner: async () => {
          await writeFile(logPath, Buffer.from(`${"x".repeat(4100)}\nError 1304. Error writing to file fastjsonschema_validations.py`, "utf16le"));
          throw new Error("msiexec failed with code 1603");
        },
      }),
      /msiexec failed with code 1603[\s\S]*msiexec verbose log tail[\s\S]*Error 1304[\s\S]*fastjsonschema_validations\.py/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("file lookup prefers the shallowest matching executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "veslo-docrt-find-"));
  try {
    const shallowPython = join(root, "python", "python.exe");
    const templatePython = join(root, "python", "Lib", "venv", "scripts", "nt", "python.exe");
    await mkdir(dirname(shallowPython), { recursive: true });
    await mkdir(dirname(templatePython), { recursive: true });
    await writeFile(templatePython, "venv launcher template");
    await writeFile(shallowPython, "standalone interpreter");

    assert.equal(await findFileByName(root, "python.exe"), shallowPython);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("archive extraction prefers System32 tar over ambient PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "veslo-docrt-tar-"));
  const previousSystemRoot = process.env.SystemRoot;
  const previousWindir = process.env.windir;
  try {
    const archivePath = join(root, "artifact.zip");
    const destination = join(root, "extract");
    const systemRoot = join(root, "Windows");
    const systemTar = join(systemRoot, "System32", "tar.exe");
    process.env.SystemRoot = systemRoot;
    delete process.env.windir;
    await writeText(archivePath, "zip-bytes");
    await writeText(systemTar, "fake-tar");

    const calls = [];
    await extractArchive(archivePath, destination, async (command, args, options) => {
      calls.push({ command, args, options });
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, systemTar);
    assert.deepEqual(calls[0].args, ["-xf", archivePath, "-C", destination]);
    assert.equal(calls[0].options.timeoutMs, 15 * 60 * 1000);
  } finally {
    if (previousSystemRoot === undefined) {
      delete process.env.SystemRoot;
    } else {
      process.env.SystemRoot = previousSystemRoot;
    }
    if (previousWindir === undefined) {
      delete process.env.windir;
    } else {
      process.env.windir = previousWindir;
    }
    await rm(root, { recursive: true, force: true });
  }
});
test("fixVenvPyvenvCfg rewrites staging paths to the final target", async () => {
  const root = await mkdtemp(join(tmpdir(), "veslo-docrt-venv-"));
  try {
    const stagingDir = join(root, "windows-native-x64.staging-1234-5678");
    const targetDir = join(root, "windows-native-x64");
    const venvDir = join(targetDir, "python", "venv");
    await mkdir(venvDir, { recursive: true });
    await writeFile(join(venvDir, "pyvenv.cfg"), [
      `home = ${join(stagingDir, "python", "runtime")}`,
      `executable = ${join(stagingDir, "python", "runtime", "python.exe")}`,
      `command = ${join(stagingDir, "python", "runtime", "python.exe")} -m venv ${join(stagingDir, "python", "venv")}`,
      "include-system-site-packages = false",
      "",
    ].join("\n"), "utf8");

    await fixVenvPyvenvCfg(venvDir, stagingDir, targetDir);

    const updated = await readFile(join(venvDir, "pyvenv.cfg"), "utf8");
    assert.ok(updated.includes(join(targetDir, "python", "runtime")));
    assert.ok(updated.includes(join(targetDir, "python", "venv")));
    assert.ok(!updated.includes(stagingDir));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("installNode runs npm through node.exe instead of npm.cmd", async () => {
  const root = await mkdtemp(join(tmpdir(), "veslo-docrt-node-"));
  try {
    const workDir = join(root, "work");
    const targetDir = join(root, "target");
    const installCalls = [];
    const runner = async (command, args) => {
      if (args.includes("-xf") && args.includes("-C")) {
        const destination = args[args.indexOf("-C") + 1];
        const nodeRoot = join(destination, "node-v22.23.1-win-x64");
        await mkdir(join(nodeRoot, "node_modules", "npm", "bin"), { recursive: true });
        await writeFile(join(nodeRoot, "node.exe"), "node binary");
        await writeFile(join(nodeRoot, "npm.cmd"), "npm wrapper");
        await writeFile(join(nodeRoot, "node_modules", "npm", "bin", "npm-cli.js"), "npm cli");
        return;
      }
      installCalls.push({ command, args });
    };

    await installNode({ filePath: join(root, "node.zip") }, workDir, targetDir, { nodePackages: ["docx"] }, runner);

    const runtimeNode = join(targetDir, "node", "runtime", "node.exe");
    const runtimeNpmCli = join(targetDir, "node", "runtime", "node_modules", "npm", "bin", "npm-cli.js");
    assert.equal(installCalls.length, 1);
    assert.equal(installCalls[0].command, runtimeNode);
    assert.equal(installCalls[0].args[0], runtimeNpmCli);
    assert.equal(installCalls[0].args[1], "install");
    assert.ok(!installCalls[0].command.endsWith("npm.cmd"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("runCommandWithRetry succeeds when a later attempt succeeds", async () => {
  const calls = [];
  const result = await runCommandWithRetry("python.exe", ["-m", "venv", "venv"], { timeoutMs: 1000 }, {
    attempts: 3,
    delayMs: 0,
    runner: async (command, args, options) => {
      calls.push({ command, args, options });
      if (calls.length < 3) throw new Error(`temporary failure ${calls.length}`);
      return { stdout: "ready", stderr: "" };
    },
  });

  assert.deepEqual(result, { stdout: "ready", stderr: "" });
  assert.equal(calls.length, 3);
  assert.equal(calls.every((call) => call.command === "python.exe"), true);
  assert.deepEqual(calls[0].args, ["-m", "venv", "venv"]);
});

test("runCommandWithRetry fails with aggregated attempt errors", async () => {
  let attempts = 0;
  await assert.rejects(
    () => runCommandWithRetry("npm.cmd", ["install"], {}, {
      attempts: 2,
      delayMs: 0,
      runner: async () => {
        attempts += 1;
        throw new Error(`failure ${attempts}`);
      },
    }),
    /npm\.cmd install failed after 2 attempts\.[\s\S]*attempt 1: failure 1[\s\S]*attempt 2: failure 2/,
  );
  assert.equal(attempts, 2);
});
