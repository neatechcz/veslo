#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
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
const LIVE_WEBDRIVER_MODE = "live-dev-webdriver";
const ISOLATED_WEBDRIVER_MODE = "isolated-dev-webdriver";
const devCliArgs = process.argv.slice(2);
const liveWebDriverRequested = devCliArgs.includes("--webdriver");
const isolatedWebDriverRequested = devCliArgs.includes("--webdriver-isolated");
const webdriverRequested = liveWebDriverRequested || isolatedWebDriverRequested;
if (liveWebDriverRequested && isolatedWebDriverRequested) {
  throw new Error("Choose either --webdriver or --webdriver-isolated, not both.");
}
const tauriCliArgs = devCliArgs.filter(
  (argument) => argument !== "--webdriver" && argument !== "--webdriver-isolated",
);

loadDotEnv({ cwd: repoRoot });

function assertLiveWebDriverEnvironment(env = process.env) {
  if (!liveWebDriverRequested) return;

  const unsafeOverrides = [
    "E2E_USE_EXISTING_PROFILE",
    "E2E_OPENCODE_HOME",
    "E2E_MANAGED_AI_GATEWAY_FIXTURE",
    "VESLO_DEN_AUTH_SNAPSHOT_PATH",
    "WEBVIEW2_USER_DATA_FOLDER",
  ].filter((name) => env[name]?.trim());
  if (unsafeOverrides.length > 0) {
    throw new Error(
      `Refusing live WebDriver mode with E2E/profile overrides: ${unsafeOverrides.join(", ")}. `
      + "Unset them so Veslo uses the normal signed-in development profile.",
    );
  }
}

function assertIsolatedWebDriverEnvironment(env = process.env) {
  if (!isolatedWebDriverRequested) return;

  const required = [
    "VESLO_WEBDRIVER_ISOLATED_PROFILE",
    "OPENCODE_HOME",
    "VESLO_DATA_DIR",
    "VESLO_APP_CONFIG_DIR",
    "VESLO_APP_DATA_DIR",
    "VESLO_APP_LOCAL_DATA_DIR",
    "VESLO_DEN_AUTH_SNAPSHOT_PATH",
    "HOME",
    "USERPROFILE",
  ];
  if (process.platform === "win32") required.push("WEBVIEW2_USER_DATA_FOLDER");
  const missing = required.filter((name) => !env[name]?.trim());
  if (env.VESLO_WEBDRIVER_ISOLATED_PROFILE?.trim() !== "1" || missing.length > 0) {
    throw new Error(
      "Refusing isolated WebDriver mode without the harness-owned profile contract: "
      + `missing ${missing.join(", ") || "VESLO_WEBDRIVER_ISOLATED_PROFILE=1"}.`,
    );
  }
}

async function allocateLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a loopback WebDriver port.")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

assertLiveWebDriverEnvironment();
assertIsolatedWebDriverEnvironment();

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
  return join(repoRoot, "dev-specific", "tauri-pilot", `manual-runtime-${formatLocalTimestamp()}-${randomUUID().slice(0, 8)}-pnpm-dev`);
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

function deriveTraceFilePath(basePath, channel) {
  return basePath.toLowerCase().endsWith(".ndjson")
    ? `${basePath.slice(0, -".ndjson".length)}.${channel}.ndjson`
    : `${basePath}.${channel}`;
}

function valueOrDerivedTrace(env, name, basePath, channel) {
  return env[name]?.trim() ? env[name] : deriveTraceFilePath(basePath, channel);
}

function optionalEnvValue(env, name) {
  return env[name]?.trim() || null;
}

