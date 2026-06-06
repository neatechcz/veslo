import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { remote } from "webdriverio";

const e2eRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(e2eRoot, "../..");

const { startApp, stopApp, ensureWebDriverReady } = await import(
  pathToFileURL(resolve(e2eRoot, "helpers/app-launcher.ts")).href
);

async function readRootText(browser) {
  const root = await browser.$("#root");
  await root.waitForExist({ timeout: 30000 });
  return root.getText();
}

async function waitForAppShell(browser) {
  await browser.waitUntil(
    async () => {
      const text = await readRootText(browser);
      return text.trim().length > 0;
    },
    {
      timeout: 30000,
      timeoutMsg: "App shell did not render in time.",
    },
  );
}

async function readConnectionStatusPopover(browser) {
  const button = await browser.$('[aria-label="Connection status"]');
  await button.waitForExist({ timeout: 30000 });
  await button.click();
  await browser.pause(500);
  return browser.execute(() => document.body.innerText);
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function parseWindowsProcessJson(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const parsed = JSON.parse(trimmed);
  if (!parsed) return [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function readVisibleSidecarWindowsSnapshot() {
  if (process.platform !== "win32") {
    return {
      platform: process.platform,
      skipped: true,
      reason: "visible sidecar window probe is Windows-only",
      windows: [],
    };
  }

  const script = `
$probeRoot = ${JSON.stringify(repoRoot)}
$sidecarNames = @("opencode", "veslo-server", "veslo-code-router", "opencode-router", "veslo-orchestrator", "veslo-code")
$consoleNames = @("conhost", "cmd", "powershell", "pwsh", "windowsterminal", "openconsole")
$sidecarPattern = "(?i)(opencode|veslo-server|veslo-code-router|opencode-router|veslo-orchestrator|veslo-code)"
$processById = @{}
Get-CimInstance Win32_Process | ForEach-Object { $processById[[int]$_.ProcessId] = $_ }

function Test-ContainsProbeRoot([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return $false }
  return $value.IndexOf($probeRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Test-ProbeOwned([int]$processId) {
  $seen = @{}
  while (($processId -gt 0) -and (-not $seen.ContainsKey($processId))) {
    $seen[$processId] = $true
    $info = $processById[$processId]
    if ($null -eq $info) { return $false }
    if ((Test-ContainsProbeRoot ([string]$info.ExecutablePath)) -or (Test-ContainsProbeRoot ([string]$info.CommandLine))) {
      return $true
    }
    $processId = [int]$info.ParentProcessId
  }
  return $false
}

$windows = Get-Process | Where-Object {
  $title = [string]$_.MainWindowTitle
  $name = $_.ProcessName.ToLowerInvariant()
  ($_.MainWindowHandle -ne 0) -and (
    ($sidecarNames -contains $name) -or
    (($consoleNames -contains $name) -and ($title -match $sidecarPattern))
  ) -and (Test-ProbeOwned ([int]$_.Id))
} | ForEach-Object {
  $info = $processById[[int]$_.Id]
  $parentPid = $null
  if ($null -ne $info) { $parentPid = [int]$info.ParentProcessId }
  [pscustomobject]@{
    pid = $_.Id
    processName = $_.ProcessName
    title = $_.MainWindowTitle
    mainWindowHandle = $_.MainWindowHandle
    parentPid = $parentPid
  }
}
@($windows) | ConvertTo-Json -Compress
`;

  try {
    const raw = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    return {
      platform: "win32",
      skipped: false,
      windows: parseWindowsProcessJson(raw),
    };
  } catch (error) {
    return {
      platform: "win32",
      skipped: false,
      windows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function mergeVisibleSidecarWindowSamples(samples) {
  if (process.platform !== "win32") {
    return readVisibleSidecarWindowsSnapshot();
  }

  const windowsByKey = new Map();
  const errors = [];
  for (const sample of samples) {
    if (sample.error) errors.push(sample.error);
    for (const window of sample.windows ?? []) {
      const key = `${window.pid}:${window.processName}:${window.title}`;
      windowsByKey.set(key, window);
    }
  }

  return {
    platform: "win32",
    skipped: false,
    sampleCount: samples.length,
    windows: [...windowsByKey.values()],
    errors,
  };
}

async function sampleVisibleSidecarWindowsDuring(action, options = {}) {
  const intervalMs = options.intervalMs ?? 150;
  const minDurationMs = options.minDurationMs ?? 1500;
  const afterSettleMs = options.afterSettleMs ?? 1000;
  const maxDurationMs = options.maxDurationMs ?? 15000;
  const startedAt = Date.now();
  const samples = [readVisibleSidecarWindowsSnapshot()];
  let settledAt = null;

  const sampler = (async () => {
    while (Date.now() - startedAt < maxDurationMs) {
      if (
        settledAt !== null &&
        Date.now() - startedAt >= minDurationMs &&
        Date.now() - settledAt >= afterSettleMs
      ) {
        break;
      }
      await sleep(intervalMs);
      samples.push(readVisibleSidecarWindowsSnapshot());
    }
  })();

  let result = null;
  let error = null;
  try {
    result = await action();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    settledAt = Date.now();
  }

  await sampler;
  return {
    result,
    error,
    visibleSidecarWindows: mergeVisibleSidecarWindowSamples(samples),
  };
}

async function probeLocalServer() {
  const statePath = join(process.env.LOCALAPPDATA ?? "", "com.neatech.veslo", "veslo-server-state.json");
  let rawState;
  try {
    rawState = await readFile(statePath, "utf8");
  } catch (error) {
    return {
      statePath,
      stateMissing: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const state = JSON.parse(rawState);
  const baseUrl = String(state.baseUrl ?? "").trim();
  const token = String(state.clientToken ?? "").trim();
  const hostToken = String(state.hostToken ?? "").trim();
  const headers = {
    Authorization: `Bearer ${token}`,
    "X-Veslo-Host-Token": hostToken,
  };

  const health = await fetch(`${baseUrl}/health`).then(async (response) => ({
    ok: response.ok,
    status: response.status,
    body: await response.text(),
  }));

  const capabilities = await fetch(`${baseUrl}/capabilities`, { headers }).then(async (response) => ({
    ok: response.ok,
    status: response.status,
    body: await response.text(),
  }));

  return { state, health, capabilities };
}

async function probeTauriCommands(browser) {
  const payload = await browser.executeAsync((done) => {
    const stringify = (value) =>
      JSON.stringify(value, (_key, nextValue) =>
        typeof nextValue === "bigint" ? nextValue.toString() : nextValue,
      );
    const internals = window.__TAURI_INTERNALS__;
    const result = {
      internalsKeys: internals ? Object.keys(internals).sort() : [],
      invokeAvailable: typeof internals?.invoke === "function",
      bootstrap: null,
      engineInfo: null,
      orchestratorStatus: null,
      vesloInfo: null,
      errors: [],
    };

    if (typeof internals?.invoke !== "function") {
      done(stringify(result));
      return;
    }

    const invoke = async (command, args = {}, timeoutMs = 15000) => {
      try {
        return await Promise.race([
          internals.invoke(command, args),
          new Promise((_, reject) => {
            window.setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
          }),
        ]);
      } catch (error) {
        result.errors.push(`${command}:${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    };

    (async () => {
      result.bootstrap = await invoke("workspace_bootstrap");
      result.engineInfo = await invoke("engine_info");
      result.orchestratorStatus = await invoke("orchestrator_status");
      result.vesloInfo = await invoke("veslo_server_info");
      done(stringify(result));
    })().catch((error) => {
      result.errors.push(`probe:${error instanceof Error ? error.message : String(error)}`);
      done(stringify(result));
    });
  });

  return typeof payload === "string" ? JSON.parse(payload) : payload;
}

async function invokeTauriCommand(browser, command, args = {}, timeoutMs = 15000) {
  const payload = await browser.executeAsync(
    (commandName, commandArgs, commandTimeoutMs, done) => {
      const stringify = (value) =>
        JSON.stringify(value, (_key, nextValue) =>
          typeof nextValue === "bigint" ? nextValue.toString() : nextValue,
        );
      const internals = window.__TAURI_INTERNALS__;
      if (typeof internals?.invoke !== "function") {
        done(stringify({
          value: null,
          error: "window.__TAURI_INTERNALS__.invoke is not available",
        }));
        return;
      }

      Promise.race([
        internals.invoke(commandName, commandArgs),
        new Promise((_, reject) => {
          window.setTimeout(
            () => reject(new Error(`timed out after ${commandTimeoutMs}ms`)),
            commandTimeoutMs,
          );
        }),
      ])
        .then((value) => done(stringify({ value, error: null })))
        .catch((error) =>
          done(stringify({
            value: null,
            error: error instanceof Error ? error.message : String(error),
          })),
        );
    },
    command,
    args,
    timeoutMs,
  );
  return typeof payload === "string" ? JSON.parse(payload) : payload;
}

let browser;
try {
  await startApp();
  await ensureWebDriverReady();

  browser = await remote({
    hostname: "127.0.0.1",
    port: 4445,
    path: "/",
    logLevel: "warn",
    capabilities: {
      browserName: "chrome",
      "goog:chromeOptions": {},
    },
  });

  await waitForAppShell(browser);
  await browser.pause(15000);

  const rootText = await readRootText(browser);
  const serviceStatusText = await readConnectionStatusPopover(browser);
  const clientState = await browser.execute(() => ({
    href: window.location.href,
    hash: window.location.hash,
    localStorageKeys: Object.keys(window.localStorage).sort(),
  }));
  const tauriCommands = await probeTauriCommands(browser);
  const restartProbe = await sampleVisibleSidecarWindowsDuring(
    () => invokeTauriCommand(browser, "veslo_server_restart"),
  );
  tauriCommands.vesloRestart = restartProbe.result?.value ?? null;
  if (restartProbe.error) {
    tauriCommands.errors.push(`veslo_server_restart:${restartProbe.error}`);
  }
  if (restartProbe.result?.error) {
    tauriCommands.errors.push(`veslo_server_restart:${restartProbe.result.error}`);
  }
  const visibleSidecarWindows = restartProbe.visibleSidecarWindows;
  const visibilityProbeErrors =
    visibleSidecarWindows.platform === "win32" ? visibleSidecarWindows.errors ?? [] : [];

  let probe = await probeLocalServer();
  if (probe.stateMissing) {
    await browser.pause(5000);
    probe = await probeLocalServer();
  }

  console.log(
    JSON.stringify(
      {
        rootText,
        serviceStatusText,
        clientState,
        tauriCommands,
        state: probe.state,
        statePath: probe.statePath,
        stateMissing: probe.stateMissing ?? false,
        probeError: probe.error ?? null,
        visibleSidecarWindows,
        health: probe.health,
        capabilities: probe.capabilities,
      },
      null,
      2,
    ),
  );

  if (restartProbe.error || restartProbe.result?.error) {
    process.exitCode = 1;
    console.error("Veslo server restart failed during the visible Windows sidecar window probe.");
  }
  if (visibilityProbeErrors.length > 0) {
    process.exitCode = 1;
    console.error("Windows sidecar visibility probe failed to enumerate process windows.");
  }
  if (visibleSidecarWindows.windows?.length > 0) {
    process.exitCode = 1;
    console.error("Visible Windows sidecar console windows detected during veslo_server_restart.");
  }
} finally {
  if (browser) {
    await browser.deleteSession().catch(() => {});
  }
  await stopApp();
}
