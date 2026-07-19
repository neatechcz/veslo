import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const traceMirrorDir = resolve(repoRoot, ".tmp");
const traceMirrorFile = resolve(traceMirrorDir, "send-workflow-trace.ndjson");
const deriveTraceChannelFile = (basePath, channel) =>
  basePath.toLowerCase().endsWith(".ndjson")
    ? `${basePath.slice(0, -".ndjson".length)}.${channel}.ndjson`
    : `${basePath}.${channel}`;
const traceMirrorFiles = [
  traceMirrorFile,
  ...["ui", "server", "orchestrator"].map((channel) => deriveTraceChannelFile(traceMirrorFile, channel)),
];
mkdirSync(traceMirrorDir, { recursive: true });

const resolvePnpmInvocation = () => {
  if (process.platform === "win32") {
    const corepackPnpm = resolve(dirname(process.execPath), "node_modules", "corepack", "dist", "pnpm.js");
    if (existsSync(corepackPnpm)) {
      return { command: process.execPath, prefixArgs: [corepackPnpm] };
    }
    return { command: "cmd.exe", prefixArgs: ["/d", "/s", "/c", "pnpm.cmd"] };
  }
  return { command: "pnpm", prefixArgs: [] };
};

const pnpm = resolvePnpmInvocation();

const withDefaultEnv = (defaults) => {
  const env = { ...process.env };
  for (const [name, value] of Object.entries(defaults)) {
    if (!env[name]?.trim()) env[name] = value;
  }
  return env;
};

const runtimeLoggingEnv = withDefaultEnv({
  VESLO_TAURI_PILOT: "1",
  VESLO_E2E: "1",
  VESLO_RUNTIME_DIAGNOSTICS: "1",
  VITE_VESLO_RUNTIME_DIAGNOSTICS: "1",
  VESLO_RUNTIME_TRACE: "1",
  VESLO_SEND_WORKFLOW_TRACE: "1",
  VESLO_SEND_WORKFLOW_TRACE_MIRROR_FILE: traceMirrorFile,
  VESLO_SEND_WORKFLOW_TRACE_CONSOLE: "1",
  VITE_VESLO_SEND_WORKFLOW_TRACE: "1",
  VITE_VESLO_SESSION_UI_MUTATION_TRACE: "1",
  VITE_VESLO_UI_EFFECT_TRACE: "1",
  VESLO_OPENCODE_HEALTH_DIAG: "1",
  RUST_BACKTRACE: "1",
});
// This team-support launcher intentionally compiles the native diagnostic
// capture control into its dev runtime. The capture implementation itself still
// requires a signed-in user and only accepts the production Den endpoint.
runtimeLoggingEnv.VESLO_USER_DIAGNOSTIC_CAPTURE = "1";
runtimeLoggingEnv.VESLO_DEPLOYMENT_DOMAIN = "veslo.work";

const run = (args, env = process.env) => {
  const result = spawnSync(pnpm.command, [...pnpm.prefixArgs, ...args], {
    cwd: repoRoot,
    stdio: "inherit",
    env,
  });

  if (result.error) {
    console.error(result.error.message);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

const clearTraceMirrors = () => {
  for (const file of traceMirrorFiles) rmSync(file, { force: true });
};

run(["-C", "packages/desktop", "prepare:sidecar", "--", "--force"]);
clearTraceMirrors();
run(["dev", ...process.argv.slice(2)], runtimeLoggingEnv);
