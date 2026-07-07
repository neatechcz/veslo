#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main as cleanupDevProcesses } from "./cleanup-dev-processes.mjs";
import { loadDotEnv } from "../../../scripts/load-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const desktopDir = resolve(__dirname, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const serverDir = resolve(desktopDir, "..", "server");
const tauriCli = require.resolve("@tauri-apps/cli/tauri.js");
const DEV_PILOT_IDENTIFIER = "com.neatech.veslo.dev";
const MANUAL_PILOT_MODE = "manual-pilot";

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

const isFalseyFlag = (value) => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
};

function shouldEnableManualPilotRuntime(env = process.env) {
  const explicit = env.VESLO_TAURI_PILOT ?? env.VESLO_DEV_PILOT ?? env.VESLO_E2E;
  if (explicit?.trim()) {
    return !isFalseyFlag(explicit);
  }
  return true;
}

function formatLocalTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function defaultManualRuntimeDir() {
  return join(repoRoot, "dev-specific", "tauri-pilot", `manual-runtime-${formatLocalTimestamp()}-pnpm-dev`);
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
}

function ensurePrivateDirectory(path) {
  ensureDirectory(path);
  if (process.platform !== "win32") {
    try {
      chmodSync(path, 0o700);
    } catch {
      // Best-effort only. The explicit TAURI_PILOT_SOCKET still makes the path deterministic.
    }
  }
}

