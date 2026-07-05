import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveLaunchTimeout,
  resolvePilotRuntimeDir,
  resolvePilotSocketPath,
  startApp,
  stopApp,
} from "../helpers/app-launcher.js";
import { resolvePilotBinary } from "../helpers/pilot-runner.js";

process.env.E2E_TAURI_PILOT_RUNTIME_DIR ||= join(tmpdir(), `vpp${process.pid.toString(36)}`);
process.env.VESLO_DISABLE_DEV_AUTOSTART ||= "1";

type VesloServerInfo = {
  running?: boolean;
  baseUrl?: string | null;
  clientToken?: string | null;
  hostToken?: string | null;
};

type VesloServerConnection = {
  baseUrl: string;
  clientToken: string;
  hostToken: string;
};

type VesloWorkspaceList = {
  activeId?: string | null;
  workspaces?: Array<{ id?: string | null; active?: boolean | null }>;
};

type VesloPluginListResponse = {
  inventory?: Array<{ id?: string | null }>;
};

type PluginRow = {
  id: string;
  displayName: string;
  scope: string;
  source: string;
  lifecycle: string;
  enabledPolicy: string;
  removalPolicy: string;
  visibility: string;
  text: string;
  hasToggleAction: boolean;
  hasRemoveAction: boolean;
  hasRestoreAction: boolean;
};

const launchTimeoutMs = resolveLaunchTimeout();
const pilotCommand = resolvePilotBinary();
const pilotSocketPath = resolvePilotSocketPath({ runtimeDir: resolvePilotRuntimeDir() });
const denAuthJson = JSON.stringify({
  denApiBase: "http://127.0.0.1:9",
  token: "veslo-plugin-policy-e2e-token",
  orgId: "org_plugin_policy_e2e",
  user: {
    id: "user_plugin_policy_e2e",
    email: "plugin-policy-e2e@example.test",
  },
  org: { id: "org_plugin_policy_e2e", slug: "plugin-policy-e2e" },
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runProcess(
  command: string,
  args: string[],
  options: {
    input?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const child = spawn(command, args, {
    env: {
      ...process.env,
      TAURI_PILOT_SOCKET: pilotSocketPath,
      TAURI_PILOT_WINDOW: "main",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let settled = false;

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms\n${stderr}`));
    }, timeoutMs);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? code}\n${stderr}\n${stdout}`));
      }
    });

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
}

async function pilotJson<T>(args: string[], input?: string, timeoutMs?: number): Promise<T> {
  const result = await runProcess(pilotCommand, ["--json", "--socket", pilotSocketPath, ...args], {
    input,
    timeoutMs,
  });
  const raw = result.stdout.trim();
  if (!raw) return undefined as T;
  return JSON.parse(raw) as T;
}

async function retryPilotJson<T>(label: string, args: string[], input?: string, timeoutMs?: number): Promise<T> {
  const deadline = Date.now() + launchTimeoutMs;
  let latestError: unknown = null;

  while (Date.now() < deadline) {
    try {
      return await pilotJson<T>(args, input, timeoutMs);
    } catch (error) {
      latestError = error;
      await delay(1_000);
    }
  }

  throw new Error(`${label} failed after retries: ${latestError}`);
}

async function pilotEval<T>(script: string, timeoutMs?: number): Promise<T> {
  return pilotJson<T>(["eval", "-"], script, timeoutMs);
}

async function pilotIpc<T>(command: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
  const pilotArgs = Object.keys(args).length > 0
    ? ["ipc", command, "--args", JSON.stringify(args)]
    : ["ipc", command];
  return pilotJson<T>(pilotArgs, undefined, timeoutMs);
}

async function waitForSelector(selector: string, timeoutMs = 60_000): Promise<void> {
  await pilotJson(["wait", "--selector", selector, "--timeout", String(timeoutMs)], undefined, timeoutMs + 5_000);
}

async function waitForPilotReady(): Promise<void> {
  const deadline = Date.now() + launchTimeoutMs;
  let latestError: unknown = null;

  while (Date.now() < deadline) {
    try {
      await pilotJson(["ping"], undefined, 5_000);
      await pilotJson(["state"], undefined, 5_000);
      console.log("[pilot-e2e] tauri-pilot is ready.");
      return;
    } catch (error) {
      latestError = error;
      await delay(500);
    }
  }

  throw new Error(`tauri-pilot did not become ready on ${pilotSocketPath}: ${latestError}`);
}

async function waitForWebviewEvalReady(): Promise<void> {
  const deadline = Date.now() + launchTimeoutMs;
  let latestError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const ready = await pilotEval<boolean>(`
        (() => document.readyState !== "loading" && Boolean(document.body))()
      `, 15_000);
      if (ready) {
        console.log("[pilot-e2e] WebView eval is ready.");
        return;
      }
    } catch (error) {
      latestError = error;
    }
    await delay(1_000);
  }

  throw new Error(`WebView eval did not become ready: ${latestError}`);
}

