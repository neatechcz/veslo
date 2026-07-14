import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const traceMirrorDir = resolve(repoRoot, ".tmp");
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
  VESLO_SEND_WORKFLOW_TRACE_MIRROR_FILE: resolve(traceMirrorDir, "send-workflow-trace.ndjson"),
  VESLO_SEND_WORKFLOW_TRACE_CONSOLE: "1",
  VITE_VESLO_SEND_WORKFLOW_TRACE: "1",
  VITE_VESLO_SESSION_UI_MUTATION_TRACE: "1",
  VESLO_OPENCODE_HEALTH_DIAG: "1",
  RUST_BACKTRACE: "1",
});

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

run(["-C", "packages/desktop", "prepare:sidecar", "--", "--force"]);
run(["dev", ...process.argv.slice(2)], runtimeLoggingEnv);