function defaultPilotSocket(identifier, env = process.env) {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\tauri-pilot-${identifier}`;
  }

  const runtimeDir = env.XDG_RUNTIME_DIR?.trim()
    || posix.join(tmpdir().replace(/\\/g, "/"), `veslo-pilot-dev-${createHash("sha1").update(repoRoot).digest("hex").slice(0, 12)}`);
  ensurePrivateDirectory(runtimeDir);
  return posix.join(runtimeDir, `tauri-pilot-${identifier}.sock`);
}

function resolvePilotSocket(env = process.env) {
  return env.TAURI_PILOT_SOCKET?.trim()
    || env.E2E_TAURI_PILOT_SOCKET?.trim()
    || defaultPilotSocket(DEV_PILOT_IDENTIFIER, env);
}

function resolvePilotCli(env = process.env) {
  const explicit = env.E2E_TAURI_PILOT_BIN?.trim() || env.TAURI_PILOT_BIN?.trim();
  if (explicit) return explicit;
  if (process.platform === "win32") {
    const userProfile = env.USERPROFILE?.trim() || homedir();
    const cargoPilot = join(userProfile, ".cargo", "bin", "tauri-pilot.exe");
    if (existsSync(cargoPilot)) return cargoPilot;
  }
  return "tauri-pilot";
}

function readSidecarVersions() {
  const versionsPath = join(desktopDir, "src-tauri", "sidecars", "versions.json");
  if (!existsSync(versionsPath)) return null;
  try {
    return JSON.parse(readFileSync(versionsPath, "utf8"));
  } catch {
    return null;
  }
}

function valueOrDefault(env, name, fallback) {
  return env[name]?.trim() ? env[name] : fallback;
}

function buildPilotCapabilityConfig() {
  return {
    app: {
      security: {
        capabilities: [
          "veslo-default",
          {
            identifier: "veslo-dev-pilot",
            description: "Dev-only tauri-pilot capability for manual runtime diagnostics.",
            windows: ["main"],
            permissions: ["pilot:default"],
          },
        ],
      },
    },
  };
}

function createManualPilotRuntime(baseEnv) {
  const configuredRunDir = baseEnv.VESLO_DEV_RUNTIME_DIR?.trim() || baseEnv.VESLO_MANUAL_RUNTIME_DIR?.trim();
  const runDir = resolve(configuredRunDir || defaultManualRuntimeDir());
  const logDir = resolve(baseEnv.TAURI_PILOT_LOG_DIR?.trim() || runDir);
  ensureDirectory(runDir);
  ensureDirectory(logDir);

  const pilotSocket = resolvePilotSocket(baseEnv);
  const runtimeTraceFile = valueOrDefault(baseEnv, "VESLO_RUNTIME_TRACE_FILE", join(logDir, "runtime-trace.ndjson"));
  const sendWorkflowTraceFile = valueOrDefault(baseEnv, "VESLO_SEND_WORKFLOW_TRACE_FILE", join(logDir, "send-workflow-trace.ndjson"));
  const sendWorkflowTraceMirrorFile = valueOrDefault(
    baseEnv,
    "VESLO_SEND_WORKFLOW_TRACE_MIRROR_FILE",
    join(repoRoot, ".tmp", "send-workflow-trace.ndjson"),
  );
  const opencodeHealthDiagFile = valueOrDefault(baseEnv, "VESLO_OPENCODE_HEALTH_DIAG_FILE", join(logDir, "opencode-health.ndjson"));
  const runtimeInfoPath = join(logDir, "runtime-info.json");

  const env = {
    VESLO_TAURI_PILOT: valueOrDefault(baseEnv, "VESLO_TAURI_PILOT", "1"),
    VESLO_E2E: valueOrDefault(baseEnv, "VESLO_E2E", "1"),
    VESLO_DEV_RUNTIME_MODE: MANUAL_PILOT_MODE,
    TAURI_PILOT_SOCKET: pilotSocket,
    TAURI_PILOT_LOG_DIR: logDir,
    VESLO_RUNTIME_TRACE: valueOrDefault(baseEnv, "VESLO_RUNTIME_TRACE", "1"),
    VESLO_RUNTIME_TRACE_FILE: runtimeTraceFile,
    VESLO_SEND_WORKFLOW_TRACE: valueOrDefault(baseEnv, "VESLO_SEND_WORKFLOW_TRACE", "1"),
    VESLO_SEND_WORKFLOW_TRACE_FILE: sendWorkflowTraceFile,
    VESLO_SEND_WORKFLOW_TRACE_MIRROR_FILE: sendWorkflowTraceMirrorFile,
    VESLO_SEND_WORKFLOW_TRACE_CONSOLE: valueOrDefault(baseEnv, "VESLO_SEND_WORKFLOW_TRACE_CONSOLE", "1"),
    VITE_VESLO_SEND_WORKFLOW_TRACE: valueOrDefault(baseEnv, "VITE_VESLO_SEND_WORKFLOW_TRACE", "1"),
    VESLO_OPENCODE_HEALTH_DIAG: valueOrDefault(baseEnv, "VESLO_OPENCODE_HEALTH_DIAG", "1"),
    VESLO_OPENCODE_HEALTH_DIAG_FILE: opencodeHealthDiagFile,
    RUST_BACKTRACE: valueOrDefault(baseEnv, "RUST_BACKTRACE", "1"),
  };

  return {
    mode: MANUAL_PILOT_MODE,
    identifier: DEV_PILOT_IDENTIFIER,
    runDir,
    logDir,
    runtimeInfoPath,
    pilotSocket,
    pilotCli: resolvePilotCli(baseEnv),
    runtimeTraceFile,
    sendWorkflowTraceFile,
    sendWorkflowTraceMirrorFile,
    opencodeHealthDiagFile,
    env,
  };
}

function writeManualRuntimeInfo(runtime, env, args) {
  const info = {
    schema: "veslo-dev-runtime/v1",
    mode: runtime.mode,
    startedAt: new Date().toISOString(),
    repoRoot,
    desktopDir,
    port,
    viteUrl: `http://localhost:${port}`,
    dataDir,
    serverDir,
    tauriConfig: {
      base: "src-tauri/tauri.dev.conf.json",
      inlinePilotCapability: true,
      identifier: runtime.identifier,
      cargoFeatures: ["e2e"],
    },
    pilot: {
      socket: runtime.pilotSocket,
      cli: runtime.pilotCli,
      window: "main",
      pingCommand: [runtime.pilotCli, "--socket", runtime.pilotSocket, "ping"],
      stateCommand: [runtime.pilotCli, "--socket", runtime.pilotSocket, "--window", "main", "state"],
      snapshotCommand: [runtime.pilotCli, "--socket", runtime.pilotSocket, "--window", "main", "snapshot", "-i"],
    },
    traces: {
      logDir: runtime.logDir,
      runtimeTraceFile: runtime.runtimeTraceFile,
      sendWorkflowTraceFile: runtime.sendWorkflowTraceFile,
      sendWorkflowTraceMirrorFile: runtime.sendWorkflowTraceMirrorFile,
      opencodeHealthDiagFile: runtime.opencodeHealthDiagFile,
    },
    env: {
      VESLO_DATA_DIR: env.VESLO_DATA_DIR,
      VESLO_SERVER_DEV_DIR: env.VESLO_SERVER_DEV_DIR,
      VESLO_SERVER_DEV_WATCH: env.VESLO_SERVER_DEV_WATCH,
      VESLO_DEV_RUNTIME_MODE: env.VESLO_DEV_RUNTIME_MODE,
      VESLO_TAURI_PILOT: env.VESLO_TAURI_PILOT,
      TAURI_PILOT_SOCKET: env.TAURI_PILOT_SOCKET,
      TAURI_PILOT_LOG_DIR: env.TAURI_PILOT_LOG_DIR,
      VESLO_RUNTIME_TRACE_FILE: env.VESLO_RUNTIME_TRACE_FILE,
      VESLO_SEND_WORKFLOW_TRACE_FILE: env.VESLO_SEND_WORKFLOW_TRACE_FILE,
      VESLO_SEND_WORKFLOW_TRACE_MIRROR_FILE: env.VESLO_SEND_WORKFLOW_TRACE_MIRROR_FILE,
      VESLO_OPENCODE_HEALTH_DIAG_FILE: env.VESLO_OPENCODE_HEALTH_DIAG_FILE,
      VESLO_DEN_AUTH_SNAPSHOT_PATH: env.VESLO_DEN_AUTH_SNAPSHOT_PATH || null,
    },
    sidecars: readSidecarVersions(),
    tauriArgs: args,
  };
  writeFileSync(runtime.runtimeInfoPath, `${JSON.stringify(info, null, 2)}\n`, "utf8");
  return info;
}

