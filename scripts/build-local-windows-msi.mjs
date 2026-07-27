import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const targetTriple = process.env.TARGET_TRIPLE?.trim() || "x86_64-pc-windows-msvc";
const desktopPackagePath = resolve(repoRoot, "packages", "desktop", "package.json");
const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"));
const version = String(desktopPackage.version || "local").trim();
const opencodeVersion = String(desktopPackage.opencodeVersion || "1.17.13").trim();

const run = (command, args, env) => {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
};

const resolvePnpm = () => {
  if (process.platform !== "win32") return { command: "pnpm", prefix: [] };
  const corepackPnpm = resolve(dirname(process.execPath), "node_modules", "corepack", "dist", "pnpm.js");
  return { command: process.execPath, prefix: [corepackPnpm] };
};

const gitSha = () => {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : "working-tree";
};

const outputDir = resolve(
  process.env.VESLO_LOCAL_MSI_OUTPUT_DIR?.trim() ||
    join(repoRoot, ".tmp", `veslo-msi-diagnostics-${gitSha()}`),
);
mkdirSync(outputDir, { recursive: true });
const localTauriConfigPath = join(outputDir, "tauri.local-msi.conf.json");
writeFileSync(
  localTauriConfigPath,
  `${JSON.stringify({ bundle: { createUpdaterArtifacts: false } }, null, 2)}\n`,
  "utf8",
);

const env = {
  ...process.env,
  TARGET_TRIPLE: targetTriple,
  OPENCODE_VERSION: opencodeVersion,
  VESLO_SIDECAR_FORCE_BUILD: "1",
  VESLO_USER_DIAGNOSTIC_CAPTURE: "1",
  VESLO_DEPLOYMENT_DOMAIN: "veslo.work",
  VITE_VESLO_DEPLOYMENT_DOMAIN: "veslo.work",
  VESLO_DEFAULT_RUNTIME_DIAGNOSTICS: "1",
  VESLO_RUNTIME_DIAGNOSTICS: "1",
  VITE_VESLO_RUNTIME_DIAGNOSTICS: "1",
  VESLO_RUNTIME_TRACE: "1",
  VESLO_SEND_WORKFLOW_TRACE: "1",
  VESLO_SEND_WORKFLOW_TRACE_CONSOLE: "1",
  VITE_VESLO_SEND_WORKFLOW_TRACE: "1",
  VITE_VESLO_SESSION_UI_MUTATION_TRACE: "1",
  VITE_VESLO_UI_EFFECT_TRACE: "1",
  VESLO_OPENCODE_HEALTH_DIAG: "1",
  RUST_BACKTRACE: "1",
};

const pnpm = resolvePnpm();
const pnpmArgs = (args) => [...pnpm.prefix, ...args];

if (dryRun) {
  console.log(JSON.stringify({ outputDir, targetTriple, version, opencodeVersion, diagnostics: true }, null, 2));
  process.exit(0);
}

console.log(`Building diagnostic Windows MSI ${version} for ${targetTriple}`);
console.log(`Output: ${outputDir}`);

run(
  pnpm.command,
  pnpmArgs(["-C", "packages/desktop", "prepare:sidecar", "--", "--force"]),
  env,
);
run(
  pnpm.command,
  pnpmArgs([
    "--filter",
    "@neatech/veslo",
    "exec",
    "tauri",
    "build",
    "--config",
    "src-tauri/tauri.windows.conf.json",
    "--config",
    localTauriConfigPath,
    "--target",
    targetTriple,
    "--bundles",
    "msi",
  ]),
  env,
);

const bundleDir = resolve(
  repoRoot,
  "packages",
  "desktop",
  "src-tauri",
  "target",
  targetTriple,
  "release",
  "bundle",
  "msi",
);
const msiFiles = requireMsiFiles(bundleDir);
const msiSource = msiFiles[0];
const msiPath = join(outputDir, basename(msiSource));
copyFileSync(msiSource, msiPath);

const launcherPath = join(outputDir, "run-installed-veslo-with-diagnostics.cmd");
writeFileSync(
  launcherPath,
  `@echo off\r\n` +
    `set "VESLO_RUNTIME_DIAGNOSTICS=1"\r\n` +
    `set "VESLO_RUNTIME_TRACE=1"\r\n` +
    `set "VESLO_SEND_WORKFLOW_TRACE=1"\r\n` +
    `set "VESLO_SEND_WORKFLOW_TRACE_CONSOLE=1"\r\n` +
    `set "VESLO_OPENCODE_HEALTH_DIAG=1"\r\n` +
    `set "RUST_BACKTRACE=1"\r\n` +
    `set "TRACE_DIR=%LOCALAPPDATA%\\com.neatech.veslo\\logs\\support-diagnostics"\r\n` +
    `if not exist "%TRACE_DIR%" mkdir "%TRACE_DIR%"\r\n` +
    `set "VESLO_SEND_WORKFLOW_TRACE_MIRROR_FILE=%TRACE_DIR%\\send-workflow-trace-mirror.ndjson"\r\n` +
    `start "" /wait "%ProgramFiles%\\Veslo by Neatech\\veslo.exe"\r\n`,
  "utf8",
);

const sha256 = createHash("sha256").update(readFileSync(msiPath)).digest("hex");
const metadataPath = join(outputDir, "build-metadata.json");
writeFileSync(
  metadataPath,
  `${JSON.stringify(
    {
      version,
      commit: gitSha(),
      targetTriple,
      opencodeVersion,
      msiPath,
      sha256,
      diagnostics: {
        userCaptureCompileTime: true,
        runtimeDefaultCompileTime: true,
        frontendTraceCompileTime: true,
        launcherPath,
      },
    },
    null,
  )}\n`,
  "utf8",
);

console.log(`MSI: ${msiPath}`);
console.log(`Launcher: ${launcherPath}`);
console.log(`SHA-256: ${sha256}`);

function requireMsiFiles(bundlePath) {
  const files = readdirSync(bundlePath)
    .filter((name) => name.toLowerCase().endsWith(".msi"))
    .map((name) => join(bundlePath, name));
  if (files.length !== 1) {
    throw new Error(`Expected exactly one MSI in ${bundlePath}, found ${files.length}`);
  }
  return files;
}
