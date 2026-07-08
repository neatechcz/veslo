#!/usr/bin/env node

import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import {
  DOCUMENT_RUNTIME_PACKAGE_ID,
  installPackageArchive,
  validatePackageFeed,
} from "../../packages/document-runtime/src/index.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");

const parseArgs = (argv) => {
  const options = {
    platform: "",
    feedPath:
      process.env.VESLO_DOCUMENT_RUNTIME_PACKAGE_FEED ||
      resolve(repoRoot, "packages/document-runtime/manifests/package-feed.example.json"),
    outputDir: "",
    cacheDir: resolve(repoRoot, "packages/document-runtime/packages/macos"),
    timeoutMs: Number(process.env.VESLO_DOCUMENT_RUNTIME_DOCTOR_TIMEOUT_MS || 120000),
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--platform") {
      options.platform = argv[++index] || "";
      continue;
    }
    if (arg === "--feed") {
      options.feedPath = resolve(argv[++index] || options.feedPath);
      continue;
    }
    if (arg === "--output-dir") {
      options.outputDir = resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--cache-dir") {
      options.cacheDir = resolve(argv[++index] || options.cacheDir);
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = Number(argv[++index] || options.timeoutMs);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.platform) throw new Error("install-package-resource requires --platform.");
  if (!options.outputDir) throw new Error("install-package-resource requires --output-dir.");
  return options;
};

const copyDirectory = async (source, target) => {
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: true });
};

const downloadPackage = async ({ entry, cacheDir }) => {
  await mkdir(cacheDir, { recursive: true });
  const outputPath = join(cacheDir, entry.artifactName || basename(new URL(entry.url).pathname));
  if (existsSync(outputPath)) return outputPath;

  const response = await fetch(entry.url, {
    headers: { "User-Agent": "veslo-document-runtime-resource-installer" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${entry.platform} document runtime package: HTTP ${response.status}`);
  }
  await pipeline(response.body, createWriteStream(outputPath));
  return outputPath;
};

export async function installPackageResource(options = {}) {
  const feed = validatePackageFeed(JSON.parse(readFileSync(options.feedPath, "utf8")), { label: options.feedPath });
  const entry = feed.packages.find(
    (candidate) => candidate.packageId === DOCUMENT_RUNTIME_PACKAGE_ID && candidate.platform === options.platform,
  );
  if (!entry) {
    throw new Error(`Document runtime package feed does not contain platform ${options.platform}.`);
  }

  const packagePath = await downloadPackage({ entry, cacheDir: options.cacheDir });
  await writeFile(join(options.cacheDir, `${entry.artifactName}.sig`), `${entry.signature}\n`, "utf8");
  const runtimeRoot = resolve(options.cacheDir, `.install-${options.platform}-${process.pid}-${Date.now()}`);
  await rm(runtimeRoot, { recursive: true, force: true });
  try {
    const installed = await installPackageArchive({
      packagePath,
      expectedSha256: entry.contentSha256,
      runtimeRoot,
      activate: true,
      timeoutMs: options.timeoutMs,
    });
    if (!installed.ok || !installed.activePath) {
      throw new Error(installed.reason || `Failed to install ${options.platform} document runtime package.`);
    }

    await copyDirectory(installed.activePath, options.outputDir);
    return {
      ok: true,
      platform: options.platform,
      packagePath,
      outputDir: options.outputDir,
      packageVersion: installed.packageVersion,
    };
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

const maybeRunCli = async () => {
  if (resolve(process.argv[1] || "") !== fileURLToPath(import.meta.url)) return;
  try {
    const result = await installPackageResource(parseArgs(process.argv));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  }
};

await maybeRunCli();