function printManualRuntimeInfo(info) {
  console.info(`[veslo:dev-runtime] mode=${info.mode}`);
  console.info(`[veslo:dev-runtime] runDir=${info.traces.logDir}`);
  console.info(`[veslo:dev-runtime] runtimeInfo=${join(info.traces.logDir, "runtime-info.json")}`);
  console.info(`[veslo:dev-runtime] viteUrl=${info.viteUrl}`);
  console.info(`[veslo:dev-runtime] dataDir=${info.dataDir}`);
  console.info(`[veslo:dev-runtime] tauriConfig=${info.tauriConfig.base} + inline pilot:default`);
  console.info(`[veslo:dev-runtime] cargoFeatures=${info.tauriConfig.cargoFeatures.join(",")}`);
  console.info(`[veslo:dev-runtime] pilotSocket=${info.pilot.socket}`);
  console.info(`[veslo:dev-runtime] pilotPing=${info.pilot.pingCommand.join(" ")}`);
  console.info(`[veslo:dev-runtime] runtimeTrace=${info.traces.runtimeTraceFile}`);
  console.info(`[veslo:dev-runtime] sendWorkflowTrace=${info.traces.sendWorkflowTraceFile}`);
  console.info(`[veslo:dev-runtime] sendWorkflowTraceMirror=${info.traces.sendWorkflowTraceMirrorFile}`);
  console.info(`[veslo:dev-runtime] opencodeHealthDiag=${info.traces.opencodeHealthDiagFile}`);
}

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

const baseEnv = {
  ...process.env,
  PORT: String(port),
  VESLO_DATA_DIR: dataDir,
  VESLO_SERVER_DEV_WATCH: process.env.VESLO_SERVER_DEV_WATCH?.trim() || "1",
  VESLO_SERVER_DEV_DIR: process.env.VESLO_SERVER_DEV_DIR?.trim() || serverDir,
};
const manualPilotRuntime = shouldEnableManualPilotRuntime(baseEnv) ? createManualPilotRuntime(baseEnv) : null;
const env = manualPilotRuntime
  ? {
      ...baseEnv,
      ...manualPilotRuntime.env,
    }
  : baseEnv;

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
  ...(manualPilotRuntime
    ? [JSON.stringify(buildPilotCapabilityConfig()), "--config"]
    : []),
  JSON.stringify({ build: { devUrl: `http://localhost:${port}` } }),
  ...(manualPilotRuntime ? ["--features", "e2e"] : []),
  ...process.argv.slice(2),
];

if (manualPilotRuntime) {
  const runtimeInfo = writeManualRuntimeInfo(manualPilotRuntime, env, args);
  printManualRuntimeInfo(runtimeInfo);
} else {
  console.info("[veslo:dev-runtime] mode=standard; set VESLO_TAURI_PILOT=1 to enable manual Pilot diagnostics.");
}

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
