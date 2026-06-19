import { expect } from "@wdio/globals";
import { mkdirSync } from "node:fs";

import { navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";

type VesloServerInfo = {
  running: boolean;
  baseUrl: string | null;
  clientToken: string | null;
  hostToken: string | null;
  lastStderr: string | null;
};

type EngineInfo = {
  running: boolean;
  baseUrl: string | null;
  projectDir?: string | null;
};

type WorkspaceInfo = {
  id: string;
  path: string;
  directory?: string | null;
};

type WorkspaceBootstrap = {
  activeId: string;
  workspaces: WorkspaceInfo[];
};

type ChatActionDebug = {
  hash: string;
  bodyText: string;
  buttons: Array<{
    text: string;
    label: string;
    title: string;
    disabled: boolean;
    visible: boolean;
    context: string;
  }>;
};

type ServerWorkspaceInfo = {
  id?: string;
  baseUrl?: string | null;
  opencode?: {
    baseUrl?: string | null;
  } | null;
};

type ServerWorkspaceList = {
  activeId?: string | null;
  items?: ServerWorkspaceInfo[];
};

type OrchestratorStatus = {
  running?: boolean;
  activeId?: string | null;
  daemon?: {
    baseUrl?: string | null;
  } | null;
  workspaces?: Array<{
    id?: string | null;
    path?: string | null;
  }>;
  lastError?: string | null;
};

type ConversationCreateResult = {
  id?: string;
  conversationId?: string;
  opencodeSessionId?: string;
};

const WAIT_TIMEOUT_MS = 180_000;

function trimText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function normalizePath(value: string | null | undefined): string {
  return trimText(value).replace(/\\/g, "/").replace(/^\/\/\?\//, "").replace(/\/+$/, "").toLowerCase();
}

function isLoopbackHttpUrl(value: string | null | undefined): boolean {
  return /^http:\/\/(127\.0\.0\.1|localhost):\d+/.test(trimText(value));
}

function workspaceDirectory(workspace: WorkspaceInfo): string {
  return trimText(workspace.directory) || trimText(workspace.path);
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

async function readWorkspaceBootstrap(): Promise<WorkspaceBootstrap> {
  return tauriInvoke<WorkspaceBootstrap>("workspace_bootstrap");
}

async function readActiveWorkspace(): Promise<WorkspaceInfo> {
  const bootstrap = await readWorkspaceBootstrap();
  const active = bootstrap.workspaces.find((workspace) => workspace.id === bootstrap.activeId);
  if (!active?.id || !workspaceDirectory(active)) {
    throw new Error("Active workspace is not ready.");
  }
  return active;
}

async function clearWorkspacesForEmptyChatState(): Promise<void> {
  let bootstrap = await readWorkspaceBootstrap();

  for (const workspace of [...bootstrap.workspaces]) {
    await tauriInvoke<WorkspaceBootstrap>("workspace_forget", {
      workspaceId: workspace.id,
      mode: "detach_only",
    });
  }

  bootstrap = await readWorkspaceBootstrap();
  if (bootstrap.workspaces.length > 0 || trimText(bootstrap.activeId)) {
    throw new Error(`Workspace state did not clear before empty-chat test: ${JSON.stringify(bootstrap)}`);
  }

  await browser.refresh();
  await waitForHashRoute("#/session", 10_000);
  await waitForAppShellReady();
}

async function ensurePrivateWorkspaceRootDirectory(): Promise<void> {
  const privateRoot = await tauriInvoke<string>("workspace_private_root");
  mkdirSync(privateRoot, { recursive: true });
}

async function waitForAppShellReady(timeout = 30_000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const root = await $("#root");
      return (await root.isExisting()) && (await root.getText()).trim().length > 0;
    },
    {
      timeout,
      timeoutMsg: `App shell did not render within ${timeout}ms.`,
    },
  );
}

async function clickSidebarNewChat(): Promise<void> {
  const hasChatAction = () =>
    browser.execute(() => {
      const matchesChatButton = (button: HTMLButtonElement) => {
        const text = (button.textContent ?? "").replace(/\s+/g, " ").trim();
        const label = (button.getAttribute("aria-label") ?? button.getAttribute("title") ?? "").trim();
        return (
          text === "Chat" ||
          text === "聊天" ||
          label === "Chat" ||
          label === "New chat" ||
          label === "Nový chat" ||
          label === "新聊天"
        );
      };

      return Array.from(document.querySelectorAll("button")).some(
        (button) => !button.disabled && matchesChatButton(button),
      );
    });

  await browser.waitUntil(
    hasChatAction,
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: "Chat action did not become available.",
    },
  );

  const clicked = await browser.execute(() => {
    const matchesChatButton = (button: HTMLButtonElement) => {
      const text = (button.textContent ?? "").replace(/\s+/g, " ").trim();
      const label = (button.getAttribute("aria-label") ?? button.getAttribute("title") ?? "").trim();
      return (
        text === "Chat" ||
        text === "聊天" ||
        label === "Chat" ||
        label === "New chat" ||
        label === "Nový chat" ||
        label === "新聊天"
      );
    };

    const sidebarSection = document.querySelector('[data-sidebar-chat-section="true"]');
    const sidebarButtons = sidebarSection
      ? Array.from(sidebarSection.querySelectorAll("button"))
      : [];
    const allButtons = Array.from(document.querySelectorAll("button"));

    for (const button of [...sidebarButtons, ...allButtons]) {
      if (!matchesChatButton(button) || button.disabled) continue;
      button.click();
      return true;
    }

    return false;
  });

  expect(clicked).toBe(true);
}

