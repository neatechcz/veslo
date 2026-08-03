import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
const START_TIMEOUT_MS = 180_000;
const GRACEFUL_STOP_TIMEOUT_MS = 15_000;
const FORCE_STOP_TIMEOUT_MS = 10_000;

// Tauri's Rust sidecar can outlive the desktop child tree on Windows. Snapshot
// only these dev-runtime processes before launch, then remove solely new ones
// during owned teardown. The desktop preflight guarantees this is a
// single-tenant test surface.
export const OWNED_BACKGROUND_COMMAND_LINE_PATTERN = [
  "vite\\\\bin\\\\vite\\.js",
  "veslo-orchestrator\\.exe",
  "opencode\\.exe",
  "veslo-server(?:\\.exe)?",
  "veslo-code(?:\\.exe)?",
  "veslo-code-router(?:\\.exe)?",
].join("|");

export function ownedDiagnosticEnvironment(env = process.env) {
  return {
    ...env,
    // An owned scenario is explicit diagnostic work. Do not let a caller's
    // quiet-profile setting turn off the evidence needed for an unrelated
    // renderer, server, or sidecar failure during the same run.
    VESLO_RUNTIME_DIAGNOSTICS: "1",
    VITE_VESLO_RUNTIME_DIAGNOSTICS: "1",
    VESLO_RUNTIME_TRACE: "1",
    VESLO_SEND_WORKFLOW_TRACE: "1",
    VITE_VESLO_SEND_WORKFLOW_TRACE: "1",
    VITE_VESLO_SESSION_UI_MUTATION_TRACE: "1",
    VESLO_OPENCODE_HEALTH_DIAG: "1",
    RUST_BACKTRACE: "1",
  };
}

const pause = (milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));

export function pnpmExecutable(platform = process.platform) {
  return platform === "win32" ? "pnpm.cmd" : "pnpm";
}

export function ownedRuntimeInfoPath(runDirectory) {
  return resolve(runDirectory, "runtime-info.json");
}

export function isLiveWebDriverRuntimeInfo(value) {
  return value?.schema === "veslo-dev-runtime/v1" && value?.mode === "live-dev-webdriver";
}

async function readLiveRuntimeInfo(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return isLiveWebDriverRuntimeInfo(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function hasNativeWebDriverDescriptor(runtimeInfo, runtimeInfoPath) {
  const descriptorPath = runtimeInfo?.webdriver?.descriptorPath;
  if (typeof descriptorPath !== "string" || !descriptorPath.trim()) return false;
  const resolvedDescriptorPath = isAbsolute(descriptorPath)
    ? descriptorPath
    : resolve(dirname(runtimeInfoPath), descriptorPath);
  try {
    const descriptor = JSON.parse(await readFile(resolvedDescriptorPath, "utf8"));
    return descriptor?.schema === "veslo-native-webdriver/v1" && descriptor?.mode === "live-dev-webdriver";
  } catch {
    return false;
  }
}

function desktopDevLaunchCommand() {
  return {
    command: process.execPath,
    // This is the exact implementation invoked by `pnpm dev:webdriver`.
    // Running it directly makes the harness the unambiguous process-tree
    // owner on Windows, where pnpm.cmd otherwise detaches nested children.
    args: [join(repoRoot, "packages", "desktop", "scripts", "tauri-dev.mjs"), "--webdriver"],
    cwd: join(repoRoot, "packages", "desktop"),
  };
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (value) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onExit);
      resolveExit(value);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    child.once("error", onExit);
  });
}

async function runQuiet(command, args) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.once("error", () => resolveResult(false));
    child.once("exit", (code) => resolveResult(code === 0));
  });
}

async function collectOutput(command, args) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.once("error", () => resolveResult(""));
    child.once("exit", () => resolveResult(output));
  });
}

async function ownedBackgroundProcessIds(platform = process.platform) {
  if (platform !== "win32") return [];
  const output = await collectOutput("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${OWNED_BACKGROUND_COMMAND_LINE_PATTERN}' } | ForEach-Object { $_.ProcessId }`,
  ]);
  return output.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function stopOwnedBackgroundProcesses(processIds, platform = process.platform) {
  if (platform !== "win32") return;
  await Promise.all(processIds.map((pid) => runQuiet("taskkill", ["/pid", String(pid), "/t", "/f"])));
}

