import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import {
  resolvePilotRuntimeDir,
  resolvePilotSocketPath,
  startApp,
  stopApp,
} from "../helpers/app-launcher.js";

const LABELS = {
  editName: "Edit name",
  archiveSession: "Archive session",
  removeWorkspace: "Remove from Veslo",
  addDirectoryOrProject: "Add directory / project",
  archivedItems: "Archived items",
  searchSessions: "Search sessions",
  deleteSession: "Delete session",
  soulSettings: "Soul settings",
  copy: "Copy",
};

const SESSION_MENU_TESTID = "sidebar-context-menu";
const PROJECT_MENU_TESTID = "session-workspace-context-menu";

const pilotCommand = process.env.E2E_TAURI_PILOT_BIN?.trim() || "tauri-pilot";
const pilotSocketPath = resolvePilotSocketPath({ runtimeDir: resolvePilotRuntimeDir() });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runProcess(
  command: string,
  args: string[],
  options: { input?: string; timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return await new Promise<string>((resolveResult, rejectResult) => {
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
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectResult(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms\n${stderr}`));
    }, timeoutMs);
    child.stdout?.on("data", (data: Buffer) => (stdout += data.toString("utf8")));
    child.stderr?.on("data", (data: Buffer) => (stderr += data.toString("utf8")));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectResult(error);
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolveResult(stdout);
      else rejectResult(new Error(`${command} ${args.join(" ")} failed with ${signal ?? code}\n${stderr}\n${stdout}`));
    });
    child.stdin?.end(options.input ?? "");
  });
}

async function pilotEval<T>(script: string, timeoutMs?: number): Promise<T> {
  // The eval executor rejects top-level `return`/`await` but resolves a bare
  // promise-valued final expression (pattern proven by core-platform-skills
  // .pilot.ts). Scripts may use `return`/`await` inside the IIFE.
  const wrapped = `(async () => { ${script} })()`;
  const raw = (await runProcess(pilotCommand, ["--json", "eval", "-"], { input: wrapped, timeoutMs })).trim();
  return (raw ? JSON.parse(raw) : undefined) as T;
}

/** Retry pilotEval from the host; survives transient RPC drops (e.g. webview reload). */
async function pilotEvalRetry<T>(script: string, options: { timeoutMs?: number; budgetMs?: number; intervalMs?: number } = {}): Promise<T> {
  const budgetMs = options.budgetMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const deadline = Date.now() + budgetMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await pilotEval<T>(script, options.timeoutMs);
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }
  throw new Error(`pilotEval kept failing for ${budgetMs}ms. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function hostPoll<T>(label: string, budgetMs: number, intervalMs: number, probe: () => Promise<T | null | false | undefined>): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let latest: unknown = null;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result) return result;
      latest = result;
    } catch (error) {
      latest = error instanceof Error ? error.message : String(error);
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} did not succeed within ${budgetMs}ms. Latest=${JSON.stringify(latest)}`);
}

// Shared in-page prelude prepended to UI evals. Keeps every eval self-contained
// (no window state), so webview reloads between evals are harmless.
const PRELUDE = `
const normalize = (value) => String(value ?? "").trim().replace(/\\s+/g, " ");
const isVisible = (el) => {
  if (!(el instanceof HTMLElement)) return false;
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
};
const rows = () => Array.from(document.querySelectorAll('[data-session-sidebar-row="true"]')).filter(isVisible);
const rowTexts = () => rows().map((row) => normalize(row.textContent));
const rowByText = (text) => rows().find((row) => normalize(row.textContent).includes(text)) ?? null;
const menuEl = (testId) => document.querySelector('[data-testid="' + testId + '"]');
const menuItemTexts = (testId) => {
  const menu = menuEl(testId);
  if (!menu) return null;
  return Array.from(menu.querySelectorAll('[role="menuitem"]')).filter(isVisible).map((item) => normalize(item.textContent));
};
const pointIn = (el) => {
  const rect = el.getBoundingClientRect();
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + Math.min(rect.height / 2, 20)) };
};
const rightClick = (el, point = pointIn(el)) => {
  el.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, composed: true, view: window,
    button: 2, buttons: 2, clientX: point.x, clientY: point.y,
  }));
};
const pressEscape = () => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
};
const clickMenuItem = (testId, label) => {
  const menu = menuEl(testId);
  if (!menu) return false;
  const item = Array.from(menu.querySelectorAll('[role="menuitem"]')).find((el) => normalize(el.textContent) === label);
  if (!item) return false;
  item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view: window, button: 0 }));
  return true;
};
const waitFor = async (predicate, timeout = 5000, interval = 100) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return null;
};
`;

type ServerInfo = { baseUrl: string; clientToken: string };
type WorkspacePick = { id: string; path: string; active: boolean };

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function run(): Promise<void> {
  // The dev-autostart orchestrator boot races the UI's boot-warmup engine_start
  // and can deadlock the main thread on the env_guard mutex (see task chip
  // "Fix env_guard deadlock wedging app boot"). Single-actor boot avoids the race.
  process.env.VESLO_DISABLE_DEV_AUTOSTART = "1";
  await startApp();
  try {
    // ── Boot: veslo server reachable from the host ────────────────────────────
    let readinessProbeCount = 0;
    const server = await hostPoll<ServerInfo>("Veslo server readiness", 120_000, 1_000, async () => {
      const info = await pilotEval<{ running?: boolean; baseUrl?: string; clientToken?: string; lastStderr?: string | null; lastStdout?: string | null }>(
        `return await window.__TAURI_INTERNALS__.invoke("veslo_server_info");`,
      ).catch((error) => {
        if (readinessProbeCount % 10 === 0) console.error(`[pilot-e2e] server_info eval error: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
        return null;
      });
      if (readinessProbeCount % 10 === 0) {
        console.error(`[pilot-e2e] server_info attempt ${readinessProbeCount}: running=${info?.running} baseUrl=${info?.baseUrl} stderr=${JSON.stringify(info?.lastStderr)?.slice(0, 400)} stdout=${JSON.stringify(info?.lastStdout)?.slice(0, 200)}`);
      }
      readinessProbeCount += 1;
      const baseUrl = info?.baseUrl?.trim().replace(/\/+$/, "");
      const clientToken = info?.clientToken?.trim();
      if (!info?.running || !baseUrl || !clientToken) return null;
      const health = await fetchWithTimeout(`${baseUrl}/health`, {}, 5_000).catch(() => null);
      if (!health?.ok) return null;
      return { baseUrl, clientToken };
    });
    console.log(`[pilot-e2e] Veslo server ready at ${server.baseUrl}`);

    // ── Pick a non-private project workspace ─────────────────────────────────
    const workspace = await hostPoll<WorkspacePick>("Project workspace from bootstrap", 45_000, 1_000, async () => {
      const bootstrap = await pilotEval<{ activeId?: string; workspaces?: Array<{ id?: string; path?: string; directory?: string }> }>(
        `return await window.__TAURI_INTERNALS__.invoke("workspace_bootstrap");`,
      ).catch(() => null);
      const workspaces = bootstrap?.workspaces ?? [];
      const candidates = workspaces
        .map((entry) => ({
          id: entry.id?.trim() ?? "",
          path: (entry.path ?? entry.directory ?? "").trim(),
          active: entry.id === bootstrap?.activeId,
        }))
        .filter((entry) => entry.id && entry.path && !entry.path.includes("/private-workspaces/"));
      return candidates.find((entry) => entry.active) ?? candidates[0] ?? null;
    });
    console.log(`[pilot-e2e] Using workspace ${workspace.id} (${workspace.path})`);
    if (!workspace.active) {
      await pilotEval(
        `return await window.__TAURI_INTERNALS__.invoke("workspace_set_active", { workspaceId: ${JSON.stringify(workspace.id)}, promoteToFront: true });`,
      );
    }

    // ── Seed one conversation via the Veslo server API (host-side retry) ─────
    // The UI's boot-warmup starts the workspace engine on its own; the retry on
    // opencode_unconfigured / opencode_request_failed below absorbs the warmup.
    // The UI restarts the veslo server during boot (veslo_server_restart), which
    // changes its port — re-resolve base URL and token on every attempt.
    const freshServerInfo = async (): Promise<ServerInfo | null> => {
      const info = await pilotEval<{ running?: boolean; baseUrl?: string; clientToken?: string }>(
        `return await window.__TAURI_INTERNALS__.invoke("veslo_server_info");`,
      ).catch(() => null);
      const baseUrl = info?.baseUrl?.trim().replace(/\/+$/, "");
      const clientToken = info?.clientToken?.trim();
      return info?.running && baseUrl && clientToken ? { baseUrl, clientToken } : null;
    };
    const title = `Sidebar context menu ${Date.now()}`;
    let lastCreateResult = "";
    await hostPoll("Conversation create", 150_000, 2_000, async () => {
      const current = await freshServerInfo();
      if (!current) {
        lastCreateResult = "server info unavailable";
        return null;
      }
      const response = await fetchWithTimeout(
        `${current.baseUrl}/workspace/${encodeURIComponent(workspace.id)}/conversations`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${current.clientToken}`, "content-type": "application/json" },
          body: JSON.stringify({ title }),
        },
        8_000,
      ).catch((error) => {
        lastCreateResult = `fetch error: ${error instanceof Error ? error.message : String(error)}`;
        return null;
      });
      if (!response) return null;
      const body = await response.text();
      lastCreateResult = `${response.status}: ${body.slice(0, 400)}`;
      if (response.status === 201) return body || "{}";
      // Engine registration/spawn lags server readiness shortly after boot.
      if (body.includes("opencode_unconfigured") || body.includes("opencode_request_failed")) return null;
      throw new Error(`Conversation create failed ${lastCreateResult}`);
    }).catch(async (error) => {
      const latestInfo = await freshServerInfo();
      const diagnosticServer = latestInfo ?? server;
      const serverWorkspaces = await fetchWithTimeout(`${diagnosticServer.baseUrl}/workspaces`, {
        headers: { Authorization: `Bearer ${diagnosticServer.clientToken}` },
      }, 5_000).then((r) => r.text()).catch((e) => `unavailable: ${e}`);
      console.error(`[pilot-e2e] Last create result: ${lastCreateResult}`);
      console.error(`[pilot-e2e] Server /workspaces: ${serverWorkspaces.slice(0, 1500)}`);
      throw error;
    });
    console.log(`[pilot-e2e] Seeded conversation "${title}"`);

    // ── Configure sidebar prefs and reload for a clean render ────────────────
    await pilotEval(`
      window.localStorage.setItem("veslo.language", "en");
      window.localStorage.setItem("veslo.sidebar-session-view.v1", "by-project");
      window.localStorage.removeItem("veslo.sidebar-collapsed-projects.v1");
      window.localStorage.removeItem("veslo.sidebar-chat-collapsed.v1");
      setTimeout(() => window.location.reload(), 50);
      return true;
    `);
    await sleep(1_500);

    // ── Seeded row renders in the project view ───────────────────────────────
    await hostPoll("Seeded sidebar row", 90_000, 1_000, async () => {
      return await pilotEvalRetry<boolean>(
        `${PRELUDE} return Boolean(rowByText(${JSON.stringify(title)}));`,
        { budgetMs: 5_000, intervalMs: 500 },
      ).catch(() => false);
    });
    console.log("[pilot-e2e] Seeded row is visible");

    // ── 1. Session row right-click: session actions, no Open, no Remove ──────
    const sessionMenuItems = await pilotEval<string[] | null>(`${PRELUDE}
      const row = rowByText(${JSON.stringify(title)});
      if (!row) throw new Error("Seeded row disappeared. Rows=" + JSON.stringify(rowTexts()));
      rightClick(row);
      await waitFor(() => menuEl(${JSON.stringify(SESSION_MENU_TESTID)}));
      return menuItemTexts(${JSON.stringify(SESSION_MENU_TESTID)});
    `);
    assert.ok(sessionMenuItems, "Session row context menu did not open");
    assert.ok(sessionMenuItems.includes(LABELS.editName), `Rename missing: ${JSON.stringify(sessionMenuItems)}`);
    assert.ok(sessionMenuItems.includes(LABELS.archiveSession), `Archive missing: ${JSON.stringify(sessionMenuItems)}`);
    assert.ok(sessionMenuItems.includes(LABELS.deleteSession), `Delete missing: ${JSON.stringify(sessionMenuItems)}`);
    assert.ok(sessionMenuItems.includes(LABELS.soulSettings), `Project group Soul missing: ${JSON.stringify(sessionMenuItems)}`);
    assert.ok(!sessionMenuItems.some((item) => /^open$/i.test(item)), `Unexpected Open item: ${JSON.stringify(sessionMenuItems)}`);
    assert.ok(!sessionMenuItems.includes(LABELS.removeWorkspace), `Remove workspace leaked into session menu: ${JSON.stringify(sessionMenuItems)}`);
    console.log("[pilot-e2e] Session row menu contents OK");

    // ── 2. Escape closes the menu ─────────────────────────────────────────────
    const closedAfterEscape = await pilotEval<boolean>(`${PRELUDE}
      pressEscape();
      const gone = await waitFor(() => !menuEl(${JSON.stringify(SESSION_MENU_TESTID)}) ? true : null, 3000);
      return Boolean(gone);
    `);
    assert.ok(closedAfterEscape, "Escape did not close the session row menu");
    console.log("[pilot-e2e] Escape closes menu OK");

    // ── 3. Project header right-click: workspace menu incl. Remove ───────────
    const projectMenuItems = await pilotEval<string[] | null>(`${PRELUDE}
      const row = rowByText(${JSON.stringify(title)});
      const container = row?.closest("[data-project-key]");
      const header = container?.querySelector('[data-sidebar-project-toggle], button[aria-label^="Open project"]');
      if (!header) throw new Error("Project header element not found for seeded row");
      rightClick(header);
      await waitFor(() => menuEl(${JSON.stringify(PROJECT_MENU_TESTID)}));
      const items = menuItemTexts(${JSON.stringify(PROJECT_MENU_TESTID)});
      pressEscape();
      return items;
    `);
    assert.ok(projectMenuItems, "Project header context menu did not open");
    assert.ok(projectMenuItems.includes(LABELS.removeWorkspace), `Remove workspace missing: ${JSON.stringify(projectMenuItems)}`);
    assert.ok(projectMenuItems.includes(LABELS.editName), `Project rename missing: ${JSON.stringify(projectMenuItems)}`);
    console.log("[pilot-e2e] Project header menu contents OK");

    // ── 4. Background right-click: exactly the three list actions ────────────
    const backgroundMenuItems = await pilotEval<string[] | null>(`${PRELUDE}
      const container = document.querySelector('[data-testid="sidebar-session-list-scroll"]');
      if (!container) throw new Error("Sidebar scroll container not found");
      const rect = container.getBoundingClientRect();
      rightClick(container, { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.bottom - 6) });
      await waitFor(() => menuEl(${JSON.stringify(SESSION_MENU_TESTID)}));
      const items = menuItemTexts(${JSON.stringify(SESSION_MENU_TESTID)});
      pressEscape();
      return items;
    `);
    assert.ok(backgroundMenuItems, "Background context menu did not open");
    assert.deepEqual(
      backgroundMenuItems,
      [LABELS.addDirectoryOrProject, LABELS.searchSessions, LABELS.archivedItems],
      `Background menu items mismatch: ${JSON.stringify(backgroundMenuItems)}`,
    );
    console.log("[pilot-e2e] Background menu contents OK");

    // ── 5. Selected text inside the row prepends Copy ────────────────────────
    const copyFirstItem = await pilotEval<string | null>(`${PRELUDE}
      const row = rowByText(${JSON.stringify(title)});
      if (!row) throw new Error("Seeded row disappeared before copy check");
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.selectAllChildren(row);
      rightClick(row);
      await waitFor(() => menuEl(${JSON.stringify(SESSION_MENU_TESTID)}));
      const items = menuItemTexts(${JSON.stringify(SESSION_MENU_TESTID)});
      pressEscape();
      selection.removeAllRanges();
      return items?.[0] ?? null;
    `);
    assert.equal(copyFirstItem, LABELS.copy, `First item with selection should be Copy, got: ${JSON.stringify(copyFirstItem)}`);
    console.log("[pilot-e2e] Copy item on selection OK");

    // ── 6. Archive from the menu removes the row ─────────────────────────────
    const archived = await pilotEval<{ before: number; clicked: boolean; goneAfter: boolean }>(`${PRELUDE}
      const row = rowByText(${JSON.stringify(title)});
      if (!row) throw new Error("Seeded row disappeared before archive check");
      const before = rows().length;
      rightClick(row);
      await waitFor(() => menuEl(${JSON.stringify(SESSION_MENU_TESTID)}));
      const clicked = clickMenuItem(${JSON.stringify(SESSION_MENU_TESTID)}, ${JSON.stringify(LABELS.archiveSession)});
      const goneAfter = Boolean(await waitFor(() => rowByText(${JSON.stringify(title)}) ? null : true, 7000, 250));
      return { before, clicked, goneAfter };
    `, 15_000);
    assert.ok(archived.clicked, "Archive menu item was not found/clicked");
    assert.ok(archived.goneAfter, "Archived row stayed visible in the sidebar");
    console.log("[pilot-e2e] Archive via menu OK");

    console.log("[pilot-e2e] sidebar-context-menu passed");
  } finally {
    await stopApp();
  }
}

run().then(() => {
  process.exit(0);
}).catch(async (error) => {
  await stopApp().catch(() => {});
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