function buildDevelopmentCapabilityConfig({ pilot, webdriver }) {
  const capabilities = ["veslo-default"];
  if (pilot) {
    capabilities.push({
      identifier: "veslo-dev-pilot",
      description: "Dev-only tauri-pilot capability for manual runtime diagnostics.",
      windows: ["main"],
      permissions: ["pilot:default"],
    });
  }
  if (webdriver) {
    capabilities.push({
      identifier: "veslo-dev-webdriver",
      description: "Dev-only loopback WebDriver capability for an explicit live-profile attach.",
      windows: ["main"],
      permissions: ["wdio-webdriver:default"],
    });
  }
  return {
    app: {
      security: {
        capabilities,
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
  const runtimeDiagnostics = valueOrDefault(baseEnv, "VESLO_RUNTIME_DIAGNOSTICS", "1");
  const viteRuntimeDiagnostics = valueOrDefault(baseEnv, "VITE_VESLO_RUNTIME_DIAGNOSTICS", runtimeDiagnostics);
  const runtimeTraceFile = valueOrDefault(baseEnv, "VESLO_RUNTIME_TRACE_FILE", join(logDir, "runtime-trace.ndjson"));
  const sendWorkflowTraceFile = valueOrDefault(baseEnv, "VESLO_SEND_WORKFLOW_TRACE_FILE", join(logDir, "send-workflow-trace.ndjson"));
  const sendWorkflowTraceMirrorFile = optionalEnvValue(baseEnv, "VESLO_SEND_WORKFLOW_TRACE_MIRROR_FILE");
  const sendWorkflowTraceUiFile = valueOrDerivedTrace(baseEnv, "VESLO_SEND_WORKFLOW_TRACE_UI_FILE", sendWorkflowTraceFile, "ui");
  const sendWorkflowTraceServerFile = valueOrDerivedTrace(baseEnv, "VESLO_SEND_WORKFLOW_TRACE_SERVER_FILE", sendWorkflowTraceFile, "server");
  const sendWorkflowTraceOrchestratorFile = valueOrDerivedTrace(
    baseEnv,
    "VESLO_SEND_WORKFLOW_TRACE_ORCHESTRATOR_FILE",
    sendWorkflowTraceFile,
    "orchestrator",
  );
  const sendWorkflowTraceUiMirrorFile =
    optionalEnvValue(baseEnv, "VESLO_SEND_WORKFLOW_TRACE_UI_MIRROR_FILE") ??
    (sendWorkflowTraceMirrorFile ? deriveTraceFilePath(sendWorkflowTraceMirrorFile, "ui") : null);
  const sendWorkflowTraceServerMirrorFile =
    optionalEnvValue(baseEnv, "VESLO_SEND_WORKFLOW_TRACE_SERVER_MIRROR_FILE") ??
    (sendWorkflowTraceMirrorFile ? deriveTraceFilePath(sendWorkflowTraceMirrorFile, "server") : null);
  const sendWorkflowTraceOrchestratorMirrorFile =
    optionalEnvValue(baseEnv, "VESLO_SEND_WORKFLOW_TRACE_ORCHESTRATOR_MIRROR_FILE") ??
    (sendWorkflowTraceMirrorFile ? deriveTraceFilePath(sendWorkflowTraceMirrorFile, "orchestrator") : null);
  const opencodeHealthDiagFile = valueOrDefault(baseEnv, "VESLO_OPENCODE_HEALTH_DIAG_FILE", join(logDir, "opencode-health.ndjson"));
  const runtimeInfoPath = join(logDir, "runtime-info.json");

  const env = {
    VESLO_TAURI_PILOT: valueOrDefault(baseEnv, "VESLO_TAURI_PILOT", "1"),
    VESLO_E2E: valueOrDefault(baseEnv, "VESLO_E2E", "1"),
    VESLO_DEV_RUNTIME_MODE: MANUAL_PILOT_MODE,
    TAURI_PILOT_SOCKET: pilotSocket,
    TAURI_PILOT_LOG_DIR: logDir,
    VESLO_RUNTIME_DIAGNOSTICS: runtimeDiagnostics,
    VITE_VESLO_RUNTIME_DIAGNOSTICS: viteRuntimeDiagnostics,
    VESLO_RUNTIME_TRACE: valueOrDefault(baseEnv, "VESLO_RUNTIME_TRACE", "1"),
    VESLO_RUNTIME_TRACE_FILE: runtimeTraceFile,
    VESLO_SEND_WORKFLOW_TRACE: valueOrDefault(baseEnv, "VESLO_SEND_WORKFLOW_TRACE", "1"),
    VESLO_SEND_WORKFLOW_TRACE_FILE: sendWorkflowTraceFile,
    VESLO_SEND_WORKFLOW_TRACE_UI_FILE: sendWorkflowTraceUiFile,
    VESLO_SEND_WORKFLOW_TRACE_SERVER_FILE: sendWorkflowTraceServerFile,
    VESLO_SEND_WORKFLOW_TRACE_ORCHESTRATOR_FILE: sendWorkflowTraceOrchestratorFile,
    ...(sendWorkflowTraceMirrorFile ? { VESLO_SEND_WORKFLOW_TRACE_MIRROR_FILE: sendWorkflowTraceMirrorFile } : {}),
    ...(sendWorkflowTraceUiMirrorFile ? { VESLO_SEND_WORKFLOW_TRACE_UI_MIRROR_FILE: sendWorkflowTraceUiMirrorFile } : {}),
    ...(sendWorkflowTraceServerMirrorFile ? { VESLO_SEND_WORKFLOW_TRACE_SERVER_MIRROR_FILE: sendWorkflowTraceServerMirrorFile } : {}),
    ...(sendWorkflowTraceOrchestratorMirrorFile
      ? { VESLO_SEND_WORKFLOW_TRACE_ORCHESTRATOR_MIRROR_FILE: sendWorkflowTraceOrchestratorMirrorFile }
      : {}),
    VESLO_SEND_WORKFLOW_TRACE_CONSOLE: valueOrDefault(baseEnv, "VESLO_SEND_WORKFLOW_TRACE_CONSOLE", "1"),
    VITE_VESLO_SEND_WORKFLOW_TRACE: valueOrDefault(baseEnv, "VITE_VESLO_SEND_WORKFLOW_TRACE", "1"),
    VITE_VESLO_SESSION_UI_MUTATION_TRACE: valueOrDefault(baseEnv, "VITE_VESLO_SESSION_UI_MUTATION_TRACE", "1"),
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
    sendWorkflowTraceUiFile,
    sendWorkflowTraceServerFile,
    sendWorkflowTraceOrchestratorFile,
    sendWorkflowTraceUiMirrorFile,
    sendWorkflowTraceServerMirrorFile,
    sendWorkflowTraceOrchestratorMirrorFile,
    opencodeHealthDiagFile,
    env,
  };
}

function createWebDriverRuntime(baseEnv, pilotRuntime, webdriverPort) {
  const configuredRunDir = baseEnv.VESLO_DEV_RUNTIME_DIR?.trim() || baseEnv.VESLO_MANUAL_RUNTIME_DIR?.trim();
  const runDir = pilotRuntime?.runDir || resolve(configuredRunDir || defaultManualRuntimeDir());
  const logDir = pilotRuntime?.logDir || resolve(baseEnv.TAURI_PILOT_LOG_DIR?.trim() || runDir);
  ensureDirectory(runDir);
  ensureDirectory(logDir);

  // Native WebDriver is a real-desktop test path, not a reduced observability
  // mode.  It deliberately does not start Pilot, but still needs the same
  // per-process traces to explain a failure before the browser can render it.
  const runtimeDiagnostics = valueOrDefault(baseEnv, "VESLO_RUNTIME_DIAGNOSTICS", "1");
  const viteRuntimeDiagnostics = valueOrDefault(baseEnv, "VITE_VESLO_RUNTIME_DIAGNOSTICS", runtimeDiagnostics);
  const runtimeTraceFile = pilotRuntime?.runtimeTraceFile ??
    valueOrDefault(baseEnv, "VESLO_RUNTIME_TRACE_FILE", join(logDir, "runtime-trace.ndjson"));
  const sendWorkflowTraceFile = pilotRuntime?.sendWorkflowTraceFile ??
    valueOrDefault(baseEnv, "VESLO_SEND_WORKFLOW_TRACE_FILE", join(logDir, "send-workflow-trace.ndjson"));
  const sendWorkflowTraceUiFile = pilotRuntime?.sendWorkflowTraceUiFile ??
    valueOrDerivedTrace(baseEnv, "VESLO_SEND_WORKFLOW_TRACE_UI_FILE", sendWorkflowTraceFile, "ui");
  const sendWorkflowTraceServerFile = pilotRuntime?.sendWorkflowTraceServerFile ??
    valueOrDerivedTrace(baseEnv, "VESLO_SEND_WORKFLOW_TRACE_SERVER_FILE", sendWorkflowTraceFile, "server");
  const sendWorkflowTraceOrchestratorFile = pilotRuntime?.sendWorkflowTraceOrchestratorFile ??
    valueOrDerivedTrace(baseEnv, "VESLO_SEND_WORKFLOW_TRACE_ORCHESTRATOR_FILE", sendWorkflowTraceFile, "orchestrator");
  const opencodeHealthDiagFile = pilotRuntime?.opencodeHealthDiagFile ??
    valueOrDefault(baseEnv, "VESLO_OPENCODE_HEALTH_DIAG_FILE", join(logDir, "opencode-health.ndjson"));

  return {
    mode: isolatedWebDriverRequested ? ISOLATED_WEBDRIVER_MODE : LIVE_WEBDRIVER_MODE,
    endpoint: `http://127.0.0.1:${webdriverPort}`,
    port: webdriverPort,
    descriptorPath: join(logDir, "native-webdriver.json"),
    runtimeTraceFile,
    sendWorkflowTraceFile,
    sendWorkflowTraceUiFile,
    sendWorkflowTraceServerFile,
    sendWorkflowTraceOrchestratorFile,
    opencodeHealthDiagFile,
    env: {
      VESLO_DEV_RUNTIME_MODE: isolatedWebDriverRequested ? ISOLATED_WEBDRIVER_MODE : LIVE_WEBDRIVER_MODE,
      TAURI_WEBDRIVER_PORT: String(webdriverPort),
      VESLO_WEBDRIVER_DESCRIPTOR_PATH: join(logDir, "native-webdriver.json"),
      VESLO_RUNTIME_DIAGNOSTICS: runtimeDiagnostics,
      VITE_VESLO_RUNTIME_DIAGNOSTICS: viteRuntimeDiagnostics,
      VESLO_RUNTIME_TRACE: valueOrDefault(baseEnv, "VESLO_RUNTIME_TRACE", "1"),
      VESLO_RUNTIME_TRACE_FILE: runtimeTraceFile,
      VESLO_SEND_WORKFLOW_TRACE: valueOrDefault(baseEnv, "VESLO_SEND_WORKFLOW_TRACE", "1"),
      VESLO_SEND_WORKFLOW_TRACE_FILE: sendWorkflowTraceFile,
      VESLO_SEND_WORKFLOW_TRACE_UI_FILE: sendWorkflowTraceUiFile,
      VESLO_SEND_WORKFLOW_TRACE_SERVER_FILE: sendWorkflowTraceServerFile,
      VESLO_SEND_WORKFLOW_TRACE_ORCHESTRATOR_FILE: sendWorkflowTraceOrchestratorFile,
      VITE_VESLO_SEND_WORKFLOW_TRACE: valueOrDefault(baseEnv, "VITE_VESLO_SEND_WORKFLOW_TRACE", "1"),
      VITE_VESLO_SESSION_UI_MUTATION_TRACE: valueOrDefault(baseEnv, "VITE_VESLO_SESSION_UI_MUTATION_TRACE", "1"),
      VESLO_OPENCODE_HEALTH_DIAG: valueOrDefault(baseEnv, "VESLO_OPENCODE_HEALTH_DIAG", "1"),
      VESLO_OPENCODE_HEALTH_DIAG_FILE: opencodeHealthDiagFile,
    },
  };
}

function writeDevRuntimeInfo(pilotRuntime, webdriverRuntime, env, args) {
  const runtime = webdriverRuntime ?? pilotRuntime;
  const logDir = pilotRuntime?.logDir ?? dirname(webdriverRuntime.descriptorPath);
  const runtimeInfoPath = pilotRuntime?.runtimeInfoPath ?? join(logDir, "runtime-info.json");
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
    profile: {
      kind: webdriverRuntime
        ? (webdriverRuntime.mode === ISOLATED_WEBDRIVER_MODE ? "isolated-test" : "existing-development")
        : "development",
      isolated: webdriverRuntime?.mode === ISOLATED_WEBDRIVER_MODE,
      dataDir,
      authSnapshot: false,
    },
    tauriConfig: {
      base: "src-tauri/tauri.dev.conf.json",
      inlinePilotCapability: Boolean(pilotRuntime),
      inlineWebDriverCapability: Boolean(webdriverRuntime),
      identifier: pilotRuntime?.identifier ?? DEV_PILOT_IDENTIFIER,
      cargoFeatures: [
        ...(pilotRuntime ? ["e2e"] : []),
        ...(webdriverRuntime ? ["webdriver"] : []),
      ],
    },
    pilot: pilotRuntime ? {
      socket: pilotRuntime.pilotSocket,
      cli: pilotRuntime.pilotCli,
      window: "main",
      pingCommand: [pilotRuntime.pilotCli, "--socket", pilotRuntime.pilotSocket, "ping"],
      stateCommand: [pilotRuntime.pilotCli, "--socket", pilotRuntime.pilotSocket, "--window", "main", "state"],
      snapshotCommand: [pilotRuntime.pilotCli, "--socket", pilotRuntime.pilotSocket, "--window", "main", "snapshot", "-i"],
    } : null,
    webdriver: webdriverRuntime ? {
      endpoint: webdriverRuntime.endpoint,
      descriptorPath: webdriverRuntime.descriptorPath,
      clientCommand: "pnpm test:webdriver:live -- <this-runtime-info.json>",
    } : null,
    traces: {
      logDir,
      runtimeTraceFile: runtime?.runtimeTraceFile ?? null,
      sendWorkflowTraceFile: runtime?.sendWorkflowTraceFile ?? null,
      sendWorkflowTraceMirrorFile: pilotRuntime?.sendWorkflowTraceMirrorFile ?? null,
      sendWorkflowTraceFiles: {
        ui: runtime?.sendWorkflowTraceUiFile ?? null,
        server: runtime?.sendWorkflowTraceServerFile ?? null,
        orchestrator: runtime?.sendWorkflowTraceOrchestratorFile ?? null,
      },
      sendWorkflowTraceMirrorFiles: {
        ui: pilotRuntime?.sendWorkflowTraceUiMirrorFile ?? null,
        server: pilotRuntime?.sendWorkflowTraceServerMirrorFile ?? null,
        orchestrator: pilotRuntime?.sendWorkflowTraceOrchestratorMirrorFile ?? null,
      },
      opencodeHealthDiagFile: runtime?.opencodeHealthDiagFile ?? null,
    },
    env: {
      VESLO_DATA_DIR: env.VESLO_DATA_DIR,
      VESLO_SERVER_DEV_DIR: env.VESLO_SERVER_DEV_DIR,
      VESLO_SERVER_DEV_WATCH: env.VESLO_SERVER_DEV_WATCH,
      VESLO_DEV_RUNTIME_MODE: env.VESLO_DEV_RUNTIME_MODE,
      TAURI_WEBDRIVER_PORT: env.TAURI_WEBDRIVER_PORT || null,
      VESLO_WEBDRIVER_DESCRIPTOR_PATH: env.VESLO_WEBDRIVER_DESCRIPTOR_PATH || null,
      VESLO_TAURI_PILOT: env.VESLO_TAURI_PILOT,
      TAURI_PILOT_SOCKET: env.TAURI_PILOT_SOCKET,
      TAURI_PILOT_LOG_DIR: env.TAURI_PILOT_LOG_DIR,
      VESLO_RUNTIME_DIAGNOSTICS: env.VESLO_RUNTIME_DIAGNOSTICS,
      VITE_VESLO_RUNTIME_DIAGNOSTICS: env.VITE_VESLO_RUNTIME_DIAGNOSTICS,
      VESLO_RUNTIME_TRACE_FILE: env.VESLO_RUNTIME_TRACE_FILE,
      VESLO_SEND_WORKFLOW_TRACE_FILE: env.VESLO_SEND_WORKFLOW_TRACE_FILE,
      VESLO_SEND_WORKFLOW_TRACE_MIRROR_FILE: env.VESLO_SEND_WORKFLOW_TRACE_MIRROR_FILE,
      VESLO_SEND_WORKFLOW_TRACE_UI_FILE: env.VESLO_SEND_WORKFLOW_TRACE_UI_FILE,
      VESLO_SEND_WORKFLOW_TRACE_SERVER_FILE: env.VESLO_SEND_WORKFLOW_TRACE_SERVER_FILE,
      VESLO_SEND_WORKFLOW_TRACE_ORCHESTRATOR_FILE: env.VESLO_SEND_WORKFLOW_TRACE_ORCHESTRATOR_FILE,
      VESLO_SEND_WORKFLOW_TRACE_UI_MIRROR_FILE: env.VESLO_SEND_WORKFLOW_TRACE_UI_MIRROR_FILE,
      VESLO_SEND_WORKFLOW_TRACE_SERVER_MIRROR_FILE: env.VESLO_SEND_WORKFLOW_TRACE_SERVER_MIRROR_FILE,
      VESLO_SEND_WORKFLOW_TRACE_ORCHESTRATOR_MIRROR_FILE: env.VESLO_SEND_WORKFLOW_TRACE_ORCHESTRATOR_MIRROR_FILE,
      VITE_VESLO_SESSION_UI_MUTATION_TRACE: env.VITE_VESLO_SESSION_UI_MUTATION_TRACE,
      VESLO_OPENCODE_HEALTH_DIAG_FILE: env.VESLO_OPENCODE_HEALTH_DIAG_FILE,
      VESLO_DEN_AUTH_SNAPSHOT_PATH: env.VESLO_DEN_AUTH_SNAPSHOT_PATH || null,
    },
    sidecars: readSidecarVersions(),
    tauriArgs: args,
  };
  writeFileSync(runtimeInfoPath, `${JSON.stringify(info, null, 2)}\n`, "utf8");
  return info;
}

function printManualRuntimeInfo(info) {
  console.info(`[veslo:dev-runtime] mode=${info.mode}`);
  console.info(`[veslo:dev-runtime] runDir=${info.traces.logDir}`);
  console.info(`[veslo:dev-runtime] runtimeInfo=${join(info.traces.logDir, "runtime-info.json")}`);
  console.info(`[veslo:dev-runtime] viteUrl=${info.viteUrl}`);
  console.info(`[veslo:dev-runtime] dataDir=${info.dataDir}`);
  console.info(`[veslo:dev-runtime] tauriConfig=${info.tauriConfig.base} + inline dev capabilities`);
  console.info(`[veslo:dev-runtime] cargoFeatures=${info.tauriConfig.cargoFeatures.join(",")}`);
  if (info.pilot) {
    console.info(`[veslo:dev-runtime] pilotSocket=${info.pilot.socket}`);
    console.info(`[veslo:dev-runtime] pilotPing=${info.pilot.pingCommand.join(" ")}`);
  }
  if (info.webdriver) {
    console.info(`[veslo:dev-runtime] webdriverEndpoint=${info.webdriver.endpoint}`);
    console.info(`[veslo:dev-runtime] webdriverDescriptor=${info.webdriver.descriptorPath}`);
    console.info(`[veslo:dev-runtime] webdriverAttach=${info.webdriver.clientCommand}`);
  }
  console.info(`[veslo:dev-runtime] runtimeTrace=${info.traces.runtimeTraceFile}`);
  console.info(`[veslo:dev-runtime] sendWorkflowTrace=${info.traces.sendWorkflowTraceFile}`);
  console.info(`[veslo:dev-runtime] sendWorkflowTraceMirror=${info.traces.sendWorkflowTraceMirrorFile}`);
  console.info(`[veslo:dev-runtime] sendWorkflowTrace.ui=${info.traces.sendWorkflowTraceFiles.ui}`);
  console.info(`[veslo:dev-runtime] sendWorkflowTrace.server=${info.traces.sendWorkflowTraceFiles.server}`);
  console.info(`[veslo:dev-runtime] sendWorkflowTrace.orchestrator=${info.traces.sendWorkflowTraceFiles.orchestrator}`);
  console.info(`[veslo:dev-runtime] sendWorkflowTraceMirror.ui=${info.traces.sendWorkflowTraceMirrorFiles.ui}`);
  console.info(`[veslo:dev-runtime] sendWorkflowTraceMirror.server=${info.traces.sendWorkflowTraceMirrorFiles.server}`);
  console.info(`[veslo:dev-runtime] sendWorkflowTraceMirror.orchestrator=${info.traces.sendWorkflowTraceMirrorFiles.orchestrator}`);
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
const manualPilotRuntime = !webdriverRequested && shouldEnableManualPilotRuntime(baseEnv)
  ? createManualPilotRuntime(baseEnv)
  : null;
const liveWebDriverRuntime = webdriverRequested
  ? createWebDriverRuntime(baseEnv, manualPilotRuntime, await allocateLoopbackPort())
  : null;
const env = {
  ...baseEnv,
  ...(manualPilotRuntime?.env ?? {}),
  ...(liveWebDriverRuntime?.env ?? {}),
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
  ...(manualPilotRuntime || liveWebDriverRuntime
    ? [JSON.stringify(buildDevelopmentCapabilityConfig({ pilot: Boolean(manualPilotRuntime), webdriver: Boolean(liveWebDriverRuntime) })), "--config"]
    : []),
  JSON.stringify({ build: { devUrl: `http://localhost:${port}` } }),
  ...(manualPilotRuntime || liveWebDriverRuntime
    ? ["--features", [manualPilotRuntime ? "e2e" : null, liveWebDriverRuntime ? "webdriver" : null].filter(Boolean).join(",")]
    : []),
  ...tauriCliArgs,
];

if (manualPilotRuntime || liveWebDriverRuntime) {
  const runtimeInfo = writeDevRuntimeInfo(manualPilotRuntime, liveWebDriverRuntime, env, args);
  printManualRuntimeInfo(runtimeInfo);
} else {
  console.info("[veslo:dev-runtime] mode=standard; set VESLO_TAURI_PILOT=1 to enable manual Pilot diagnostics.");
}

const captureChildOutput = env.VESLO_DEV_CAPTURE_CHILD_OUTPUT?.trim() === "1";
const child = spawn(process.execPath, [tauriCli, ...args], {
  cwd: desktopDir,
  env,
  stdio: captureChildOutput ? ["ignore", "pipe", "pipe"] : "inherit",
});
if (captureChildOutput) {
  child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
}

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
  console.info(
    `[veslo:dev-runtime] tauri-child-exit timestamp=${new Date().toISOString()} code=${code ?? "null"} signal=${signal ?? "none"}`,
  );
  if (signal) {
    process.exit(0);
  }
  process.exit(code ?? 0);
});
