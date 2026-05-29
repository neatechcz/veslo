import { expect } from "@wdio/globals";

import { navigateToHash } from "../helpers/app-launcher.js";

type EngineInfo = {
  running: boolean;
  baseUrl: string | null;
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

const SIDEBAR_VIEW_MODE_KEY = "veslo.sidebar-session-view.v1";
const WAIT_TIMEOUT_MS = 30_000;
const SESSION_ROW_SELECTOR = '[data-session-sidebar-row="true"]';
const ARCHIVE_SESSION_LABELS = ["Archive session", "Archivovat relaci"];
const ARCHIVE_CONFIRM_LABELS = ["Confirm", "Potvrdit", "确认"];

function trimText(value: string | null | undefined) {
  return (value ?? "").trim();
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
  const engine = await tauriInvoke<EngineInfo>("engine_info").catch(() => null);
  if (engine?.running && trimText(engine.baseUrl)) return;

  const bootstrap = await tauriInvoke<WorkspaceList>("workspace_bootstrap");
  const activeWorkspace = bootstrap.workspaces.find((workspace) => workspace.id === bootstrap.activeId);
  const directory = trimText(activeWorkspace?.directory) || trimText(activeWorkspace?.path);
  if (!activeWorkspace || !directory) {
    throw new Error("Active workspace is not ready yet");
  }

  await tauriInvoke<EngineInfo>("engine_start", {
    projectDir: directory,
    preferSidecar: true,
    runtime: "direct",
    workspacePaths: [directory],
  });
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
    workspaceLabel: directory.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "Workspace",
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

async function seedSession() {
  await ensureActiveEngineStarted();
  const { baseUrl, directory, username, password, workspaceLabel } = await waitForActiveClientContext();
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

  const runId = `e2e-archive-last-${Date.now()}`;
  const title = `${runId} only visible row`;
  const prompt = `${runId} prompt`;
  const created = await client.session.create({ title, directory });

  await client.session.prompt({
    sessionID: created.id,
    noReply: true,
    parts: [{ type: "text", text: prompt }],
  });

  return { id: created.id, title, workspaceLabel };
}

async function ensureRecentSidebarMode() {
  await browser.execute((key: string) => {
    localStorage.setItem(key, "recent");
  }, SIDEBAR_VIEW_MODE_KEY);
}

async function waitForAppReady() {
  const root = await $("#root");
  await root.waitForExist({ timeout: WAIT_TIMEOUT_MS });

  await browser.waitUntil(
    async () =>
      browser.execute(() => document.readyState === "complete" || document.readyState === "interactive"),
    {
      timeout: WAIT_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: "App document did not become ready in time",
    },
  );
}

async function readVisibleSessionTitles() {
  return browser.execute((selector: string) => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll(selector))
      .map((row) => normalize(row.querySelector("span.text-\\[13px\\]")?.textContent))
      .filter(Boolean);
  }, SESSION_ROW_SELECTOR) as Promise<string[]>;
}

async function waitForSessionRow(title: string) {
  await browser.waitUntil(
    async () => (await readVisibleSessionTitles()).includes(title),
    {
      timeout: WAIT_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `Sidebar session row "${title}" did not appear`,
    },
  );
}

async function clickArchiveActionForRow(title: string, expectedLabels: string[]) {
  await browser.execute(
    ({ targetTitle, labels, selector }: { targetTitle: string; labels: string[]; selector: string }) => {
      const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
      const row = Array.from(document.querySelectorAll(selector)).find(
        (candidate) => normalize(candidate.querySelector("span.text-\\[13px\\]")?.textContent) === targetTitle,
      );

      const container = row?.parentElement;
      const buttons = Array.from(container?.querySelectorAll<HTMLButtonElement>("button[aria-label]") ?? []);
      const button = buttons.find((candidate) => labels.includes(normalize(candidate.getAttribute("aria-label"))));
      if (!button) {
        const availableLabels = buttons.map((candidate) => normalize(candidate.getAttribute("aria-label"))).join(", ");
        throw new Error(
          `Archive action "${labels.join('" or "')}" was not found for row "${targetTitle}". Available labels: ${
            availableLabels || "(none)"
          }`,
        );
      }
      button.click();
    },
    { targetTitle: title, labels: expectedLabels, selector: SESSION_ROW_SELECTOR },
  );
}

async function archiveSessionThroughSidebar(title: string) {
  await clickArchiveActionForRow(title, ARCHIVE_SESSION_LABELS);

  await browser.waitUntil(
    async () => {
      try {
        await clickArchiveActionForRow(title, ARCHIVE_CONFIRM_LABELS);
        return true;
      } catch {
        return false;
      }
    },
    {
      timeout: 5_000,
      interval: 250,
      timeoutMsg: `Archive confirm action did not appear for row "${title}"`,
    },
  );
}

async function waitForNoSessionRows() {
  await browser.waitUntil(
    async () => (await readVisibleSessionTitles()).length === 0,
    {
      timeout: WAIT_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: "Archived session rows remained visible in the sidebar",
    },
  );
}

async function readVisibleProjectLabels() {
  return browser.execute(() => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const labels = new Set<string>();
    for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>("button"))) {
      const label = normalize(button.getAttribute("aria-label"));
      if (label.startsWith("Open project ")) {
        labels.add(label.replace(/^Open project\s+/, ""));
      }
    }
    return Array.from(labels);
  }) as Promise<string[]>;
}

describe("Sidebar archive recovery", () => {
  it("keeps a local workspace visible in Recent mode after archiving its last session", async () => {
    await waitForAppReady();
    const seeded = await seedSession();

    await ensureRecentSidebarMode();
    await navigateToHash("/session");
    await browser.refresh();
    await waitForAppReady();

    await waitForSessionRow(seeded.title);
    await archiveSessionThroughSidebar(seeded.title);
    await waitForNoSessionRows();

    await browser.waitUntil(
      async () => (await readVisibleProjectLabels()).includes(seeded.workspaceLabel),
      {
        timeout: WAIT_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: `Workspace "${seeded.workspaceLabel}" disappeared after archiving the last session`,
      },
    );

    expect(await readVisibleProjectLabels()).toContain(seeded.workspaceLabel);
  });
});
