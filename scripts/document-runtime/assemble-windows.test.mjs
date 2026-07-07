import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  assembleWindowsDocumentRuntime,
  buildRuntimeManifest,
  computeManifestSha256,
  ensureDownloadedSources,
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