async function waitForLocalVesloServerReady(): Promise<VesloServerConnection> {
  const deadline = Date.now() + 60_000;
  let latest: VesloServerInfo | null = null;
  let latestError: unknown = null;

  while (Date.now() < deadline) {
    try {
      latest = await pilotIpc<VesloServerInfo>("veslo_server_info", {}, 10_000);
      const connection = await resolveReadyServerConnection(latest);
      if (connection) return connection;
    } catch (error) {
      latestError = error;
      // Keep polling while the app starts the local server.
    }
    await delay(500);
  }

  throw new Error(
    `Local Veslo server did not become ready. Latest info: ${JSON.stringify(latest)} Latest error: ${latestError}`,
  );
}

async function navigateToPlugins(options: { debug?: boolean } = {}): Promise<void> {
  await retryPilotJson<string>("prepare plugins route", ["eval", "-"], `
    (() => {
      window.localStorage.setItem("veslo.language", "en");
      window.localStorage.setItem("veslo.onboardingComplete", "1");
      window.localStorage.setItem("veslo.startupPref", "local");
      window.localStorage.setItem("veslo.den.keepSignedIn", "1");
      window.localStorage.setItem("veslo.den.auth", ${JSON.stringify(denAuthJson)});
      window.sessionStorage.removeItem("veslo.den.auth");
      const oldURL = window.location.href;
      const target = window.location.origin + window.location.pathname + "#/dashboard/plugins${options.debug ? "?debug" : ""}";
      window.history.replaceState(window.history.state, "", target);
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
      window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL, newURL: target }));
      return target;
    })()
  `, 15_000);
}

async function resolveReadyServerConnection(info: VesloServerInfo | null): Promise<VesloServerConnection | null> {
  const baseUrl = info?.baseUrl?.trim().replace(/\/+$/, "") ?? "";
  const clientToken = info?.clientToken?.trim() ?? "";
  const hostToken = info?.hostToken?.trim() ?? "";
  if (!info?.running || !baseUrl || !clientToken || !hostToken) return null;

  const health = await fetch(`${baseUrl}/health`).catch(() => null);
  const capabilities = await fetch(`${baseUrl}/capabilities`, {
    headers: {
      Authorization: `Bearer ${clientToken}`,
      "X-Veslo-Host-Token": hostToken,
    },
  }).catch(() => null);
  if (health?.ok !== true || capabilities?.ok !== true) return null;

  return { baseUrl, clientToken, hostToken };
}

async function fetchServerJson<T>(connection: VesloServerConnection, path: string): Promise<T> {
  const response = await fetch(`${connection.baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${connection.clientToken}`,
      "X-Veslo-Host-Token": connection.hostToken,
    },
  });
  if (!response.ok) {
    throw new Error(`Server request ${path} failed with ${response.status}: ${await response.text()}`);
  }
  return await response.json() as T;
}