export async function stopOwnedDevRuntime(child, { platform = process.platform } = {}) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return "already-exited";

  try {
    child.kill("SIGINT");
  } catch {
    // The fallbacks below are intentionally limited to this exact child tree.
  }
  if (await waitForExit(child, GRACEFUL_STOP_TIMEOUT_MS)) return "graceful";

  if (platform === "win32") {
    await runQuiet("taskkill", ["/pid", String(child.pid), "/t"]);
    if (await waitForExit(child, GRACEFUL_STOP_TIMEOUT_MS)) return "tree";
    await runQuiet("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
  } else {
    try {
      child.kill("SIGKILL");
    } catch {
      // The exit result below remains authoritative.
    }
  }
  if (await waitForExit(child, FORCE_STOP_TIMEOUT_MS)) return "forced";
  throw new Error("The owned Veslo development runtime did not stop.");
}

// A restart scenario must release only the desktop and sidecars it started.
// Keeping this teardown beside launch prevents a second phase from inheriting
// a stale server/orchestrator while preserving any user-owned runtime.
export async function stopOwnedLiveWebDriverRuntime(runtime, options = {}) {
  const shutdown = await stopOwnedDevRuntime(runtime?.child, options);
  const currentBackgroundPids = await ownedBackgroundProcessIds(options.platform);
  await stopOwnedBackgroundProcesses(
    currentBackgroundPids.filter((pid) => !runtime.preexistingBackgroundPids.includes(pid)),
    options.platform,
  );
  return shutdown;
}

export async function startOwnedLiveWebDriverRuntime({
  runDirectory,
  env = process.env,
  startTimeoutMs = START_TIMEOUT_MS,
  platform = process.platform,
} = {}) {
  const resolvedRunDirectory = resolve(runDirectory);
  const runtimeInfoPath = ownedRuntimeInfoPath(resolvedRunDirectory);
  const preexistingBackgroundPids = await ownedBackgroundProcessIds(platform);
  await mkdir(resolvedRunDirectory, { recursive: true });
  const launch = desktopDevLaunchCommand();
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: {
      ...ownedDiagnosticEnvironment(env),
      VESLO_DEV_RUNTIME_DIR: resolvedRunDirectory,
    },
    stdio: "ignore",
    windowsHide: true,
  });
  const deadline = Date.now() + startTimeoutMs;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("The owned Veslo development runtime exited before WebDriver became ready.");
      }
      const runtimeInfo = await readLiveRuntimeInfo(runtimeInfoPath);
      if (runtimeInfo && await hasNativeWebDriverDescriptor(runtimeInfo, runtimeInfoPath)) {
        return { child, runDirectory: resolvedRunDirectory, runtimeInfoPath, runtimeInfo, preexistingBackgroundPids };
      }
      await pause(250);
    }
    throw new Error("Timed out waiting for the owned Veslo WebDriver runtime.");
  } catch (error) {
    await stopOwnedDevRuntime(child, { platform }).catch(() => {});
    const currentBackgroundPids = await ownedBackgroundProcessIds(platform);
    await stopOwnedBackgroundProcesses(
      currentBackgroundPids.filter((pid) => !preexistingBackgroundPids.includes(pid)),
      platform,
    );
    throw error;
  }
}

export async function withOwnedLiveWebDriverRuntime({ runDirectory, execute, ...options }) {
  const runtime = await startOwnedLiveWebDriverRuntime({ runDirectory, ...options });
  let result;
  let thrown;
  let shutdown = "unknown";
  try {
    result = await execute(runtime);
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  } finally {
    shutdown = await stopOwnedLiveWebDriverRuntime(runtime, options).catch((error) => {
      if (!thrown) thrown = error instanceof Error ? error : new Error(String(error));
      return "failed";
    });
  }
  if (thrown) {
    thrown.runtimeInfoPath = runtime.runtimeInfoPath;
    thrown.shutdown = shutdown;
    throw thrown;
  }
  return { ...result, runtimeInfoPath: runtime.runtimeInfoPath, shutdown };
}
