#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DOCUMENT_RUNTIME_PACKAGE_ID,
  validateDocumentRuntimeManifest,
  validatePackageFeed,
} from "../../packages/document-runtime/src/index.mjs";

const WINDOWS_PLATFORM = "windows-native-x64";
const LOCAL_DOCS_REQUIRED = "local-docs-required";
const REMOTE_DOCS_ONLY = "remote-docs-only";
const WINDOWS_RUNTIME_RESOURCE_KEY = "resources/document-runtime/windows-native-x64";
const WINDOWS_RUNTIME_RESOURCE_TARGET = "document-runtime";
const REQUIRED_BINARIES = ["soffice", "pandoc", "pdftoppm", "pdftotext", "pdfimages", "qpdf", "python", "node", "weasyprint"];

const readText = (filePath) => readFileSync(filePath, "utf8");
const readJson = (filePath) => JSON.parse(readText(filePath));

const add = (checks, label, ok, detail = "") => {
  checks.push({ label, ok: Boolean(ok), detail });
};

const parseArgs = (argv) => {
  const repoRoot = resolve(import.meta.dirname, "../..");
  const options = {
    repoRoot,
    profile: process.env.VESLO_DOCUMENT_RUNTIME_RELEASE_PROFILE || LOCAL_DOCS_REQUIRED,
    resourceDir:
      process.env.VESLO_DOCUMENT_RUNTIME_WINDOWS_RESOURCE_DIR ||
      resolve(repoRoot, "packages/desktop/src-tauri/resources/document-runtime/windows-native-x64"),
    feedPath:
      process.env.VESLO_DOCUMENT_RUNTIME_PACKAGE_FEED ||
      resolve(repoRoot, "packages/document-runtime/manifests/package-feed.example.json"),
    manifestPath: resolve(repoRoot, "packages/document-runtime/manifests/targets/windows-native-x64.json"),
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
    if (arg === "--resource-dir") {
      options.resourceDir = resolve(argv[index + 1] || options.resourceDir);
      index += 1;
      continue;
    }
    if (arg === "--package-dir") {
      options.resourceDir = resolve(argv[index + 1] || options.resourceDir);
      index += 1;
      continue;
    }
    if (arg === "--feed") {
      options.feedPath = resolve(argv[index + 1] || options.feedPath);
      index += 1;
      continue;
    }
    if (arg === "--manifest") {
      options.manifestPath = resolve(argv[index + 1] || options.manifestPath);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
};

const findWindowsPackage = (feed) => {
  return feed.packages.find((entry) => entry.packageId === DOCUMENT_RUNTIME_PACKAGE_ID && entry.platform === WINDOWS_PLATFORM);
};

const commandExists = (binDir, command) => {
  return [".exe", ".cmd", ".bat", ""].some((suffix) => {
    const path = join(binDir, `${command}${suffix}`);
    return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;
  });
};

const verifyWslPolicy = ({ repoRoot, checks }) => {
  const tauriConfigPath = resolve(repoRoot, "packages/desktop/src-tauri/tauri.conf.json");
  const wxsPath = resolve(repoRoot, "packages/desktop/src-tauri/windows/wsl2-sandbox-installer.wxs");
  const nsisPath = resolve(repoRoot, "packages/desktop/src-tauri/windows/nsis-hooks.nsh");

  const tauriConfig = existsSync(tauriConfigPath) ? readJson(tauriConfigPath) : {};
  const resources = tauriConfig.bundle?.resources ?? {};
  const wxs = existsSync(wxsPath) ? readText(wxsPath) : "";
  const nsis = existsSync(nsisPath) ? readText(nsisPath) : "";

  add(
    checks,
    "Windows document runtime keeps WSL installer disabled by default",
    /Property\s+Id="VESLO_ENABLE_WSL_INSTALLER"\s+Value="0"/.test(wxs) &&
      /Custom Action="VesloProvisionWslSandbox"\s+After="InstallFiles"><!\[CDATA\[VESLO_ENABLE_WSL_INSTALLER="1" AND NOT REMOVE~="ALL"\]\]><\/Custom>/.test(wxs) &&
      /!ifdef VESLO_ENABLE_WSL_INSTALLER/.test(nsis) &&
      /Skipping Veslo WSL runtime preparation/.test(nsis),
    wxsPath,
  );

  add(
    checks,
    "Windows document runtime does not use WSL scripts as package readiness",
    resources["windows/wsl2-client-installer.ps1"] === "wsl2-client-installer.ps1" &&
      resources[WINDOWS_RUNTIME_RESOURCE_KEY] === WINDOWS_RUNTIME_RESOURCE_TARGET &&
      !/document-runtime/i.test(nsis) &&
      !/veslo-document-runtime/i.test(wxs),
    tauriConfigPath,
  );
};

const verifyBundledResourceTree = ({ checks, resourceDir, targetManifest }) => {
  const manifestPath = join(resourceDir, "manifest.json");
  add(
    checks,
    "Windows native document runtime bundled resource directory exists",
    existsSync(resourceDir) && statSync(resourceDir).isDirectory(),
    resourceDir,
  );
  if (!existsSync(resourceDir) || !statSync(resourceDir).isDirectory()) return;

  let bundledManifest = null;
  try {
    bundledManifest = validateDocumentRuntimeManifest(readJson(manifestPath), { label: manifestPath });
    add(checks, "Windows native bundled document runtime manifest is valid", bundledManifest.platform === WINDOWS_PLATFORM, manifestPath);
  } catch (error) {
    add(checks, "Windows native bundled document runtime manifest is valid", false, error.message);
  }

  if (targetManifest && bundledManifest) {
    add(
      checks,
      "Windows native bundled document runtime version matches target manifest",
      bundledManifest.packageVersion === targetManifest.packageVersion && bundledManifest.version === targetManifest.version,
      `${bundledManifest.packageVersion}/${bundledManifest.version}`,
    );
  }

  const binDir = join(resourceDir, "bin");
  add(checks, "Windows native bundled document runtime bin directory exists", existsSync(binDir) && statSync(binDir).isDirectory(), binDir);
  for (const command of REQUIRED_BINARIES) {
    add(checks, `Windows native bundled document runtime includes ${command}`, commandExists(binDir, command), binDir);
  }
  for (const directory of ["fonts", "python", "node_modules"]) {
    const path = join(resourceDir, directory);
    add(checks, `Windows native bundled document runtime includes ${directory} directory`, existsSync(path) && statSync(path).isDirectory(), path);
  }
};

export function verifyDocumentRuntimeWindows(options = {}) {
  const checks = [];
  const profile = options.profile || LOCAL_DOCS_REQUIRED;
  const repoRoot = options.repoRoot || resolve(import.meta.dirname, "../..");
  const manifestPath = options.manifestPath || resolve(repoRoot, "packages/document-runtime/manifests/targets/windows-native-x64.json");
  const feedPath = options.feedPath || resolve(repoRoot, "packages/document-runtime/manifests/package-feed.example.json");
  const resourceDir = options.resourceDir || options.packageDir || resolve(repoRoot, "packages/desktop/src-tauri/resources/document-runtime/windows-native-x64");

  verifyWslPolicy({ repoRoot, checks });

  let targetManifest = null;
  try {
    targetManifest = validateDocumentRuntimeManifest(readJson(manifestPath), { label: manifestPath });
    add(checks, "Windows native document runtime target manifest is valid", targetManifest.platform === WINDOWS_PLATFORM, manifestPath);
  } catch (error) {
    add(checks, "Windows native document runtime target manifest is valid", false, error.message);
  }

  let feed = null;
  let windowsEntry = null;
  try {
    feed = validatePackageFeed(readJson(feedPath), { label: feedPath });
    windowsEntry = findWindowsPackage(feed);
    add(checks, "Document runtime package feed contains Windows native package", Boolean(windowsEntry), feedPath);
  } catch (error) {
    add(checks, "Document runtime package feed contains Windows native package", false, error.message);
  }

  if (profile === REMOTE_DOCS_ONLY) {
    add(checks, "Remote-docs-only profile does not require local Windows bundled runtime", true, profile);
  } else if (profile !== LOCAL_DOCS_REQUIRED) {
    add(checks, "Document runtime release profile is recognized", false, profile);
  } else {
    verifyBundledResourceTree({ checks, resourceDir, targetManifest });
  }

  return {
    ok: checks.every((check) => check.ok),
    profile,
    platform: WINDOWS_PLATFORM,
    resourceDir,
    feedPath,
    manifestPath,
    checks,
  };
}

const maybeRunCli = () => {
  if (resolve(process.argv[1] || "") !== fileURLToPath(import.meta.url)) return;

  try {
    const options = parseArgs(process.argv);
    const report = verifyDocumentRuntimeWindows(options);
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
