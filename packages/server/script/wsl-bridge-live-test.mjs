import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  ...process.env,
  VESLO_LIVE_WSL_NETWORK_TEST: "1",
};

const result = spawnSync(
  "bun",
  ["test", "src/tests/server.wsl-bridge-live.test.ts"],
  {
    cwd: root,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

process.exit(result.status ?? 1);
