import { expect } from "@wdio/globals";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";

type EngineInfo = {
  running: boolean;
  baseUrl: string | null;
  projectDir: string | null;
  opencodeUsername: string | null;
  opencodePassword: string | null;
};

type WorkspaceInfo = {
  id: string;
  path: string;
  directory?: string | null;
};

type WorkspaceList = {
  activeId: string;
  workspaces: WorkspaceInfo[];
};

type SeededSession = {
  id: string;
  title: string;
};

type ContextClickTarget = {
  x: number;
  y: number;
  targetText: string;
};

type MenuMetrics = {
  bottom: number;
  height: number;
  isTopAtBottom: boolean;
  isTopAtCenter: boolean;
  left: number;
  right: number;
  scrollContainerBottom: number | null;
  top: number;
  viewportHeight: number;
  viewportWidth: number;
  zIndex: string;
};

const WAIT_TIMEOUT_MS = 20_000;
const SIDEBAR_VIEW_MODE_KEY = "veslo.sidebar-session-view.v1";
const SESSION_ROW_SELECTOR = '[data-session-sidebar-row="true"]';
const WORKSPACE_CONTEXT_MENU_SELECTOR = '[data-testid="session-workspace-context-menu"]';

const defaultIsolatedProfileRoot = () => join(process.cwd(), ".tmp-veslo-home");
const sidebarWorkspaceRoot = () => join(defaultIsolatedProfileRoot(), "workspaces", "sidebar-context-menu-workspace");

function trimText(value: string | null | undefined) {
  return (value ?? "").trim();
}

function normalizePath(value: string | null | undefined): string {
  return trimText(value).replace(/\\/g, "/").replace(/\/+$/, "");
}

