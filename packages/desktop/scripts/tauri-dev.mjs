#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main as cleanupDevProcesses } from "./cleanup-dev-processes.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const desktopDir = resolve(__dirname, "..");
const serverDir = resolve(desktopDir, "..", "server");
const tauriCli = require.resolve("@tauri-apps/cli/tauri.js");

const readPort = () => {
  const value = Number.parseInt(process.env.PORT ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : 5173;
};

const port = readPort();
const dataDir = process.env.VESLO_DATA_DIR?.trim() || join(homedir(), ".veslo", "veslo-orchestrator-dev");
const env = {
  ...process.env,
  PORT: String(port),
  VESLO_DATA_DIR: dataDir,
  VESLO_SERVER_DEV_WATCH: process.env.VESLO_SERVER_DEV_WATCH?.trim() || "1",
  VESLO_SERVER_DEV_DIR: process.env.VESLO_SERVER_DEV_DIR?.trim() || serverDir,
};

if (process.platform === "win32" && process.env.VESLO_DEV_CLEANUP !== "0") {
  const cleanupStatus = cleanupDevProcesses(["--quiet-empty"]);
  if (cleanupStatus !== 0) {
    process.exit(cleanupStatus);
  }
}

const args = [
  "dev",
  "--config",
  "src-tauri/tauri.dev.conf.json",
  "--config",
  JSON.stringify({ build: { devUrl: `http://localhost:${port}` } }),
  ...process.argv.slice(2),
];

const child = spawn(process.execPath, [tauriCli, ...args], {
  cwd: desktopDir,
  env,
  stdio: "inherit",
});

let exiting = false;

const forwardSignal = (signal) => {
  if (exiting) return;
  try {
    child.kill(signal);
  } catch {
    // ignore
  }
};

process.once("SIGINT", () => forwardSignal("SIGINT"));
process.once("SIGTERM", () => forwardSignal("SIGTERM"));

child.once("error", (error) => {
  exiting = true;
  console.error(`[veslo] Failed to start Tauri dev runtime: ${error.message}`);
  process.exit(1);
});

child.once("exit", (code, signal) => {
  exiting = true;
  if (signal) {
    process.exit(0);
  }
  process.exit(code ?? 0);
});
