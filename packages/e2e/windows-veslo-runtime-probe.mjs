import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { remote } from "webdriverio";

const repoRoot = process.cwd();
const e2eRoot = resolve(repoRoot, "packages/e2e");
const snapshotFile =
  process.env.VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE?.trim() ||
  resolve(e2eRoot, ".tmp-opencode-home-live/.veslo/den-auth.json");

process.env.VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE = snapshotFile;

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
  const payload = await browser.execute(async () => {
    const internals = window.__TAURI_INTERNALS__;
    const result = {
      internalsKeys: internals ? Object.keys(internals).sort() : [],
      invokeAvailable: typeof internals?.invoke === "function",
      bootstrap: null,
      engineInfo: null,
      orchestratorStatus: null,
      vesloInfo: null,
      vesloRestart: null,
      errors: [],
    };

    if (typeof internals?.invoke !== "function") {
      return result;
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

    result.bootstrap = await invoke("workspace_bootstrap");
    result.engineInfo = await invoke("engine_info");
    result.orchestratorStatus = await invoke("orchestrator_status");
    result.vesloInfo = await invoke("veslo_server_info");
    result.vesloRestart = await invoke("veslo_server_restart");

    return result;
  });

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
        health: probe.health,
        capabilities: probe.capabilities,
      },
      null,
      2,
    ),
  );
} finally {
  if (browser) {
    await browser.deleteSession().catch(() => {});
  }
  await stopApp();
}
