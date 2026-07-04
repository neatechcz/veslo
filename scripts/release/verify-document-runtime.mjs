#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyDocumentRuntimePackages } from "./verify-document-runtime-packages.mjs";

const LOCAL_DOCS_REQUIRED = "local-docs-required";

const parseArgs = (argv) => {
  const repoRoot = resolve(import.meta.dirname, "../..");
  const options = {
    repoRoot,
    profile: process.env.VESLO_DOCUMENT_RUNTIME_RELEASE_PROFILE || LOCAL_DOCS_REQUIRED,
    feedPath: process.env.VESLO_DOCUMENT_RUNTIME_PACKAGE_FEED || "",
    manifestRoot: "",
    windowsPackageDir: process.env.VESLO_DOCUMENT_RUNTIME_WINDOWS_PACKAGE_DIR || "",
    macosPackageDir: process.env.VESLO_DOCUMENT_RUNTIME_MACOS_PACKAGE_DIR || "",
    json: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--repo-root") {
      options.repoRoot = resolve(argv[index + 1] || options.repoRoot);
      index += 1;
      continue;
    }
    if (arg === "--profile") {
      options.profile = argv[index + 1] || options.profile;
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
    if (arg === "--windows-package-dir") {
      options.windowsPackageDir = resolve(argv[index + 1] || options.windowsPackageDir);
      index += 1;
      continue;
    }
    if (arg === "--macos-package-dir") {
      options.macosPackageDir = resolve(argv[index + 1] || options.macosPackageDir);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
};

export function verifyDocumentRuntime(options = {}) {
  const packages = verifyDocumentRuntimePackages(options);
  return {
    ok: packages.ok,
    profile: packages.profile,
    checks: packages.checks,
    packages,
  };
}

const maybeRunCli = () => {
  if (resolve(process.argv[1] || "") !== fileURLToPath(import.meta.url)) return;

  try {
    const options = parseArgs(process.argv);
    const report = verifyDocumentRuntime(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      for (const check of report.checks) {
        process.stdout.write(
          `${check.ok ? "PASS" : "FAIL"} [${check.scope}] ${check.label}${check.detail ? ` (${check.detail})` : ""}\n`,
        );
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
