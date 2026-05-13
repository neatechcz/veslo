import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "@wdio/globals";

import { currentHashRoute, navigateToHash } from "../helpers/app-launcher.js";

type WorkspaceInfo = {
  id: string;
  name: string;
  path: string;
  directory?: string | null;
  displayName?: string | null;
  vesloWorkspaceName?: string | null;
  workspaceType: "local" | "remote";
  remoteType?: "veslo" | "opencode" | null;
  baseUrl?: string | null;
};

type WorkspaceList = {
  activeId: string;
  workspaces: WorkspaceInfo[];
};

type EngineInfo = {
  running: boolean;
  baseUrl: string | null;
  opencodeUsername: string | null;
  opencodePassword: string | null;
};

type SessionRecord = {
  id: string;
  title: string;
  parentID?: string | null;
};

type SidebarRow = {
  title: string;
  meta: string;
};

type CandidateSession = {
  row: SidebarRow;
  workspace: WorkspaceInfo;
  session: SessionRecord;
};

const SIDEBAR_VIEW_MODE_KEY = "veslo.sidebar-session-view.v1";
const SESSION_ROW_SELECTOR = '[data-session-sidebar-row="true"]';
const USE_REAL_PROFILE = process.env.E2E_USE_EXISTING_PROFILE?.trim() === "1";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EVIDENCE_DIR = resolve(
  process.env.E2E_SESSION_PREFETCH_EVIDENCE_DIR?.trim() || resolve(__dirname, "..", ".tmp-session-prefetch-evidence"),
);
const EVIDENCE_PATH = `${EVIDENCE_DIR}/real-profile-cross-workspace-prefetch.png`;
const OVERLAY_SELECTOR = 'div[class*="z-[60]"][class*="overflow-hidden"][class*="bg-gray-1/90"]';