async function readChatActionDebug(): Promise<ChatActionDebug> {
  return browser.execute(() => {
    const summarizeButton = (button: HTMLButtonElement) => {
      const rect = button.getBoundingClientRect();
      const style = window.getComputedStyle(button);
      const context = button.parentElement?.parentElement?.parentElement?.textContent ?? "";
      return {
        text: (button.textContent ?? "").replace(/\s+/g, " ").trim(),
        label: (button.getAttribute("aria-label") ?? "").trim(),
        title: (button.getAttribute("title") ?? "").trim(),
        disabled: button.disabled,
        visible:
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          style.opacity !== "0",
        context: context.replace(/\s+/g, " ").trim().slice(0, 240),
      };
    };

    return {
      hash: window.location.hash,
      bodyText: document.body.innerText.slice(0, 1600),
      buttons: Array.from(document.querySelectorAll("button")).map(summarizeButton),
    };
  }) as Promise<ChatActionDebug>;
}

async function clickEmptyStateNewChat(): Promise<void> {
  const clickResult = async () =>
    browser.execute(() => {
      const matchesChatButton = (button: HTMLButtonElement) => {
        const rect = button.getBoundingClientRect();
        const style = window.getComputedStyle(button);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          style.opacity !== "0";
        const text = (button.textContent ?? "").replace(/\s+/g, " ").trim();
        const label = (button.getAttribute("aria-label") ?? button.getAttribute("title") ?? "").trim();
        if (!visible || button.disabled || (text !== "Chat" && label !== "Chat")) return false;

        let ancestor: HTMLElement | null = button.parentElement;
        while (ancestor) {
          const ancestorText = (ancestor.textContent ?? "").replace(/\s+/g, " ").trim();
          if (ancestorText.includes("Start a chat") && ancestorText.includes("Begin in a private chat")) {
            return true;
          }
          ancestor = ancestor.parentElement;
        }

        return false;
      };

      const button = Array.from(document.querySelectorAll("button")).find(matchesChatButton);
      if (!button) return false;

      button.scrollIntoView({ block: "center", inline: "center" });
      button.click();
      return true;
    });

  try {
    await browser.waitUntil(clickResult, {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: "Empty-state Chat action did not become available.",
    });
  } catch (error) {
    const debug = await readChatActionDebug().catch(() => null);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nChat action debug:\n${JSON.stringify(debug, null, 2)}`,
    );
  }
}

async function waitForNewPrivateWorkspace(previousWorkspaceId: string): Promise<WorkspaceInfo> {
  let active: WorkspaceInfo | null = null;

  try {
    await browser.waitUntil(
      async () => {
        active = await readActiveWorkspace().catch(() => null);
        const directory = workspaceDirectory(active ?? ({} as WorkspaceInfo));
        return Boolean(
          active?.id &&
            active.id !== previousWorkspaceId &&
            normalizePath(directory).includes("/private-workspaces/"),
        );
      },
      {
        timeout: 60_000,
        interval: 500,
        timeoutMsg: "New private chat workspace did not become active.",
      },
    );
  } catch (error) {
    const [bootstrap, chatDebug] = await Promise.all([
      readWorkspaceBootstrap().catch((readError) => ({ error: String(readError) })),
      readChatActionDebug().catch((readError) => ({ error: String(readError) })),
    ]);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nWorkspace bootstrap:\n${JSON.stringify(
        bootstrap,
        null,
        2,
      )}\nUI debug:\n${JSON.stringify(chatDebug, null, 2)}`,
    );
  }

  return active!;
}

async function waitForVesloServerReady(): Promise<VesloServerInfo> {
  let latest: VesloServerInfo | null = null;

  await browser.waitUntil(
    async () => {
      latest = await tauriInvoke<VesloServerInfo>("veslo_server_info").catch(() => null);
      return Boolean(latest?.running && isLoopbackHttpUrl(latest.baseUrl) && trimText(latest.clientToken));
    },
    {
      timeout: 60_000,
      interval: 500,
      timeoutMsg: "Veslo server did not become ready.",
    },
  );

  return latest!;
}

