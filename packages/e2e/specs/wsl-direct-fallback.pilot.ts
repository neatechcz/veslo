import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  startApp,
  stopApp,
} from "../helpers/app-launcher.js";

type OrchestratorEngineSnapshot = {
  workspaceId?: string | null;
  baseUrl?: string | null;
  childKind?: "direct" | "wsl" | null;
  state?: string | null;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..", "..", "..");
const e2eRoot = join(repoRoot, "packages", "e2e");
const profileRoot = join(e2eRoot, ".tmp-veslo-home");
const defaultWorkspacePath = join(profileRoot, "workspaces", "visual-workspace");
const tracePath = join(e2eRoot, ".tmp-opencode-home", ".veslo", "runtime-trace.jsonl");
const statePath = join(e2eRoot, ".tmp-opencode-home", ".veslo", "veslo-orchestrator-state.json");

type RouterState = {
  daemon?: {
    baseUrl?: string | null;
  } | null;
  workspaces?: Array<{
    id?: string | null;
    path?: string | null;
  }>;
};

type RouterWorkspacesResponse = {
  workspaces?: Array<{
    id?: string | null;
    path?: string | null;
  }>;
};

type RouterHealth = {
  engines?: OrchestratorEngineSnapshot[];
};

function extractWorkspaceIdFromProxyUrl(baseUrl: string): string | null {
  const pathname = new URL(baseUrl).pathname;
  const match = pathname.match(/\/workspace\/([^/]+)\/opencode(?:\/|$)/);
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

async function fetchJson<T>(url: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}: ${body.slice(0, 500)}`);
    }
    return (body.trim() ? JSON.parse(body) : undefined) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForDaemonBaseUrl(timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let latest: string | null = null;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(readFileSync(statePath, "utf8")) as RouterState;
      latest = state.daemon?.baseUrl?.trim() || null;
      if (latest) {
        await fetchJson<RouterHealth>(`${latest.replace(/\/+$/, "")}/health`, { timeoutMs: 2_000 });
        return latest.replace(/\/+$/, "");
      }
    } catch {
      // Keep polling while the app starts the daemon.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Orchestrator daemon did not become ready. Latest=${latest}`);
}

function normalizePathForCompare(value: string): string {
  return value.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

async function waitForRegisteredWorkspace(baseUrl: string, workspacePath: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const expectedPath = normalizePathForCompare(workspacePath);
  let latest: RouterWorkspacesResponse | null = null;
  while (Date.now() < deadline) {
    latest = await fetchJson<RouterWorkspacesResponse>(`${baseUrl}/workspaces`, { timeoutMs: 5_000 }).catch(() => null);
    const match = latest?.workspaces?.find((workspace) =>
      workspace.path && normalizePathForCompare(workspace.path) === expectedPath
    );
    const workspaceId = match?.id?.trim();
    if (workspaceId) return workspaceId;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Orchestrator did not register seeded workspace. Latest=${JSON.stringify(latest)}`);
}

async function triggerEngineSpawnThroughProxy(baseUrl: string, directory: string): Promise<void> {
  const url = `${baseUrl.replace(/\/+$/, "")}/global/health?directory=${encodeURIComponent(directory)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-veslo-send-trace-id": `e2e-wsl-direct-fallback-${Date.now()}`,
      },
      body: JSON.stringify({ ok: true, directory }),
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => {});
    if (response.status >= 500) {
      throw new Error(`Proxy spawn trigger failed with ${response.status}: ${await response.text().catch(() => "")}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForDirectEngineSnapshot(baseUrl: string, workspaceId: string, timeoutMs: number): Promise<OrchestratorEngineSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let latest: OrchestratorEngineSnapshot | null = null;
  while (Date.now() < deadline) {
    const health = await fetchJson<RouterHealth>(`${baseUrl}/health`, { timeoutMs: 5_000 }).catch(() => null);
    const engines = health?.engines ?? [];
    latest = engines.find((engine) => engine.workspaceId === workspaceId) ?? latest;
    if (
      latest?.childKind === "direct" &&
      latest.baseUrl?.trim() &&
      (latest.state === "ready" || latest.state === "idle")
    ) {
      return latest;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`Engine snapshot did not report direct childKind. Workspace=${workspaceId} Latest=${JSON.stringify(latest)}`);
}

async function stopE2ESidecars(): Promise<void> {
  if (process.platform !== "win32") return;
  const marker = join(e2eRoot, ".tmp-opencode-home").replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$names = @('veslo-server.exe','veslo-orchestrator.exe','veslo-code-router.exe','veslo-code.exe')",
    `$marker = '${marker}'`,
    "Get-CimInstance Win32_Process | Where-Object { $names -contains $_.Name -and $_.CommandLine -like \"*$marker*\" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
  ].join("; ");
  await new Promise<void>((resolveCleanup) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
      { windowsHide: true },
      () => resolveCleanup(),
    );
  });
}

async function run(): Promise<void> {
  process.env.VESLO_WSL_EXE = process.env.VESLO_WSL_EXE?.trim() || "C:\\veslo-e2e-missing-wsl.exe";
  process.env.E2E_SKILL_REGISTRY_FIXTURE = "0";
  process.env.E2E_LAUNCH_TIMEOUT = process.env.E2E_LAUNCH_TIMEOUT?.trim() || "120000";
  rmSync(tracePath, { force: true });

  await startApp();
  let daemonBaseUrl: string | null = null;
  try {
    const workspacePath = defaultWorkspacePath;
    daemonBaseUrl = await waitForDaemonBaseUrl(120_000);
    const registeredWorkspaceId = await waitForRegisteredWorkspace(daemonBaseUrl, workspacePath, 60_000);
    const proxyBaseUrl = `${daemonBaseUrl}/workspace/${encodeURIComponent(registeredWorkspaceId)}/opencode`;
    await triggerEngineSpawnThroughProxy(proxyBaseUrl, workspacePath);

    const orchestratorWorkspaceId = extractWorkspaceIdFromProxyUrl(proxyBaseUrl) ?? registeredWorkspaceId;
    assert.ok(orchestratorWorkspaceId, `Could not resolve orchestrator workspace id from ${proxyBaseUrl}`);
    const engine = await waitForDirectEngineSnapshot(daemonBaseUrl, orchestratorWorkspaceId, 120_000);
    const trace = readFileSync(tracePath, "utf8");
    assert.match(trace, /"sandboxKind":"windows-wsl2"/);
    assert.match(trace, /"sandboxMode":"launch-fallback"/);
    assert.match(trace, /"configuredSandboxBackend":"windows-wsl2"/);
    assert.match(trace, /"effectiveSandboxBackend":"none"/);
    assert.match(trace, /"sandboxFallbackReason":"sandbox launch unavailable"/);
    assert.match(trace, /"childKind":"direct"/);

    console.log(`[pilot-e2e] WSL direct fallback passed: ${JSON.stringify({
      workspaceId: registeredWorkspaceId,
      orchestratorWorkspaceId,
      workspacePath,
      childKind: engine.childKind,
      baseUrl: engine.baseUrl,
    })}`);
  } finally {
    if (daemonBaseUrl) {
      await fetchJson<unknown>(`${daemonBaseUrl}/shutdown`, { method: "POST", timeoutMs: 10_000 }).catch(() => {});
    }
    await stopApp();
    await stopE2ESidecars();
  }
}

run().then(() => {
  process.exit(0);
}).catch(async (error) => {
  await stopApp().catch(() => {});
  await stopE2ESidecars().catch(() => {});
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