function normalizeText(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function workspaceLabels(workspace: WorkspaceInfo) {
  const labels = new Set<string>();
  const push = (value: string | null | undefined) => {
    const normalized = normalizeText(value);
    if (normalized) labels.add(normalized);
  };

  push(workspace.displayName);
  push(workspace.vesloWorkspaceName);
  push(workspace.name);
  push(workspace.directory);
  push(workspace.path.split("/").filter(Boolean).at(-1) ?? "");

  return Array.from(labels);
}

function isSyntheticWorkspace(workspace: WorkspaceInfo) {
  const haystack = [
    workspace.name,
    workspace.displayName,
    workspace.path,
    workspace.directory,
  ]
    .map((value) => normalizeText(value))
    .join(" ");

  return (
    haystack.includes("E2E Session Prefetch Workspace") ||
    haystack.includes("veslo-session-prefetch-") ||
    haystack.includes("veslo-e2e-cross-ws-")
  );
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

  if (!result?.ok) {
    throw new Error(result?.error ?? `Tauri command failed: ${command}`);
  }
  return result.value as T;
}

function buildBasicAuthHeader(engine: EngineInfo): string | null {
  const username = engine.opencodeUsername?.trim() ?? "";
  const password = engine.opencodePassword?.trim() ?? "";
  if (!username || !password) return null;
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

async function assertOkJson<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${label} failed (${response.status}): ${text}`);
  }
  return response.json() as Promise<T>;
}

async function listWorkspaceSessions(workspace: WorkspaceInfo, engine: EngineInfo): Promise<SessionRecord[]> {
  const baseUrl =
    workspace.workspaceType === "remote"
      ? workspace.baseUrl?.trim() ?? ""
      : engine.baseUrl?.trim() ?? "";
  const queryDirectory = workspace.directory?.trim() || workspace.path?.trim() || "";
  if (!baseUrl || !queryDirectory) return [];

  const headers: Record<string, string> = {};
  const authHeader = buildBasicAuthHeader(engine);
  if (authHeader && workspace.workspaceType === "local") {
    headers.Authorization = authHeader;
  }

  const response = await fetch(
    `${baseUrl}/session?directory=${encodeURIComponent(queryDirectory)}`,
    Object.keys(headers).length > 0 ? { headers } : undefined,
  );

  const sessions = await assertOkJson<SessionRecord[]>(response, `session.list ${workspace.name}`);
  return Array.isArray(sessions) ? sessions : [];
}

async function visibleSidebarRows(): Promise<SidebarRow[]> {
  return browser.execute(
    (selector: string) =>
      Array.from(document.querySelectorAll(selector))
        .map((row) => {
          const title = row.querySelector("span.text-\\[13px\\]");
          const meta = row.querySelector(".mt-px");
          return {
            title: (title?.textContent ?? "").replace(/\s+/g, " ").trim(),
            meta: (meta?.textContent ?? "").replace(/\s+/g, " ").trim(),
          };
        })
        .filter((row) => row.title.length > 0),
    SESSION_ROW_SELECTOR,
  ) as Promise<SidebarRow[]>;
}

async function waitForSidebarRows() {
  await browser.waitUntil(async () => (await visibleSidebarRows()).length > 1, {
    timeout: 20_000,
    timeoutMsg: "Sidebar session rows did not load in time",
  });
}

async function waitForStableSidebarRows() {
  let lastSerialized = "";
  let stableSince = 0;
  let stableRows: SidebarRow[] = [];

  await browser.waitUntil(
    async () => {
      const rows = await visibleSidebarRows();
      const serialized = JSON.stringify(rows);
      const now = Date.now();

      if (rows.length <= 1) {
        lastSerialized = serialized;
        stableSince = 0;
        return false;
      }

      if (serialized !== lastSerialized) {
        lastSerialized = serialized;
        stableSince = now;
        stableRows = rows;
        return false;
      }

      stableRows = rows;
      return stableSince > 0 && now - stableSince >= 1_000;
    },
    {
      timeout: 20_000,
      interval: 250,
      timeoutMsg: "Sidebar session rows did not stabilize in time",
    },
  );

  return stableRows;
}

async function ensureRecentSidebarMode() {
  await browser.execute((key: string) => {
    localStorage.setItem(key, "recent");
  }, SIDEBAR_VIEW_MODE_KEY);
  await browser.refresh();

  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const button = document.querySelector('button[data-tooltip="Nedávné"]');
        return button?.getAttribute("aria-pressed") === "true";
      }),
    {
      timeout: 20_000,
      timeoutMsg: "Recent sidebar mode did not become active",
    },
  );
}

async function findCandidateSession(
  bootstrap: WorkspaceList,
  engine: EngineInfo,
  visibleRows: SidebarRow[],
): Promise<CandidateSession> {
  const workspaces = bootstrap.workspaces.filter((workspace) => !isSyntheticWorkspace(workspace));
  const workspaceIdsByLabel = new Map<string, string[]>();
  const workspacesById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const sessionsByWorkspace = new Map<string, SessionRecord[]>();

  for (const workspace of workspaces) {
    for (const label of workspaceLabels(workspace)) {
      const ids = workspaceIdsByLabel.get(label) ?? [];
      ids.push(workspace.id);
      workspaceIdsByLabel.set(label, ids);
    }
  }

  for (const row of visibleRows) {
    if (!row.meta) continue;

    const workspaceIds = workspaceIdsByLabel.get(row.meta) ?? [];
    if (workspaceIds.length !== 1) continue;

    const workspace = workspacesById.get(workspaceIds[0] ?? "");
    if (!workspace || workspace.id === bootstrap.activeId) continue;

    const existingSessions = sessionsByWorkspace.get(workspace.id);
    const sessions = existingSessions ?? await listWorkspaceSessions(workspace, engine);
    sessionsByWorkspace.set(workspace.id, sessions);

    const matches = sessions.filter(
      (session) =>
        normalizeText(session.title) === row.title &&
        !normalizeText(session.parentID),
    );

    if (matches.length !== 1) continue;

    return {
      row,
      workspace,
      session: matches[0]!,
    };
  }

  throw new Error(
    "Could not find a uniquely mappable visible session row in a non-active real workspace. " +
      "The sidebar needs at least one visible row whose workspace label is unique and whose title maps to one top-level session.",
  );
}

async function clickSidebarRow(row: SidebarRow) {
  const result = await browser.execute(
    ({ title, meta, selector }: SidebarRow & { selector: string }) => {
      const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
      const rows = Array.from(document.querySelectorAll(selector)).map((entry) => ({
        entry,
        title: normalize(entry.querySelector("span.text-\\[13px\\]")?.textContent),
        meta: normalize(entry.querySelector(".mt-px")?.textContent),
      }));

      const exact = rows.find((candidate) => candidate.title === title && candidate.meta === meta);
      const uniqueTitle = rows.filter((candidate) => candidate.title === title);
      const relaxed = rows.find((candidate) =>
        candidate.title === title &&
        (candidate.meta.includes(meta) || meta.includes(candidate.meta)),
      );
      const target = exact ?? (uniqueTitle.length === 1 ? uniqueTitle[0] : null) ?? relaxed ?? null;
      const strategy =
        target === exact ? "exact" : target === uniqueTitle[0] && uniqueTitle.length === 1 ? "uniqueTitle" : target === relaxed ? "relaxed" : null;

      if (!(target?.entry instanceof HTMLElement)) {
        return {
          clicked: false,
          strategy,
          availableRows: rows.map(({ title, meta }) => ({ title, meta })),
        };
      }

      target.entry.scrollIntoView({ block: "center" });
      target.entry.click();

      return {
        clicked: true,
        strategy,
        availableRows: rows.map(({ title, meta }) => ({ title, meta })),
      };
    },
    { ...row, selector: SESSION_ROW_SELECTOR },
  ) as {
    clicked: boolean;
    strategy: string | null;
    availableRows: SidebarRow[];
  };

  if (!result.clicked) {
    throw new Error(
      `Failed to click sidebar row ${JSON.stringify(row)}. Visible rows at click time: ${JSON.stringify(result.availableRows)}`,
    );
  }
}

async function startOverlayObserver() {
  await browser.execute((selector: string) => {
    const state = window as typeof window & {
      __vesloE2eOverlaySeen?: boolean;
      __vesloE2eOverlayObserver?: MutationObserver;
    };

    state.__vesloE2eOverlaySeen = false;
    state.__vesloE2eOverlayObserver?.disconnect();

    const markSeen = () => {
      if (document.querySelector(selector)) {
        state.__vesloE2eOverlaySeen = true;
      }
    };

    markSeen();

    const observer = new MutationObserver(() => {
      markSeen();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });

    state.__vesloE2eOverlayObserver = observer;
  }, OVERLAY_SELECTOR);
}

async function readOverlaySeen() {
  return browser.execute(() => {
    const state = window as typeof window & { __vesloE2eOverlaySeen?: boolean };
    return Boolean(state.__vesloE2eOverlaySeen);
  });
}

async function stopOverlayObserver() {
  await browser.execute(() => {
    const state = window as typeof window & {
      __vesloE2eOverlaySeen?: boolean;
      __vesloE2eOverlayObserver?: MutationObserver;
    };
    state.__vesloE2eOverlayObserver?.disconnect();
    delete state.__vesloE2eOverlayObserver;
  });
}

const describeRealProfile = USE_REAL_PROFILE ? describe : describe.skip;

describeRealProfile("Cross-workspace sidebar session prefetch", () => {
  it("opens a visible real-data session from another workspace without the fullscreen switch overlay", async () => {
    await navigateToHash("/session");
    const root = await $("#root");
    await root.waitForExist({ timeout: 20_000 });

    await ensureRecentSidebarMode();
    await waitForSidebarRows();
    await waitForStableSidebarRows();

    const bootstrap = await tauriInvoke<WorkspaceList>("workspace_bootstrap");
    const engine = await tauriInvoke<EngineInfo>("engine_info");

    expect(engine.running).toBe(true);
    expect(Boolean(engine.baseUrl?.trim())).toBe(true);

    let candidate: CandidateSession | null = null;
    await browser.pause(2_500);
    await browser.waitUntil(
      async () => {
        try {
          const stableRows = await waitForStableSidebarRows();
          candidate = await findCandidateSession(bootstrap, engine, stableRows);
          return true;
        } catch {
          return false;
        }
      },
      {
        timeout: 20_000,
        timeoutMsg: "Could not find a stable cross-workspace candidate session in the visible sidebar rows",
      },
    );

    expect(candidate).not.toBeNull();

    await startOverlayObserver();
    try {
      await clickSidebarRow(candidate!.row);

      await browser.waitUntil(
        async () => (await currentHashRoute()).includes(candidate!.session.id),
        {
          timeout: 20_000,
          timeoutMsg: `Route did not change to the selected session ${candidate!.session.id}`,
        },
      );

      await browser.pause(1_000);
      expect(await readOverlaySeen()).toBe(false);
    } finally {
      await stopOverlayObserver();
    }

    await mkdir(EVIDENCE_DIR, { recursive: true });
    await browser.saveScreenshot(EVIDENCE_PATH);
  });
});
