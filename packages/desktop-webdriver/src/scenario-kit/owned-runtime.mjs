import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  // Tauri's CLI can orphan this debug desktop child on Windows. Restrict the
  // match to Cargo's debug output so an installed user application is never
  // treated as harness-owned.
  "target[\\\\/]debug[\\\\/]veslo\\.exe",
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

export function isIsolatedWebDriverRuntimeInfo(value) {
  return value?.schema === "veslo-dev-runtime/v1" && value?.mode === "isolated-dev-webdriver";
}

async function readLiveRuntimeInfo(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return isLiveWebDriverRuntimeInfo(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readIsolatedRuntimeInfo(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return isIsolatedWebDriverRuntimeInfo(parsed) ? parsed : null;
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
    return descriptor?.schema === "veslo-native-webdriver/v1" && descriptor?.mode === runtimeInfo?.mode;
  } catch {
    return false;
  }
}

function desktopDevLaunchCommand(mode = "live") {
  return {
    command: process.execPath,
    // This is the exact implementation invoked by `pnpm dev:webdriver`.
    // Running it directly makes the harness the unambiguous process-tree
    // owner on Windows, where pnpm.cmd otherwise detaches nested children.
    args: [join(repoRoot, "packages", "desktop", "scripts", "tauri-dev.mjs"), mode === "isolated" ? "--webdriver-isolated" : "--webdriver"],
    cwd: join(repoRoot, "packages", "desktop"),
  };
}

function captureOwnedRuntimeOutput(child, runDirectory) {
  const outputPath = join(runDirectory, "desktop-runtime-output.log");
  const output = createWriteStream(outputPath, { flags: "a" });
  let tail = "";
  const append = (channel, chunk) => {
    const text = String(chunk);
    output.write(`[${channel}] ${text}`);
    tail = `${tail}[${channel}] ${text}`.slice(-8_000);
  };
  child.stdout?.on("data", (chunk) => append("stdout", chunk));
  child.stderr?.on("data", (chunk) => append("stderr", chunk));
  child.once("exit", () => output.end());
  child.once("error", () => output.end());
  return { outputPath, tail: () => tail };
}

async function waitForOwnedRuntime({ child, runtimeInfoPath, readRuntimeInfo, preexistingBackgroundPids, platform, timeoutMs, output }) {
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        const diagnostic = output?.tail().trim();
        throw new Error(
          "The owned Veslo development runtime exited before WebDriver became ready "
          + `(code=${child.exitCode ?? "null"}, signal=${child.signalCode ?? "none"}). `
          + `See ${output?.outputPath ?? "the owned runtime output"}.`
          + (diagnostic ? `\n${diagnostic}` : ""),
        );
      }
      const runtimeInfo = await readRuntimeInfo(runtimeInfoPath);
      if (runtimeInfo && await hasNativeWebDriverDescriptor(runtimeInfo, runtimeInfoPath)) {
        return { child, runtimeInfoPath, runtimeInfo, preexistingBackgroundPids };
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

function isolatedProfilePaths(runDirectory) {
  const profileRoot = join(runDirectory, "profile");
  const opencodeHome = join(profileRoot, "opencode-home");
  const dataRoot = join(opencodeHome, ".veslo");
  return {
    profileRoot,
    opencodeHome,
    dataRoot,
    appConfigDir: join(dataRoot, "app-config"),
    appDataDir: join(dataRoot, "app-data"),
    appLocalDataDir: join(dataRoot, "app-local-data"),
    authSnapshotPath: join(dataRoot, "den-auth.json"),
    workspacePath: join(profileRoot, "workspace"),
  };
}

async function prepareIsolatedProfile({ runDirectory, gatewayBaseUrl, workspaceName }) {
  const paths = isolatedProfilePaths(runDirectory);
  await Promise.all([
    mkdir(paths.opencodeHome, { recursive: true }),
    mkdir(paths.appConfigDir, { recursive: true }),
    mkdir(paths.appDataDir, { recursive: true }),
    mkdir(paths.appLocalDataDir, { recursive: true }),
    mkdir(join(paths.workspacePath, ".opencode"), { recursive: true }),
  ]);
  const auth = {
    denApiBase: gatewayBaseUrl,
    token: "webdriver-managed-ai-token",
    orgId: "org_webdriver_managed_ai",
    user: { id: "user_webdriver_managed_ai", email: "webdriver-managed-ai@example.test" },
    org: { id: "org_webdriver_managed_ai", slug: "webdriver-managed-ai" },
  };
  await writeFile(paths.authSnapshotPath, `${JSON.stringify({
    version: 1,
    authJson: JSON.stringify(auth),
    keepSignedIn: true,
    language: "en",
    onboardingComplete: true,
    updatedAt: Date.now(),
    source: "webdriver-isolated-managed-ai",
  }, null, 2)}\n`, "utf8");
  const workspaceState = {
    version: 4,
    activeId: "webdriver-managed-ai-workspace",
    workspaces: [{
      id: "webdriver-managed-ai-workspace",
      name: workspaceName,
      path: paths.workspacePath,
      preset: "starter",
      workspaceType: "local",
      remoteType: "opencode",
      baseUrl: null,
      directory: null,
      displayName: workspaceName,
    }],
  };
  await writeFile(join(paths.appDataDir, "veslo-workspaces.json"), `${JSON.stringify(workspaceState, null, 2)}\n`, "utf8");
  return paths;
}

function isolatedRuntimeEnvironment(env, paths, gatewayBaseUrl, runDirectory) {
  // The desktop profile must be isolated, but Tauri's Cargo invocation is a
  // build tool and still needs the host-installed Rust toolchain.  Rustup
  // otherwise derives its home from the isolated USERPROFILE and fails before
  // the desktop executable is even built.
  const hostUserProfile = typeof env.USERPROFILE === "string" && env.USERPROFILE.trim()
    ? env.USERPROFILE
    : null;
  const rustupHome = env.RUSTUP_HOME || (hostUserProfile ? join(hostUserProfile, ".rustup") : undefined);
  const cargoHome = env.CARGO_HOME || (hostUserProfile ? join(hostUserProfile, ".cargo") : undefined);
  return {
    ...ownedDiagnosticEnvironment(env),
    VESLO_DEV_CLEANUP: "0",
    VESLO_DEV_CAPTURE_CHILD_OUTPUT: "1",
    VESLO_DEV_RUNTIME_DIR: runDirectory,
    VESLO_WEBDRIVER_ISOLATED_PROFILE: "1",
    OPENCODE_HOME: paths.opencodeHome,
    VESLO_DATA_DIR: paths.dataRoot,
    VESLO_APP_CONFIG_DIR: paths.appConfigDir,
    VESLO_APP_DATA_DIR: paths.appDataDir,
    VESLO_APP_LOCAL_DATA_DIR: paths.appLocalDataDir,
    VESLO_DEN_AUTH_SNAPSHOT_PATH: paths.authSnapshotPath,
    VESLO_AI_GATEWAY_BASE_URL: gatewayBaseUrl,
    VESLO_MANAGED_AI_BASE_URL: gatewayBaseUrl,
    HOME: paths.profileRoot,
    USERPROFILE: paths.profileRoot,
    APPDATA: join(paths.profileRoot, "AppData", "Roaming"),
    LOCALAPPDATA: join(paths.profileRoot, "AppData", "Local"),
    WEBVIEW2_USER_DATA_FOLDER: join(paths.profileRoot, "webview2"),
    ...(rustupHome ? { RUSTUP_HOME: rustupHome } : {}),
    ...(cargoHome ? { CARGO_HOME: cargoHome } : {}),
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
    `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match '${OWNED_BACKGROUND_COMMAND_LINE_PATTERN}' } | ForEach-Object { $_.ProcessId }`,
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
    stdio: ["ignore", "pipe", "pipe"],
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

/**
 * Starts a fully isolated native WebDriver desktop runtime. It refuses to run
 * beside an existing Veslo development/test process instead of relying on the
 * desktop dev script's broad cleanup, so it cannot touch a user's runtime.
 */
export async function startOwnedIsolatedWebDriverRuntime({
  runDirectory,
  gatewayBaseUrl,
  workspaceName = "WebDriver Managed AI Workspace",
  env = process.env,
  startTimeoutMs = START_TIMEOUT_MS,
  platform = process.platform,
} = {}) {
  const normalizedGatewayBaseUrl = String(gatewayBaseUrl ?? "").trim().replace(/\/+$/, "");
  if (!normalizedGatewayBaseUrl.startsWith("http://127.0.0.1:")) {
    throw new Error("The isolated WebDriver runtime requires a loopback managed-AI gateway fixture.");
  }
  const resolvedRunDirectory = resolve(runDirectory);
  const runtimeInfoPath = ownedRuntimeInfoPath(resolvedRunDirectory);
  const preexistingBackgroundPids = await ownedBackgroundProcessIds(platform);
  if (preexistingBackgroundPids.length > 0) {
    throw new Error(
      "Refusing to start the isolated desktop runtime while another Veslo dev/test runtime is active. "
      + "Stop or explicitly attach to that runtime first; this scenario will not terminate it.",
    );
  }
  await mkdir(resolvedRunDirectory, { recursive: true });
  const paths = await prepareIsolatedProfile({
    runDirectory: resolvedRunDirectory,
    gatewayBaseUrl: normalizedGatewayBaseUrl,
    workspaceName,
  });
  const launch = desktopDevLaunchCommand("isolated");
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: isolatedRuntimeEnvironment(env, paths, normalizedGatewayBaseUrl, resolvedRunDirectory),
    // Keep the wrapper's diagnostics attached to this owned process.  The
    // scenario otherwise has no useful fault evidence when Tauri fails before
    // the native WebDriver descriptor exists.
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const output = captureOwnedRuntimeOutput(child, resolvedRunDirectory);
  const runtime = await waitForOwnedRuntime({
    child,
    runtimeInfoPath,
    readRuntimeInfo: readIsolatedRuntimeInfo,
    preexistingBackgroundPids,
    platform,
    timeoutMs: startTimeoutMs,
    output,
  });
  return { ...runtime, runDirectory: resolvedRunDirectory, profile: paths, workspaceName, outputPath: output.outputPath };
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

export async function withOwnedIsolatedWebDriverRuntime({ runDirectory, execute, ...options }) {
  const runtime = await startOwnedIsolatedWebDriverRuntime({ runDirectory, ...options });
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
