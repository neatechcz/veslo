#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  documentRuntimePackageAssetName,
  documentRuntimePackageSignatureName,
  validateDocumentRuntimeManifest,
  validatePackageFeed,
} from "../../packages/document-runtime/src/index.mjs";

const MACOS_PLATFORMS = ["macos-arm64", "macos-x64"];
const LOCAL_DOCS_REQUIRED = "local-docs-required";
const REMOTE_DOCS_ONLY = "remote-docs-only";
const REQUIRED_BINARIES = ["soffice", "pandoc", "pdftoppm", "pdftotext", "pdfimages", "qpdf", "python", "node", "weasyprint"];

const readJson = (filePath) => JSON.parse(readFileSync(filePath, "utf8"));
const add = (checks, label, ok, detail = "") => checks.push({ label, ok: Boolean(ok), detail });
const sha256File = (filePath) => createHash("sha256").update(readFileSync(filePath)).digest("hex");

const parseArgs = (argv) => {
  const repoRoot = resolve(import.meta.dirname, "../..");
  const options = {
    repoRoot,
    profile: process.env.VESLO_DOCUMENT_RUNTIME_RELEASE_PROFILE || LOCAL_DOCS_REQUIRED,
    packageDir:
      process.env.VESLO_DOCUMENT_RUNTIME_PACKAGE_DIR ||
      resolve(repoRoot, "packages/document-runtime/packages/macos"),
    resourceRoot:
      process.env.VESLO_DOCUMENT_RUNTIME_MACOS_RESOURCE_ROOT ||
      resolve(repoRoot, "packages/desktop/src-tauri/resources/document-runtime"),
    feedPath:
      process.env.VESLO_DOCUMENT_RUNTIME_PACKAGE_FEED ||
      resolve(repoRoot, "packages/document-runtime/manifests/package-feed.example.json"),
    manifestRoot: resolve(repoRoot, "packages/document-runtime/manifests/targets"),
    platforms: MACOS_PLATFORMS,
    json: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--profile") {
      options.profile = argv[index + 1] || options.profile;
      index += 1;
      continue;
    }
    if (arg === "--package-dir") {
      options.packageDir = resolve(argv[index + 1] || options.packageDir);
      index += 1;
      continue;
    }
    if (arg === "--resource-root") {
      options.resourceRoot = resolve(argv[index + 1] || options.resourceRoot);
      index += 1;
      continue;
    }
    if (arg === "--platform") {
      options.platforms = [argv[index + 1] || ""].filter(Boolean);
      index += 1;
      continue;
    }
    if (arg === "--feed") {
      options.feedPath = resolve(argv[index + 1] || options.feedPath);
      index += 1;
      continue;
    }
    if (arg === "--manifest-root") {
      options.manifestRoot = resolve(argv[index + 1] || options.manifestRoot);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
};

const findPlatformPackage = (feed, platform) => {
  return feed.packages.find((entry) => entry.packageId === "veslo-document-runtime" && entry.platform === platform);
};

const commandExists = (binDir, command) => {
  return ["", ".cmd", ".sh"].some((suffix) => {
    const path = join(binDir, `${command}${suffix}`);
    return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;
  });
};

const verifyBundledResourceTree = ({ checks, resourceRoot, platform, feedEntry }) => {
  const resourceDir = resolve(resourceRoot, platform);
  const manifestPath = join(resourceDir, "manifest.json");
  add(
    checks,
    `macOS document runtime bundled resource directory exists for ${platform}`,
    existsSync(resourceDir) && statSync(resourceDir).isDirectory(),
    resourceDir,
  );
  if (!existsSync(resourceDir) || !statSync(resourceDir).isDirectory()) return;

  let bundledManifest = null;
  try {
    bundledManifest = validateDocumentRuntimeManifest(readJson(manifestPath), { label: manifestPath });
    add(checks, `macOS bundled document runtime manifest is valid for ${platform}`, bundledManifest.platform === platform, manifestPath);
  } catch (error) {
    add(checks, `macOS bundled document runtime manifest is valid for ${platform}`, false, error.message);
  }

  if (feedEntry && bundledManifest) {
    add(
      checks,
      `macOS bundled document runtime version matches package feed for ${platform}`,
      bundledManifest.packageVersion === feedEntry.packageVersion,
      `${bundledManifest.packageVersion}/${bundledManifest.version}`,
    );
    add(
      checks,
      `macOS bundled document runtime manifest hash matches package feed for ${platform}`,
      bundledManifest.manifestSha256 === feedEntry.manifestSha256,
      bundledManifest.manifestSha256,
    );
  }

  const binDir = join(resourceDir, "bin");
  add(checks, `macOS bundled document runtime bin directory exists for ${platform}`, existsSync(binDir) && statSync(binDir).isDirectory(), binDir);
  for (const command of REQUIRED_BINARIES) {
    add(checks, `macOS bundled document runtime includes ${command} for ${platform}`, commandExists(binDir, command), binDir);
  }
  for (const directory of ["fonts", "python", "node_modules"]) {
    const path = join(resourceDir, directory);
    add(checks, `macOS bundled document runtime includes ${directory} for ${platform}`, existsSync(path) && statSync(path).isDirectory(), path);
  }
};

export function verifyDocumentRuntimeMacos(options = {}) {
  const checks = [];
  const repoRoot = options.repoRoot || resolve(import.meta.dirname, "../..");
  const profile = options.profile || LOCAL_DOCS_REQUIRED;
  const manifestRoot = options.manifestRoot || resolve(repoRoot, "packages/document-runtime/manifests/targets");
  const feedPath = options.feedPath || resolve(repoRoot, "packages/document-runtime/manifests/package-feed.example.json");
  const packageDir = options.packageDir || resolve(repoRoot, "packages/document-runtime/packages/macos");
  const resourceRoot = options.resourceRoot || resolve(repoRoot, "packages/desktop/src-tauri/resources/document-runtime");
  const platforms = Array.isArray(options.platforms) && options.platforms.length ? options.platforms : MACOS_PLATFORMS;

  let feed = null;
  try {
    feed = validatePackageFeed(readJson(feedPath), { label: feedPath });
    add(checks, "Document runtime package feed is valid", true, feedPath);
  } catch (error) {
    add(checks, "Document runtime package feed is valid", false, error.message);
  }

  for (const platform of platforms) {
    const manifestPath = resolve(manifestRoot, `${platform}.json`);
    let manifest = null;
    try {
      manifest = validateDocumentRuntimeManifest(readJson(manifestPath), { label: manifestPath });
      add(checks, `macOS document runtime manifest is valid for ${platform}`, manifest.platform === platform, manifestPath);
    } catch (error) {
      add(checks, `macOS document runtime manifest is valid for ${platform}`, false, error.message);
    }

    const entry = feed ? findPlatformPackage(feed, platform) : null;
    add(checks, `Document runtime package feed contains ${platform}`, Boolean(entry), feedPath);

    if (profile === REMOTE_DOCS_ONLY) continue;
    if (profile !== LOCAL_DOCS_REQUIRED) {
      add(checks, "Document runtime release profile is recognized", false, profile);
      continue;
    }
    if (!manifest || !entry) continue;

    const expectedName = entry.artifactName || documentRuntimePackageAssetName({
      platform,
      packageVersion: entry.packageVersion,
    });
    const expectedSignature = documentRuntimePackageSignatureName({
      platform,
      packageVersion: entry.packageVersion,
    });
    const packagePath = resolve(packageDir, expectedName);
    const signaturePath = resolve(packageDir, expectedSignature);

    add(
      checks,
      `macOS document runtime package name matches feed for ${platform}`,
      entry.artifactName === expectedName && basename(packagePath) === expectedName,
      expectedName,
    );
    add(
      checks,
      `macOS document runtime package artifact exists for ${platform}`,
      existsSync(packagePath) && statSync(packagePath).isFile() && statSync(packagePath).size > 0,
      packagePath,
    );
    if (existsSync(packagePath) && statSync(packagePath).isFile()) {
      const actualSha256 = sha256File(packagePath);
      add(
        checks,
        `macOS document runtime package sha256 matches feed for ${platform}`,
        actualSha256 === entry.contentSha256,
        actualSha256,
      );
    }
    add(
      checks,
      `macOS document runtime package signature exists for ${platform}`,
      existsSync(signaturePath) && statSync(signaturePath).isFile() && statSync(signaturePath).size > 0,
      signaturePath,
    );
    if (existsSync(signaturePath) && statSync(signaturePath).isFile()) {
      const actualSignature = readFileSync(signaturePath, "utf8").trim();
      add(
        checks,
        `macOS document runtime package signature matches feed for ${platform}`,
        actualSignature === entry.signature,
        signaturePath,
      );
    }
    verifyBundledResourceTree({ checks, resourceRoot, platform, feedEntry: entry });
  }

  if (profile === REMOTE_DOCS_ONLY) {
    add(checks, "Remote-docs-only profile does not require local macOS package artifacts", true, profile);
  }

  return {
    ok: checks.every((check) => check.ok),
    profile,
    platforms,
    packageDir,
    resourceRoot,
    feedPath,
    manifestRoot,
    checks,
  };
}

const maybeRunCli = () => {
  if (resolve(process.argv[1] || "") !== fileURLToPath(import.meta.url)) return;

  try {
    const options = parseArgs(process.argv);
    const report = verifyDocumentRuntimeMacos(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      for (const check of report.checks) {
        process.stdout.write(`${check.ok ? "PASS" : "FAIL"} ${check.label}${check.detail ? ` (${check.detail})` : ""}\n`);
      }
    }
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
};

maybeRunCli();