async function resolveServerWorkspaceId(connection: VesloServerConnection): Promise<string> {
  const list = await fetchServerJson<VesloWorkspaceList>(connection, "/workspaces");
  const activeId = list.activeId?.trim();
  if (activeId) return activeId;
  const activeWorkspace = list.workspaces?.find((workspace) => workspace.active === true)?.id?.trim();
  if (activeWorkspace) return activeWorkspace;
  const firstWorkspace = list.workspaces?.find((workspace) => workspace.id?.trim())?.id?.trim();
  if (firstWorkspace) return firstWorkspace;
  throw new Error(`Unable to resolve server workspace id from ${JSON.stringify(list)}`);
}

async function assertServerPluginInventory(
  connection: VesloServerConnection,
  workspaceId: string,
  options: { debug?: boolean } = {},
): Promise<void> {
  const query = options.debug ? "?debug=true" : "";
  const result = await fetchServerJson<VesloPluginListResponse>(
    connection,
    `/workspace/${encodeURIComponent(workspaceId)}/plugins${query}`,
  );
  const ids = result.inventory?.map((item) => item.id ?? "") ?? [];
  assert.ok(ids.includes("platform.superpowers"), `Server inventory should include Superpowers. ids=${ids.join(",")}`);
  if (options.debug) {
    assert.ok(
      ids.includes("platform.opencode-scheduler"),
      `Debug server inventory should include scheduler. ids=${ids.join(",")}`,
    );
  }
}

async function preparePluginsPage(options: { debug?: boolean } = {}): Promise<void> {
  await navigateToPlugins(options);
  await waitForSelector('[data-testid="plugin-inventory-refresh"]', 60_000);
}

async function readPluginRows(timeoutMs = 5_000): Promise<PluginRow[]> {
  return pilotEval<PluginRow[]>(`
    (() => Array.from(document.querySelectorAll('[data-testid="plugin-inventory-row"]')).map((row) => {
      const element = row;
      return {
        id: element.getAttribute("data-plugin-id") ?? "",
        displayName: element.getAttribute("data-plugin-display-name") ?? "",
        scope: element.getAttribute("data-plugin-scope") ?? "",
        source: element.getAttribute("data-plugin-source") ?? "",
        lifecycle: element.getAttribute("data-plugin-lifecycle") ?? "",
        enabledPolicy: element.getAttribute("data-plugin-enabled-policy") ?? "",
        removalPolicy: element.getAttribute("data-plugin-removal-policy") ?? "",
        visibility: element.getAttribute("data-plugin-visibility") ?? "",
        text: element.innerText ?? element.textContent ?? "",
        hasToggleAction: Boolean(element.querySelector('[data-testid="plugin-inventory-toggle"]')),
        hasRemoveAction: Boolean(element.querySelector('[data-testid="plugin-inventory-remove"]')),
        hasRestoreAction: Boolean(element.querySelector('[data-testid="plugin-inventory-restore"]')),
      };
    }))()
  `, timeoutMs);
}

async function inspectPluginsPage(): Promise<unknown> {
  return pilotEval<unknown>(`
    (() => ({
      href: window.location.href,
      readyState: document.readyState,
      refreshButton: Boolean(document.querySelector('[data-testid="plugin-inventory-refresh"]')),
      rows: Array.from(document.querySelectorAll('[data-testid="plugin-inventory-row"]')).map((row) => ({
        id: row.getAttribute("data-plugin-id") ?? "",
        visibility: row.getAttribute("data-plugin-visibility") ?? "",
        text: row.textContent ?? "",
      })),
      bodyText: (document.body?.innerText ?? document.body?.textContent ?? "").slice(0, 1800),
    }))()
  `, 5_000).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
}

async function waitForPluginRow(id: string, timeoutMs = 60_000): Promise<PluginRow[]> {
  const deadline = Date.now() + timeoutMs;
  let latestRows: PluginRow[] = [];
  let latestError: unknown = null;

  while (Date.now() < deadline) {
    try {
      latestRows = await readPluginRows();
      if (pluginRow(latestRows, id)) return latestRows;
    } catch (error) {
      latestError = error;
    }
    await delay(1_000);
  }

  throw new Error(
    `Expected plugin row ${id}. Rows=${JSON.stringify(latestRows, null, 2)} ` +
    `Latest error=${latestError} Page=${JSON.stringify(await inspectPluginsPage(), null, 2)}`,
  );
}

