import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

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
  VESLO_RUNTIME_TRACE: "1",
  VESLO_SEND_WORKFLOW_TRACE: "1",
  VESLO_SEND_WORKFLOW_TRACE_CONSOLE: "1",
  VITE_VESLO_SEND_WORKFLOW_TRACE: "1",
  VESLO_OPENCODE_HEALTH_DIAG: "1",
  RUST_BACKTRACE: "1",
});

const run = (args, env = process.env) => {
  const result = spawnSync(pnpm, args, {
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