async function tauriInvoke<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  const result = await browser.executeAsync(
    (
      args: { command: string; payload: Record<string, unknown> },
      done: (value: { ok: boolean; value?: unknown; error?: string }) => void,
    ) => {
      const invoke = (
        window as typeof window & {
          __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__?.invoke;

      if (typeof invoke !== "function") {
        done({ ok: false, error: "Tauri invoke bridge is unavailable" });
        return;
      }

      invoke(args.command, args.payload).then(
        (value) => done({ ok: true, value }),
        (error) =>
          done({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    },
    { command, payload },
  ) as { ok: boolean; value?: T; error?: string };

  if (!result.ok) {
    throw new Error(`Tauri invoke failed for ${command}: ${result.error ?? "unknown error"}`);
  }

  return result.value as T;
}

async function ensureActiveEngineStarted() {
  const directory = await ensureSidebarWorkspaceActive();
  const engine = await tauriInvoke<EngineInfo>("engine_info").catch(() => null);
  if (
    engine?.running &&
    trimText(engine.baseUrl) &&
    normalizePath(engine.projectDir) === normalizePath(directory)
  ) {
    return;
  }

  await tauriInvoke<EngineInfo>("engine_start", {
    projectDir: directory,
    preferSidecar: true,
    runtime: "direct",
    workspacePaths: [directory],
  });
}

async function ensureSidebarWorkspaceActive(): Promise<string> {
  const directory = sidebarWorkspaceRoot();
  mkdirSync(directory, { recursive: true });

  const before = await tauriInvoke<WorkspaceList>("workspace_bootstrap");
  let workspace = before.workspaces.find((candidate) => normalizePath(candidate.path) === normalizePath(directory));

  if (!workspace) {
    await tauriInvoke<WorkspaceList>("workspace_create", {
      folderPath: directory,
      name: "Sidebar Context Menu Workspace",
      preset: "starter",
    });
    const afterCreate = await tauriInvoke<WorkspaceList>("workspace_bootstrap");
    workspace = afterCreate.workspaces.find((candidate) => normalizePath(candidate.path) === normalizePath(directory));
  }

  if (!workspace?.id) {
    throw new Error("Sidebar context menu workspace was not registered.");
  }

  await tauriInvoke<WorkspaceList>("workspace_set_active", {
    workspaceId: workspace.id,
    promoteToFront: true,
  });

  return directory;
}

async function readActiveClientContext() {
  const [engine, bootstrap] = await Promise.all([
    tauriInvoke<EngineInfo>("engine_info"),
    tauriInvoke<WorkspaceList>("workspace_bootstrap"),
  ]);

  const baseUrl = trimText(engine.baseUrl);
  if (!engine.running || !baseUrl) {
    throw new Error("Engine is not ready yet");
  }

  const activeWorkspace = bootstrap.workspaces.find((workspace) => workspace.id === bootstrap.activeId);
  const directory = trimText(activeWorkspace?.directory) || trimText(activeWorkspace?.path);
  if (!activeWorkspace || !directory) {
    throw new Error("Active workspace is not ready yet");
  }

  return {
    baseUrl,
    directory,
    username: trimText(engine.opencodeUsername) || undefined,
    password: trimText(engine.opencodePassword) || undefined,
  };
}

async function waitForActiveClientContext() {
  let context: Awaited<ReturnType<typeof readActiveClientContext>> | null = null;

  await browser.waitUntil(
    async () => {
      try {
        context = await readActiveClientContext();
        return true;
      } catch {
        return false;
      }
    },
    {
      timeout: WAIT_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: "Active engine + workspace context did not become ready in time",
    },
  );

  return context!;
}

async function seedSessions(count: number): Promise<SeededSession[]> {
  await ensureActiveEngineStarted();
  const { baseUrl, directory, username, password } = await waitForActiveClientContext();
  // @ts-expect-error -- shared app test utilities are JS-only in this workspace.
  const { makeClient, waitForHealthy } = await import("../../app/scripts/_util.mjs");

  const client = makeClient({
    baseUrl,
    directory,
    auth: {
      username,
      password,
    },
  });

  await waitForHealthy(client, { timeoutMs: WAIT_TIMEOUT_MS, pollMs: 250 });

  const runId = `e2e-sidebar-context-menu-${Date.now()}`;
  const seeded: SeededSession[] = [];

  for (let index = 0; index < count; index += 1) {
    const title = `${runId} row ${index + 1}`;
    const created = await client.session.create({ title, directory });
    seeded.push({ id: created.id, title });
  }

  return seeded;
}

async function ensureByProjectSidebarMode() {
  await browser.execute((key: string) => {
    localStorage.setItem(key, "by-project");
  }, SIDEBAR_VIEW_MODE_KEY);
}

async function waitForVisibleSeededTitle(expectedTitles: string[]): Promise<string> {
  let matchedTitle = "";

  await browser.waitUntil(
    async () => {
      const visibleText = await browser.execute((selector: string) =>
        Array.from(document.querySelectorAll<HTMLElement>(selector))
          .filter((row) => !row.closest('[data-sidebar-chat-section="true"]'))
          .map((row) => row.textContent?.trim() ?? "")
          .filter(Boolean)
          .join("\n"),
      SESSION_ROW_SELECTOR);
      matchedTitle = expectedTitles.find((title) => visibleText.includes(title)) ?? "";
      return Boolean(matchedTitle);
    },
    {
      timeout: WAIT_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `No seeded sidebar rows appeared: ${expectedTitles.join(", ")}`,
    },
  );

  return matchedTitle;
}

async function resolveBottomSidebarRowClickTarget(targetTitle: string): Promise<ContextClickTarget> {
  return browser.execute(
    (rowSelector: string, title: string) => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>(rowSelector));
      const target = rows.find(
        (row) => !row.closest('[data-sidebar-chat-section="true"]') && row.textContent?.includes(title),
      );
      if (!target) {
        throw new Error(`No sidebar session row is available for ${title}`);
      }

      let scrollContainer: HTMLElement | null = target.parentElement;
      while (scrollContainer) {
        const style = window.getComputedStyle(scrollContainer);
        if (/(auto|scroll)/.test(style.overflowY)) break;
        scrollContainer = scrollContainer.parentElement;
      }

      if (scrollContainer) {
        scrollContainer.style.height = "180px";
        scrollContainer.style.maxHeight = "180px";
        scrollContainer.style.overflowY = "auto";
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }

      target.scrollIntoView({ block: "end", inline: "nearest" });
      const rect = target.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        targetText: target.textContent?.trim() ?? "",
      };
    },
    SESSION_ROW_SELECTOR,
    targetTitle,
  ) as Promise<ContextClickTarget>;
}

async function rightClickBottomSidebarRow(targetTitle: string): Promise<ContextClickTarget> {
  const target = await resolveBottomSidebarRowClickTarget(targetTitle);
  await browser
    .action("pointer")
    .move({ origin: "viewport", x: target.x, y: target.y, duration: 0 })
    .down({ button: 2 })
    .up({ button: 2 })
    .perform();

  const pointerOpenedMenu = await browser.execute((menuSelector: string) => {
    const menu = document.querySelector<HTMLElement>(menuSelector);
    if (!menu) return false;
    const rect = menu.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }, WORKSPACE_CONTEXT_MENU_SELECTOR);

  if (!pointerOpenedMenu) {
    await browser.execute(
      (rowSelector: string, title: string, x: number, y: number) => {
        const rows = Array.from(document.querySelectorAll<HTMLElement>(rowSelector));
        const row = rows.find((candidate) => candidate.textContent?.includes(title));
        const host = row?.parentElement ?? row;
        if (!host) return;
        host.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: x,
            clientY: y,
            button: 2,
            buttons: 2,
          }),
        );
      },
      SESSION_ROW_SELECTOR,
      targetTitle,
      target.x,
      target.y,
    );
  }

  return target;
}

