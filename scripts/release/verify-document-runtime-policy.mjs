#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyDocumentRuntimeWindows } from "./verify-document-runtime-windows.mjs";

const POLICY_CHECK_LABELS = new Set([
  "Windows document runtime keeps WSL installer disabled by default",
  "Windows document runtime does not use WSL scripts as package readiness",
]);

const parseArgs = (argv) => {
  const options = {
    repoRoot: resolve(import.meta.dirname, "../.."),
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
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
};

export function verifyDocumentRuntimePolicy(options = {}) {
  const repoRoot = options.repoRoot || resolve(import.meta.dirname, "../..");
  const windows = verifyDocumentRuntimeWindows({
    repoRoot,
    profile: "remote-docs-only",
  });
  const checks = windows.checks
    .filter((check) => POLICY_CHECK_LABELS.has(check.label))
    .map((check) => ({ scope: "windows", ...check }));

  return {
    ok: checks.length === POLICY_CHECK_LABELS.size && checks.every((check) => check.ok),
    checks,
  };
}

const maybeRunCli = () => {
  if (resolve(process.argv[1] || "") !== fileURLToPath(import.meta.url)) return;

  try {
    const options = parseArgs(process.argv);
    const report = verifyDocumentRuntimePolicy(options);
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