function pluginRow(rows: PluginRow[], id: string): PluginRow | undefined {
  return rows.find((row) => row.id === id);
}

function requirePluginRow(rows: PluginRow[], id: string): PluginRow {
  const row = pluginRow(rows, id);
  assert.ok(row, `Expected plugin row ${id}. Rows=${JSON.stringify(rows, null, 2)}`);
  return row;
}

async function run(): Promise<void> {
  process.env.E2E_SKILL_REGISTRY_FIXTURE = "0";
  process.env.E2E_DEN_AUTH_JSON = denAuthJson;

    await startApp();
  try {
    await waitForPilotReady();
    await waitForWebviewEvalReady();
    const serverConnection = await waitForLocalVesloServerReady();
    const serverWorkspaceId = await resolveServerWorkspaceId(serverConnection);
    await assertServerPluginInventory(serverConnection, serverWorkspaceId);
    await preparePluginsPage();
    await waitForPluginRow("platform.superpowers");

    const normalRows = await readPluginRows();
    const normalSuperpowers = requirePluginRow(normalRows, "platform.superpowers");
    assert.equal(normalSuperpowers.displayName, "Superpowers");
    assert.equal(normalSuperpowers.scope, "platform");
    assert.equal(normalSuperpowers.source, "policy.platform");
    assert.equal(normalSuperpowers.lifecycle, "active");
    assert.equal(normalSuperpowers.enabledPolicy, "user-toggleable");
    assert.equal(normalSuperpowers.removalPolicy, "user-removable");
    assert.equal(normalSuperpowers.visibility, "visible");
    assert.equal(normalSuperpowers.hasToggleAction, true, `Superpowers should expose a user toggle action. Row=${JSON.stringify(normalSuperpowers)}`);
    assert.equal(normalSuperpowers.hasRemoveAction, true, `Superpowers should expose a user remove action. Row=${JSON.stringify(normalSuperpowers)}`);
    assert.equal(
      pluginRow(normalRows, "platform.opencode-scheduler"),
      undefined,
      `Expected scheduler to be absent in normal Plugins mode. Rows=${JSON.stringify(normalRows, null, 2)}`,
    );

    await preparePluginsPage({ debug: true });
    await assertServerPluginInventory(serverConnection, serverWorkspaceId, { debug: true });
    await waitForPluginRow("platform.opencode-scheduler");
    const debugRows = await readPluginRows();
    assert.equal(requirePluginRow(debugRows, "platform.superpowers").displayName, "Superpowers");

    const scheduler = requirePluginRow(debugRows, "platform.opencode-scheduler");
    assert.equal(scheduler.displayName, "OpenCode Scheduler");
    assert.equal(scheduler.scope, "platform");
    assert.equal(scheduler.source, "policy.platform");
    assert.equal(scheduler.lifecycle, "active");
    assert.equal(scheduler.enabledPolicy, "locked-on");
    assert.equal(scheduler.removalPolicy, "locked");
    assert.equal(scheduler.visibility, "hidden-debug-only");
    assert.match(scheduler.text, /enabled/i);
    assert.match(scheduler.text, /debug/i);
    assert.equal(scheduler.hasToggleAction, false, `Locked scheduler should not expose disable action. Row=${JSON.stringify(scheduler)}`);
    assert.equal(scheduler.hasRemoveAction, false, `Locked scheduler should not expose remove action. Row=${JSON.stringify(scheduler)}`);

    console.log("[pilot-e2e] Plugin policy tauri-pilot E2E passed.");
  } finally {
    await stopApp();
  }
}

run().catch(async (error) => {
  await stopApp().catch(() => {});
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
