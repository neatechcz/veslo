#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, "..");
const srcTauriDir = resolve(desktopDir, "src-tauri");
const targetDebugDir = resolve(srcTauriDir, "target", "debug");
const sidecarsDir = resolve(srcTauriDir, "sidecars");

const SIDECAR_PROCESS_NAMES = new Set([
  "veslo.exe",
  "veslo-code.exe",
  "veslo-code-router.exe",
  "veslo-orchestrator.exe",
  "veslo-server.exe",
  "opencode.exe",
  "chrome-devtools-mcp.exe",
]);

function powershellExe() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return resolve(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function parseJsonOutput(output) {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function runPowerShell(command) {
  const result = spawnSync(
    powershellExe(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "PowerShell command failed").trim();
    throw new Error(message);
  }
  return result.stdout ?? "";
}

function sleepMs(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function isPathInside(path, root) {
  if (!path || !root) return false;
  const child = resolve(path);
  const parent = resolve(root);
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

export function looksLikeVesloServerWatcher(commandLine) {
  const normalized = String(commandLine ?? "").replace(/\\/g, "/").toLowerCase();
  return (
    /\s(?:--watch\s+)?src\/cli\.ts\s+--/.test(normalized) &&
    normalized.includes("--host-token") &&
    normalized.includes("--approval")
  );
}

function commandLineReferencesPath(commandLine, root) {
  if (!commandLine || !root) return false;
  const normalizedCommandLine = String(commandLine).replace(/\\/g, "/").toLowerCase();
  const normalizedRoot = resolve(root).replace(/\\/g, "/").toLowerCase();
  return normalizedCommandLine.includes(normalizedRoot);
}

export function classifyDevProcess(processInfo, context) {
  const pid = Number(processInfo.ProcessId ?? processInfo.processId ?? 0);
  const name = String(processInfo.Name ?? processInfo.name ?? "").toLowerCase();
  const executablePath = String(processInfo.ExecutablePath ?? processInfo.executablePath ?? "");
  const commandLine = String(processInfo.CommandLine ?? processInfo.commandLine ?? "");

  if (pid <= 0 || pid === process.pid) return null;

  if (
    SIDECAR_PROCESS_NAMES.has(name) &&
    (isPathInside(executablePath, context.targetDebugDir) || isPathInside(executablePath, context.sidecarsDir))
  ) {
    return "repo sidecar executable";
  }

  if (
    name === "chrome-devtools-mcp.exe" &&
    commandLine.includes("chrome-devtools-mcp-package") &&
    (commandLineReferencesPath(commandLine, context.targetDebugDir) ||
      commandLineReferencesPath(commandLine, context.sidecarsDir))
  ) {
    return "repo Chrome DevTools MCP package command line";
  }

  if (context.vesloServerWatcherPids?.has(pid) && looksLikeVesloServerWatcher(commandLine)) {
    return "veslo-server dev watcher";
  }

  return null;
}

function readProcesses() {
  const output = runPowerShell(
    "$ErrorActionPreference='Stop'; " +
      "Get-CimInstance Win32_Process | " +
      "Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | " +
      "ConvertTo-Json -Compress -Depth 3",
  );
  return parseJsonOutput(output);
}

function readListeningPorts() {
  const output = runPowerShell(
    "$ErrorActionPreference='SilentlyContinue'; " +
      "Get-NetTCPConnection -State Listen | " +
      "Select-Object OwningProcess,LocalPort | " +
      "ConvertTo-Json -Compress -Depth 3",
  );
  return parseJsonOutput(output);
}

function configuredServerPorts() {
  const raw = process.env.VESLO_DEV_CLEANUP_PORTS?.trim() || "8787";
  const ports = new Set();
  for (const part of raw.split(",")) {
    const port = Number.parseInt(part.trim(), 10);
    if (Number.isFinite(port) && port > 0) ports.add(port);
  }
  return ports;
}

function collectProcessFamily(seedPids, processes) {
  const byPid = new Map();
  const childrenByParent = new Map();
  for (const processInfo of processes) {
    const pid = Number(processInfo.ProcessId ?? 0);
    const parentPid = Number(processInfo.ParentProcessId ?? 0);
    if (!pid) continue;
    byPid.set(pid, processInfo);
    if (parentPid) {
      const children = childrenByParent.get(parentPid) ?? [];
      children.push(pid);
      childrenByParent.set(parentPid, children);
    }
  }

  const family = new Set(seedPids);
  const queue = [...seedPids];
  while (queue.length) {
    const pid = queue.shift();
    const info = byPid.get(pid);
    const parentPid = Number(info?.ParentProcessId ?? 0);
    if (parentPid && !family.has(parentPid)) {
      family.add(parentPid);
      queue.push(parentPid);
    }
    for (const childPid of childrenByParent.get(pid) ?? []) {
      if (!family.has(childPid)) {
        family.add(childPid);
        queue.push(childPid);
      }
    }
  }
  return family;
}

function resolveVesloServerWatcherPids(processes, ports) {
  const listenedByPid = new Map();
  for (const item of ports) {
    const pid = Number(item.OwningProcess ?? 0);
    const port = Number(item.LocalPort ?? 0);
    if (!pid || !port) continue;
    const pidPorts = listenedByPid.get(pid) ?? new Set();
    pidPorts.add(port);
    listenedByPid.set(pid, pidPorts);
  }

  const targetPorts = configuredServerPorts();
  const seeds = [];
  for (const processInfo of processes) {
    const pid = Number(processInfo.ProcessId ?? 0);
    if (!pid || !looksLikeVesloServerWatcher(processInfo.CommandLine)) continue;
    const pidPorts = listenedByPid.get(pid) ?? new Set();
    if ([...pidPorts].some((port) => targetPorts.has(port))) {
      seeds.push(pid);
    }
  }

  const family = collectProcessFamily(seeds, processes);
  for (const processInfo of processes) {
    const pid = Number(processInfo.ProcessId ?? 0);
    if (!pid || !family.has(pid)) continue;
    if (!looksLikeVesloServerWatcher(processInfo.CommandLine)) {
      family.delete(pid);
    }
  }
  return family;
}

export function stopProcesses(pids, runner = runPowerShell, warn = console.warn) {
  if (pids.length === 0) return;
  for (const pid of pids) {
    try {
      runner(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`[veslo] Failed to stop stale process pid=${pid}: ${message}`);
    }
  }
}

export function findStaleDevProcesses(processes, listeningPorts, context) {
  const vesloServerWatcherPids = resolveVesloServerWatcherPids(processes, listeningPorts);
  const fullContext = { ...context, vesloServerWatcherPids };
  return processes
    .map((processInfo) => {
      const reason = classifyDevProcess(processInfo, fullContext);
      if (!reason) return null;
      return {
        pid: Number(processInfo.ProcessId),
        name: String(processInfo.Name ?? ""),
        reason,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.pid - b.pid);
}

export function cleanupStaleDevProcesses(options = {}) {
  const {
    dryRun = false,
    quiet = false,
    quietEmpty = false,
    targetDebugDir: scopedTargetDebugDir = targetDebugDir,
    sidecarsDir: scopedSidecarsDir = sidecarsDir,
    processReader = readProcesses,
    listeningPortReader = readListeningPorts,
    stopper = stopProcesses,
    sleep = sleepMs,
    log = console.log,
    warn = console.warn,
  } = options;
  const maxPasses = Math.max(1, Number.parseInt(String(options.maxPasses ?? process.env.VESLO_DEV_CLEANUP_PASSES ?? "8"), 10) || 8);
  const settleMs = Math.max(0, Number.parseInt(String(options.settleMs ?? process.env.VESLO_DEV_CLEANUP_SETTLE_MS ?? "250"), 10) || 0);

  let sawStale = false;
  let lastStale = [];

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const processes = processReader();
    const listeningPorts = listeningPortReader();
    const stale = findStaleDevProcesses(processes, listeningPorts, {
      targetDebugDir: scopedTargetDebugDir,
      sidecarsDir: scopedSidecarsDir,
    });
    lastStale = stale;

    if (stale.length === 0) {
      if (!sawStale && !quietEmpty) log("[veslo] No stale Windows dev processes found.");
      return 0;
    }

    sawStale = true;
    const passSuffix = pass === 0 ? "" : ` (cleanup pass ${pass + 1})`;
    for (const item of stale) {
      if (!quiet) log(`[veslo] ${dryRun ? "Would stop" : "Stopping"} stale ${item.name} pid=${item.pid} (${item.reason})${passSuffix}`);
    }

    if (dryRun) return 0;

    stopper(stale.map((item) => item.pid));
    if (pass < maxPasses - 1) sleep(settleMs);
  }

  if (!quiet) {
    const remaining = lastStale.map((item) => `${item.name} pid=${item.pid}`).join(", ");
    warn(`[veslo] Stale Windows dev processes remain after ${maxPasses} cleanup pass(es): ${remaining}`);
  }
  return 1;
}

export function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes("--dry-run");
  const quiet = argv.includes("--quiet");
  const quietEmpty = quiet || argv.includes("--quiet-empty");

  if (process.platform !== "win32") {
    if (!quiet) console.log("[veslo] Dev process cleanup is only needed on Windows.");
    return 0;
  }

  return cleanupStaleDevProcesses({ dryRun, quiet, quietEmpty });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`[veslo] Dev process cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
