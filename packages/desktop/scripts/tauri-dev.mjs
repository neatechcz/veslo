#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main as cleanupDevProcesses } from "./cleanup-dev-processes.mjs";
import { loadDotEnv } from "../../../scripts/load-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const desktopDir = resolve(__dirname, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const serverDir = resolve(desktopDir, "..", "server");
const tauriCli = require.resolve("@tauri-apps/cli/tauri.js");

loadDotEnv({ cwd: repoRoot });

const readPort = () => {
  const value = Number.parseInt(process.env.PORT ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : 5173;
};

const port = readPort();
const defaultDataDir = () => {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim() || process.env.APPDATA?.trim();
    if (localAppData) {
      return join(localAppData, "com.neatech.veslo.dev", "veslo-orchestrator-dev");
    }
  }
  return join(homedir(), ".veslo", "veslo-orchestrator-dev");
};
const dataDir = process.env.VESLO_DATA_DIR?.trim() || defaultDataDir();

const normalizePathKey = (value) => resolve(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

const legacyDevDataDir = () => join(homedir(), ".veslo", "veslo-orchestrator-dev");

function migrateLegacyDevDataDir(targetDir) {
  if (process.env.VESLO_DATA_DIR?.trim()) return;
  if (process.platform !== "win32") return;

  const legacyDir = legacyDevDataDir();
  if (!existsSync(legacyDir)) return;
  if (normalizePathKey(legacyDir) === normalizePathKey(targetDir)) return;

  try {
    mkdirSync(targetDir, { recursive: true });
    cpSync(legacyDir, targetDir, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  } catch (error) {
    console.warn(`[veslo] Failed to copy legacy dev data dir into AppData: ${error?.message ?? error}`);
  }

  mergeLegacyConversationBindings(legacyDir, targetDir);
}

function mergeLegacyConversationBindings(legacyDir, targetDir) {
  const legacyDb = join(legacyDir, "conversations", "bindings.sqlite");
  const targetDb = join(targetDir, "conversations", "bindings.sqlite");
  if (!existsSync(legacyDb)) return;

  const script = String.raw`
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const legacyDbPath = process.env.VESLO_DEV_LEGACY_BINDINGS_DB;
const targetDbPath = process.env.VESLO_DEV_TARGET_BINDINGS_DB;
if (!legacyDbPath || !targetDbPath || !existsSync(legacyDbPath)) {
  process.exit(0);
}

mkdirSync(dirname(targetDbPath), { recursive: true });
const target = new Database(targetDbPath);
target.exec([
  "PRAGMA journal_mode = WAL;",
  "PRAGMA busy_timeout = 5000;",
  "CREATE TABLE IF NOT EXISTS conversation_binding (",
  "  workspace_id TEXT NOT NULL,",
  "  conversation_id TEXT NOT NULL,",
  "  engine TEXT NOT NULL,",
  "  engine_session_id TEXT NOT NULL,",
  "  directory TEXT NOT NULL,",
  "  branch_id TEXT,",
  "  parent_conversation_id TEXT,",
  "  parent_engine_session_id TEXT,",
  "  title TEXT,",
  "  created_at INTEGER NOT NULL,",
  "  updated_at INTEGER NOT NULL,",
  "  first_seen_at INTEGER NOT NULL,",
  "  last_seen_at INTEGER NOT NULL,",
  "  PRIMARY KEY (workspace_id, conversation_id),",
  "  UNIQUE (workspace_id, directory, engine, engine_session_id)",
  ");",
  "CREATE INDEX IF NOT EXISTS conversation_binding_engine_idx",
  "  ON conversation_binding (workspace_id, directory, engine, engine_session_id);",
  "CREATE INDEX IF NOT EXISTS conversation_binding_updated_idx",
  "  ON conversation_binding (workspace_id, directory, updated_at DESC);",
].join("\n"));

const legacy = new Database(legacyDbPath, { readonly: true });
const rows = legacy.query("SELECT * FROM conversation_binding").all();
const insert = target.prepare([
  "INSERT OR IGNORE INTO conversation_binding (",
  "  workspace_id,",
  "  conversation_id,",
  "  engine,",
  "  engine_session_id,",
  "  directory,",
  "  branch_id,",
  "  parent_conversation_id,",
  "  parent_engine_session_id,",
  "  title,",
  "  created_at,",
  "  updated_at,",
  "  first_seen_at,",
  "  last_seen_at",
  ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
].join("\n"));
const update = target.prepare([
  "UPDATE conversation_binding",
  "SET",
  "  branch_id = COALESCE(branch_id, ?),",
  "  parent_conversation_id = COALESCE(parent_conversation_id, ?),",
  "  parent_engine_session_id = COALESCE(parent_engine_session_id, ?),",
  "  title = COALESCE(title, ?),",
  "  created_at = MIN(created_at, ?),",
  "  updated_at = MAX(updated_at, ?),",
  "  first_seen_at = MIN(first_seen_at, ?),",
  "  last_seen_at = MAX(last_seen_at, ?)",
  "WHERE workspace_id = ?",
  "  AND directory = ?",
  "  AND engine = ?",
  "  AND engine_session_id = ?",
].join("\n"));
const migrate = target.transaction((items) => {
  for (const row of items) {
    insert.run(
      row.workspace_id,
      row.conversation_id,
      row.engine,
      row.engine_session_id,
      row.directory,
      row.branch_id,
      row.parent_conversation_id,
      row.parent_engine_session_id,
      row.title,
      row.created_at,
      row.updated_at,
      row.first_seen_at,
      row.last_seen_at,
    );
    update.run(
      row.branch_id,
      row.parent_conversation_id,
      row.parent_engine_session_id,
      row.title,
      row.created_at,
      row.updated_at,
      row.first_seen_at,
      row.last_seen_at,
      row.workspace_id,
      row.directory,
      row.engine,
      row.engine_session_id,
    );
  }
});
migrate(rows);
legacy.close();
target.close();
console.log(String(rows.length));
`;

  const result = spawnSync("bun", ["-e", script], {
    env: {
      ...process.env,
      VESLO_DEV_LEGACY_BINDINGS_DB: legacyDb,
      VESLO_DEV_TARGET_BINDINGS_DB: targetDb,
    },
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "unknown error").trim();
    console.warn(`[veslo] Failed to merge legacy conversation bindings: ${message}`);
    return;
  }
  const merged = (result.stdout || "").trim();
  if (merged) {
    console.info(`[veslo] Merged ${merged} legacy conversation binding(s) into ${targetDb}`);
  }
}

migrateLegacyDevDataDir(dataDir);

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