async function waitForServerWorkspaceBinding(
  server: VesloServerInfo,
  workspace: WorkspaceInfo,
): Promise<ServerWorkspaceInfo> {
  const baseUrl = trimText(server.baseUrl).replace(/\/+$/, "");
  const token = trimText(server.clientToken);
  let active: ServerWorkspaceInfo | null = null;
  let latestPayload: ServerWorkspaceList | null = null;
  let latestStatus: number | null = null;
  let latestBody = "";

  try {
    await browser.waitUntil(
      async () => {
        const response = await fetch(`${baseUrl}/workspaces`, {
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => null);
        latestStatus = response?.status ?? null;
        if (!response) return false;

        latestBody = await response.text();
        if (!response.ok) return false;

        const payload = JSON.parse(latestBody) as ServerWorkspaceList;
        latestPayload = payload;
        active = (payload.items ?? []).find((item) => item.id === workspace.id) ?? null;
        const activeBaseUrl = active?.baseUrl ?? active?.opencode?.baseUrl ?? "";
        return payload.activeId === workspace.id && isLoopbackHttpUrl(activeBaseUrl);
      },
      {
        timeout: 60_000,
        interval: 500,
        timeoutMsg: `Veslo server did not expose active workspace binding for ${workspace.id}.`,
      },
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nLatest status: ${latestStatus}\nLatest body:\n${
        latestPayload ? JSON.stringify(latestPayload, null, 2) : latestBody.slice(0, 1600)
      }`,
    );
  }

  return active!;
}

async function waitForOrchestratorWorkspaceRegistration(workspace: WorkspaceInfo): Promise<OrchestratorStatus> {
  const expectedDirectory = normalizePath(workspaceDirectory(workspace));
  let latest: OrchestratorStatus | null = null;

  try {
    await browser.waitUntil(
      async () => {
        latest = await tauriInvoke<OrchestratorStatus>("orchestrator_status").catch(() => null);
        if (!latest?.running) return false;
        return (latest.workspaces ?? []).some((item) => {
          if (item.id !== workspace.id) return false;
          const itemPath = normalizePath(item.path);
          return itemPath === expectedDirectory || itemPath.endsWith(`/${expectedDirectory.split("/").pop() ?? ""}`);
        });
      },
      {
        timeout: 60_000,
        interval: 500,
        timeoutMsg: `Orchestrator did not register ${workspace.id} before first conversation create.`,
      },
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nLatest orchestrator status:\n${JSON.stringify(
        latest,
        null,
        2,
      )}`,
    );
  }

  return latest!;
}

async function waitForActiveEngineForWorkspace(workspace: WorkspaceInfo): Promise<EngineInfo> {
  const expectedDirectory = normalizePath(workspaceDirectory(workspace));
  let latest: EngineInfo | null = null;

  try {
    await browser.waitUntil(
      async () => {
        latest = await tauriInvoke<EngineInfo>("engine_info", {
          workspaceId: workspace.id,
          workspacePath: workspaceDirectory(workspace),
        }).catch(() => null);
        const projectDir = normalizePath(latest?.projectDir);
        return Boolean(
          trimText(latest?.baseUrl) &&
            projectDir &&
            (projectDir === expectedDirectory || projectDir.endsWith(`/${expectedDirectory.split("/").pop() ?? ""}`)),
        );
      },
      {
        timeout: 120_000,
        interval: 500,
        timeoutMsg: `Engine did not become ready for ${workspace.id}.`,
      },
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nLatest engine info:\n${JSON.stringify(
        latest,
        null,
        2,
      )}`,
    );
  }

  return latest!;
}

async function createConversationThroughVesloWriteApi(
  server: VesloServerInfo,
  workspace: WorkspaceInfo,
): Promise<ConversationCreateResult> {
  const baseUrl = trimText(server.baseUrl).replace(/\/+$/, "");
  const token = trimText(server.clientToken);
  const directory = workspaceDirectory(workspace);
  const response = await fetch(`${baseUrl}/workspace/${encodeURIComponent(workspace.id)}/conversations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Veslo-Send-Trace-Id": `e2e-new-private-chat-${Date.now()}`,
    },
    body: JSON.stringify({
      directory,
      title: `E2E new private chat ${Date.now()}`,
    }),
  });
  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(`Conversation create failed with ${response.status}: ${bodyText.slice(0, 800)}`);
  }

  return JSON.parse(bodyText) as ConversationCreateResult;
}

describe("New private chat first send", () => {
  it("registers the UI-created private workspace before conversation creation", async function () {
    this.timeout(WAIT_TIMEOUT_MS + 90_000);

    await navigateToHash("/session");
    await waitForHashRoute("#/session", 10_000);
    await waitForAppShellReady();
    await clearWorkspacesForEmptyChatState();
    await ensurePrivateWorkspaceRootDirectory();

    await clickEmptyStateNewChat();

    const privateWorkspace = await waitForNewPrivateWorkspace("");
    expect(workspaceDirectory(privateWorkspace)).toContain("private-workspaces");

    const server = await waitForVesloServerReady();
    const serverWorkspace = await waitForServerWorkspaceBinding(server, privateWorkspace);
    expect(serverWorkspace.id).toBe(privateWorkspace.id);
    await waitForOrchestratorWorkspaceRegistration(privateWorkspace);

    const conversation = await createConversationThroughVesloWriteApi(server, privateWorkspace);
    expect(trimText(conversation.id)).not.toBe("");
    expect(trimText(conversation.conversationId)).not.toBe("");
    expect(trimText(conversation.opencodeSessionId)).not.toBe("");
    await waitForActiveEngineForWorkspace(privateWorkspace);
  });
});