async function readWorkspaceContextMenuMetrics(): Promise<MenuMetrics> {
  return browser.execute((menuSelector: string) => {
    const menu = document.querySelector<HTMLElement>(menuSelector);
    if (!menu) {
      throw new Error("Workspace context menu is not rendered");
    }
    const rect = menu.getBoundingClientRect();
    const centerX = Math.round(rect.left + rect.width / 2);
    const centerY = Math.round(rect.top + rect.height / 2);
    const bottomY = Math.max(Math.round(rect.bottom - 2), Math.round(rect.top + 1));
    const centerElement = document.elementFromPoint(centerX, centerY);
    const bottomElement = document.elementFromPoint(centerX, bottomY);

    let scrollContainer: HTMLElement | null = null;
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-session-sidebar-row="true"]'));
    const row = rows.at(-1) ?? null;
    let candidate = row?.parentElement ?? null;
    while (candidate) {
      const style = window.getComputedStyle(candidate);
      if (/(auto|scroll)/.test(style.overflowY)) {
        scrollContainer = candidate;
        break;
      }
      candidate = candidate.parentElement;
    }

    return {
      bottom: rect.bottom,
      height: rect.height,
      isTopAtBottom: Boolean(bottomElement?.closest(menuSelector)),
      isTopAtCenter: Boolean(centerElement?.closest(menuSelector)),
      left: rect.left,
      right: rect.right,
      scrollContainerBottom: scrollContainer?.getBoundingClientRect().bottom ?? null,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      zIndex: window.getComputedStyle(menu).zIndex,
    };
  }, WORKSPACE_CONTEXT_MENU_SELECTOR) as Promise<MenuMetrics>;
}

async function waitForWorkspaceContextMenu(targetTitle: string): Promise<void> {
  try {
    await browser.waitUntil(
      async () =>
        browser.execute((menuSelector: string) => {
          const menu = document.querySelector<HTMLElement>(menuSelector);
          if (!menu) return false;
          const rect = menu.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }, WORKSPACE_CONTEXT_MENU_SELECTOR),
      {
        timeout: WAIT_TIMEOUT_MS,
        interval: 100,
        timeoutMsg: "Workspace context menu did not render with a measurable box",
      },
    );
  } catch (error) {
    const debug = await readContextMenuDebug(targetTitle);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nContext menu debug:\n${JSON.stringify(debug, null, 2)}`,
    );
  }
}

async function readContextMenuDebug(targetTitle: string) {
  return browser.execute(
    (rowSelector: string, menuSelector: string, title: string) => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>(rowSelector));
      const row = rows.find(
        (candidate) => !candidate.closest('[data-sidebar-chat-section="true"]') && candidate.textContent?.includes(title),
      );
      const host = row?.parentElement ?? null;
      const menu = document.querySelector<HTMLElement>(menuSelector);
      return {
        bodyText: document.body.innerText.slice(0, 1200),
        hostClass: host?.className ?? null,
        hostHtml: host?.outerHTML.slice(0, 1200) ?? null,
        menuHtml: menu?.outerHTML.slice(0, 1200) ?? null,
        rowClass: row?.className ?? null,
        rowHtml: row?.outerHTML.slice(0, 1200) ?? null,
        rowInChatSection: Boolean(row?.closest('[data-sidebar-chat-section="true"]')),
        rowText: row?.textContent?.trim() ?? null,
        totalRows: rows.length,
      };
    },
    SESSION_ROW_SELECTOR,
    WORKSPACE_CONTEXT_MENU_SELECTOR,
    targetTitle,
  );
}

describe("Session sidebar context menu", () => {
  it("keeps right-click workspace actions visible above the scrolled left menu", async () => {
    const seeded = await seedSessions(12);

    await navigateToHash("/session");
    await waitForHashRoute("#/session", WAIT_TIMEOUT_MS);
    await ensureByProjectSidebarMode();
    await browser.refresh();
    await waitForHashRoute("#/session", WAIT_TIMEOUT_MS);
    const visibleTitle = await waitForVisibleSeededTitle(seeded.map((session) => session.title));

    await rightClickBottomSidebarRow(visibleTitle);

    await waitForWorkspaceContextMenu(visibleTitle);

    const metrics = await readWorkspaceContextMenuMetrics();

    expect(metrics.zIndex).toBe("100");
    expect(metrics.left).toBeGreaterThanOrEqual(12);
    expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth - 12);
    expect(metrics.top).toBeGreaterThanOrEqual(12);
    expect(metrics.bottom).toBeLessThanOrEqual(metrics.viewportHeight - 12);
    expect(metrics.isTopAtCenter).toBe(true);
    expect(metrics.isTopAtBottom).toBe(true);
    expect(metrics.scrollContainerBottom).not.toBeNull();
  });
});
