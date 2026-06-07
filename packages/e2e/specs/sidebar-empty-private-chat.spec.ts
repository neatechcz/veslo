import { expect } from "@wdio/globals";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";

type WorkspaceInfo = {
  id: string;
  path: string;
  workspaceType?: string | null;
};

type WorkspaceList = {
  activeId: string;
  workspaces: WorkspaceInfo[];
};

const SIDEBAR_VIEW_MODE_KEY = "veslo.sidebar-session-view.v1";
const SIDEBAR_CHAT_COLLAPSED_KEY = "veslo.sidebar-chat-collapsed.v1";
const LANGUAGE_KEY = "veslo.language";

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

async function createEmptyPrivateWorkspace(): Promise<WorkspaceInfo> {
  const privateRoot = await tauriInvoke<string>("workspace_private_root");
  const folderPath = join(privateRoot, `${Date.now()}-e2e-empty-chat`);
  mkdirSync(folderPath, { recursive: true });

  const created = await tauriInvoke<WorkspaceList>("workspace_create", {
    folderPath,
    name: "Private workspace",
    preset: "starter",
  });
  const active = created.workspaces.find((workspace) => workspace.id === created.activeId);

  if (!active?.id || active.workspaceType !== "local" || !trimText(active.path).includes("private-workspaces")) {
    throw new Error("Created empty private workspace was not active.");
  }

  return active;
}

async function readChatSectionState(): Promise<{
  chatSection: boolean;
  collapsedChatSection: boolean;
  chatButton: boolean;
  text: string;
}> {
  return browser.execute(() => {
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    const section = document.querySelector('[data-sidebar-chat-section="true"]');
    const collapsed = document.querySelector('[data-sidebar-chat-collapsed="true"]');
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => normalize(candidate.textContent ?? "") === "Chat",
    );

    return {
      chatSection: Boolean(section),
      collapsedChatSection: Boolean(collapsed),
      chatButton: Boolean(button),
      text: normalize(section?.textContent ?? collapsed?.textContent ?? ""),
    };
  });
}

describe("Sidebar empty private chat", () => {
  it("keeps the bottom Chats section visible for an empty private workspace", async () => {
    await navigateToHash("/session");
    await waitForHashRoute("#/session", 5000);

    await browser.execute(
      ({
        viewModeKey,
        collapsedKey,
        languageKey,
      }: {
        viewModeKey: string;
        collapsedKey: string;
        languageKey: string;
      }) => {
        window.localStorage.setItem(viewModeKey, "by-project");
        window.localStorage.setItem(collapsedKey, "0");
        window.localStorage.setItem(languageKey, "en");
      },
      { viewModeKey: SIDEBAR_VIEW_MODE_KEY, collapsedKey: SIDEBAR_CHAT_COLLAPSED_KEY, languageKey: LANGUAGE_KEY },
    );

    const workspace = await createEmptyPrivateWorkspace();
    expect(workspace.path).toContain("private-workspaces");

    await browser.refresh();
    await waitForHashRoute("#/session", 10000);

    await browser.waitUntil(
      async () => {
        const state = await readChatSectionState();
        return state.chatSection && state.chatButton && state.text.includes("Chats");
      },
      {
        timeout: 15000,
        interval: 250,
        timeoutMsg: "Bottom Chats section did not stay visible for an empty private workspace.",
      },
    );

    const state = await readChatSectionState();
    expect(state.chatSection).toBe(true);
    expect(state.collapsedChatSection).toBe(false);
    expect(state.chatButton).toBe(true);
    expect(state.text).toContain("Chats");
  });
});
