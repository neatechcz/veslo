import { expect } from "@wdio/globals";

import { currentHashRoute, navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";

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

type SeededSession = {
  id: string;
  title: string;
  prompt: string;
};

const SIDEBAR_VIEW_MODE_KEY = "veslo.sidebar-session-view.v1";
const APP_WARMUP_MS = 10_000;
const WAIT_TIMEOUT_MS = 20_000;
const SESSION_ROW_SELECTOR = '[data-session-sidebar-row="true"]';

function trimText(value: string | null | undefined) {
  return (value ?? "").trim();
}

async function waitForRoute(hashFragment: string, timeout = WAIT_TIMEOUT_MS) {
  await waitForHashRoute(hashFragment, timeout);
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

  const runId = `e2e-session-switch-${Date.now()}`;
  const seeded: SeededSession[] = [];

  for (let index = 0; index < count; index += 1) {
    const title = `${runId} row ${index + 1}`;
    const prompt = `${runId} prompt ${index + 1}`;
    const created = await client.session.create({ title, directory });

    await client.session.prompt({
      sessionID: created.id,
      noReply: true,
      parts: [{ type: "text", text: prompt }],
    });

    seeded.push({ id: created.id, title, prompt });
  }

  return seeded;
}

async function ensureRecentSidebarMode() {
  await browser.execute((key: string) => {
    localStorage.setItem(key, "recent");
  }, SIDEBAR_VIEW_MODE_KEY);
}

async function readVisibleSeededTitles(expectedTitles: string[]) {
  return browser.execute((titles: string[], selector: string) => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const expected = new Set(titles);

    return Array.from(document.querySelectorAll(selector))
      .map((row) => normalize(row.querySelector("span.text-\\[13px\\]")?.textContent))
      .filter((title) => expected.has(title));
  }, expectedTitles, SESSION_ROW_SELECTOR) as Promise<string[]>;
}

async function waitForSeededRows(expectedTitles: string[]) {
  let lastSerialized = "";
  let stableSince = 0;

  await browser.waitUntil(
    async () => {
      const visibleTitles = await readVisibleSeededTitles(expectedTitles);
      const serialized = JSON.stringify(visibleTitles.slice().sort());
      const now = Date.now();

      if (visibleTitles.length !== expectedTitles.length) {
        lastSerialized = serialized;
        stableSince = 0;
        return false;
      }

      if (serialized !== lastSerialized) {
        lastSerialized = serialized;
        stableSince = now;
        return false;
      }

      return stableSince > 0 && now - stableSince >= 1_000;
    },
    {
      timeout: WAIT_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `Seeded sidebar rows did not stabilize in time: ${expectedTitles.join(", ")}`,
    },
  );
}

async function clickSidebarRow(title: string) {
  const point = await browser.execute((targetTitle: string, selector: string) => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const rows = Array.from(document.querySelectorAll(selector));

    const target = rows.find((row) =>
      normalize(row.querySelector("span.text-\\[13px\\]")?.textContent) === targetTitle
    );

    if (!(target instanceof HTMLElement)) {
      return null;
    }

    target.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = target.getBoundingClientRect();
    return {
      x: Math.round(rect.left + (rect.width / 2)),
      y: Math.round(rect.top + (rect.height / 2)),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }, title, SESSION_ROW_SELECTOR) as { x: number; y: number; width: number; height: number } | null;

  if (!point || point.width <= 0 || point.height <= 0) {
    throw new Error(`Could not resolve clickable coordinates for "${title}"`);
  }

  await browser.action("pointer")
    .move({ origin: "viewport", x: point.x, y: point.y, duration: 0 })
    .down({ button: 0 })
    .up({ button: 0 })
    .perform();
}

async function waitForSessionContent(target: SeededSession) {
  const root = await $("#root");

  await browser.waitUntil(
    async () => (await currentHashRoute()).includes(target.id),
    {
      timeout: WAIT_TIMEOUT_MS,
      timeoutMsg: `Route did not switch to session ${target.id} after clicking "${target.title}"`,
    },
  );

  await browser.waitUntil(
    async () => (await root.getText()).includes(target.prompt),
    {
      timeout: WAIT_TIMEOUT_MS,
      timeoutMsg: `Transcript for "${target.title}" never rendered prompt "${target.prompt}"`,
    },
  );
}

describe("Session switching", () => {
  it("switches between multiple sidebar sessions with a single click after the app fully loads", async () => {
    const seeded = await seedSessions(3);
    const titles = seeded.map((session) => session.title);

    await navigateToHash("/session");
    await waitForRoute("#/session");

    await ensureRecentSidebarMode();
    await browser.refresh();
    await waitForRoute("#/session");

    const root = await $("#root");
    await root.waitForExist({ timeout: WAIT_TIMEOUT_MS });

    // Repro only shows up after the desktop app finishes its initial bootstrap.
    await browser.pause(APP_WARMUP_MS);

    await waitForSeededRows(titles);

    const clickOrder = [seeded[2], seeded[0], seeded[1]];
    for (const target of clickOrder) {
      await clickSidebarRow(target.title);
      await waitForSessionContent(target);
    }

    expect((await readVisibleSeededTitles(titles)).length).toBe(titles.length);
  });
});
