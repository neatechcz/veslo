#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, "..");
const repoRoot = resolve(appDir, "..", "..");
const tauriDir = join(repoRoot, "packages", "desktop", "src-tauri");

function run(command, args, options = {}) {
  const printable = `${command} ${args.join(" ")}`;
  process.stdout.write(`\n[workspace-remove-safety] ${printable}\n`);
  execFileSync(command, args, {
    stdio: "inherit",
    ...options,
  });
}

try {
  run(
    "cargo",
    ["test", "workspace_forget", "--", "--nocapture"],
    {
      cwd: tauriDir,
      env: {
        ...process.env,
        TAURI_CONFIG: JSON.stringify({ bundle: { externalBin: [] } }),
      },
    },
  );

  run(
    "node",
    ["--test", "--import=tsx/esm", "src/app/context/workspace-forget-mode.test.ts"],
    { cwd: appDir },
  );

  process.stdout.write("\n[workspace-remove-safety] all checks passed\n");
} catch (error) {
  process.stderr.write("\n[workspace-remove-safety] checks failed\n");
  process.exit(1);
}
