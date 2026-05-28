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
  const result = spawnSync(powershellExe(), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "PowerShell command failed").trim();
    throw new Error(message);
  }
  return result.stdout ?? "";
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

export function classifyDevProcess(processInfo, context) {
  const pid = Number(processInfo.ProcessId ?? processInfo.processId ?? 0);
  const name = String(processInfo.Name ?? processInfo.name ?? "").toLowerCase();
  const executablePath = String(processInfo.ExecutablePath ?? processInfo.executablePath ?? "");

  if (pid <= 0 || pid === process.pid) return null;

  if (
    SIDECAR_PROCESS_NAMES.has(name) &&
    (isPathInside(executablePath, context.targetDebugDir) || isPathInside(executablePath, context.sidecarsDir))
  ) {
    return "repo sidecar executable";
  }

  if (context.vesloServerWatcherPids?.has(pid) && looksLikeVesloServerWatcher(processInfo.CommandLine ?? processInfo.commandLine)) {
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

function stopProcesses(pids) {
  if (pids.length === 0) return;
  const quoted = pids.map((pid) => String(pid)).join(",");
  runPowerShell(`Stop-Process -Id ${quoted} -Force -ErrorAction SilentlyContinue`);
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

export function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes("--dry-run");
  const quiet = argv.includes("--quiet");
  const quietEmpty = quiet || argv.includes("--quiet-empty");

  if (process.platform !== "win32") {
    if (!quiet) console.log("[veslo] Dev process cleanup is only needed on Windows.");
    return 0;
  }

  const processes = readProcesses();
  const listeningPorts = readListeningPorts();
  const stale = findStaleDevProcesses(processes, listeningPorts, { targetDebugDir, sidecarsDir });

  if (stale.length === 0) {
    if (!quietEmpty) console.log("[veslo] No stale Windows dev processes found.");
    return 0;
  }

  for (const item of stale) {
    if (!quiet) console.log(`[veslo] ${dryRun ? "Would stop" : "Stopping"} stale ${item.name} pid=${item.pid} (${item.reason})`);
  }

  if (!dryRun) {
    stopProcesses(stale.map((item) => item.pid));
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`[veslo] Dev process cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
