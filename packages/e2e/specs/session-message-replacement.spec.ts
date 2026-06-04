import { expect } from "@wdio/globals";

import { navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";

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

type TranscriptMessage = {
  info?: {
    id?: string;
    role?: string;
  };
  parts?: Array<{
    type?: string;
    text?: string;
  }>;
};

const WAIT_TIMEOUT_MS = 60_000;

function trimText(value: string | null | undefined) {
  return (value ?? "").trim();
}

async function readRootText(): Promise<string> {
  const root = await $("#root");
  return root.getText();
}

async function waitForAppShellReady(timeout = WAIT_TIMEOUT_MS): Promise<void> {
  await browser.waitUntil(
    async () => {
      const root = await $("#root");
      if (!(await root.isExisting())) return false;
      return (await root.getText()).trim().length > 0;
    },
    {
      timeout,
      timeoutMsg: `App shell did not render within ${timeout}ms`,
    },
  );
}

function isUnauthenticatedAuthGate(text: string): boolean {
  return text.includes("Sign in to Veslo") && text.includes("Sign in with Browser");
}

async function isDefaultE2EDenAuthSeed(): Promise<boolean> {
  return browser.execute(() => {
    const raw = window.localStorage.getItem("veslo.den.auth") ?? window.sessionStorage.getItem("veslo.den.auth");
    if (!raw) return false;
    try {
      const auth = JSON.parse(raw) as { denApiBase?: unknown; token?: unknown };
      return auth.denApiBase === "http://127.0.0.1:9" || auth.token === "veslo-e2e-default-token";
    } catch {
      return false;
    }
  });
}

function textForMessage(message: TranscriptMessage): string {
  return (message.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
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

async function createSeedSession(originalText: string) {
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

  const runId = `e2e-message-replacement-${Date.now()}`;
  const created = await client.session.create({
    title: runId,
    directory,
  });

  await client.session.prompt({
    sessionID: created.id,
    noReply: true,
    parts: [{ type: "text", text: originalText }],
  });

  const messages = (await client.session.messages({ sessionID: created.id, limit: 20 })) as TranscriptMessage[];
  const originalUserMessage = messages.find(
    (message) => message.info?.role === "user" && textForMessage(message) === originalText,
  );
  const originalMessageId = trimText(originalUserMessage?.info?.id);
  if (!originalMessageId) {
    throw new Error("Seeded user message was not found in the transcript");
  }

  return {
    client,
    directory,
    sessionId: created.id as string,
    originalMessageId,
    title: runId,
  };
}

async function setComposerText(value: string) {
  const textbox = await $('[role="textbox"]');
  await textbox.waitForDisplayed({ timeout: WAIT_TIMEOUT_MS });
  await textbox.click();
  await textbox.setValue(value);
  await browser.waitUntil(
    async () => browser.execute((element: HTMLElement, nextText: string) => element.textContent === nextText, textbox, value),
    {
      timeout: 10_000,
      timeoutMsg: "Composer text was not reflected in the editable node after input.",
    },
  );
}

async function waitForAppRuntimeConnected(timeout = WAIT_TIMEOUT_MS) {
  await browser.waitUntil(
    async () => {
      const state = await browser.execute(() => ({
        baseUrl: window.localStorage.getItem("veslo.baseUrl") ?? "",
        rootText: document.querySelector("#root")?.textContent ?? "",
      }));
      return state.baseUrl.startsWith("http://127.0.0.1:") &&
        !state.rootText.includes("Connect to Veslo server to attach files.");
    },
    {
      timeout,
      interval: 500,
      timeoutMsg: `App runtime client did not connect within ${timeout}ms`,
    },
  );
}

async function clearSendTrace() {
  await browser.execute(() => {
    (window as typeof window & { __vesloSendTrace?: Array<Record<string, unknown>> }).__vesloSendTrace = [];
  });
}

async function readSendDiagnostics() {
  return browser.execute(() => {
    const buttons = Array.from(document.querySelectorAll("button")).map((button) => ({
      text: (button.textContent ?? "").trim(),
      title: button.getAttribute("title"),
      ariaLabel: button.getAttribute("aria-label"),
      disabled: button.hasAttribute("disabled"),
      visible: Boolean(button.offsetWidth || button.offsetHeight || button.getClientRects().length),
    }));
    const userMessages = Array.from(document.querySelectorAll('[data-message-role="user"]')).map((node) => ({
      id: (node as HTMLElement).dataset.messageId ?? null,
      text: ((node as HTMLElement).textContent ?? "").trim(),
    }));
    const trace = ((window as typeof window & { __vesloSendTrace?: Array<Record<string, unknown>> }).__vesloSendTrace ?? []).slice(-20);
    return {
      hash: window.location.hash,
      rootText: (document.querySelector("#root")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 1200),
      composerText: (document.querySelector('[role="textbox"]')?.textContent ?? "").trim(),
      buttons,
      userMessages,
      trace,
    };
  });
}

describe("Session message replacement", () => {
  it("resends an edited latest user message as a new backend message after reverting", async function () {
    await waitForAppShellReady();
    const initialText = await readRootText();
    if (isUnauthenticatedAuthGate(initialText)) {
      console.warn("[session-message-replacement] Skipping because the desktop profile is unauthenticated.");
      this.skip();
    }
    if (await isDefaultE2EDenAuthSeed()) {
      console.warn("[session-message-replacement] Skipping because the desktop profile is using the default non-live E2E auth seed.");
      this.skip();
    }

    const originalText = `Original replacement prompt ${Date.now()}`;
    const editedText = `Edited replacement prompt ${Date.now()}`;
    const seeded = await createSeedSession(originalText);

    await browser.refresh();
    await waitForAppShellReady();
    await navigateToHash(`/session/${seeded.sessionId}`);
    await waitForHashRoute(`#/session/${seeded.sessionId}`, WAIT_TIMEOUT_MS);
    await waitForAppRuntimeConnected();

    const originalBubble = await $(`[data-message-id="${seeded.originalMessageId}"][data-message-role="user"]`);
    await originalBubble.waitForExist({ timeout: WAIT_TIMEOUT_MS });
    await browser.waitUntil(
      async () => (await originalBubble.getText()).includes(originalText),
      {
        timeout: WAIT_TIMEOUT_MS,
        timeoutMsg: "Seeded original user message did not render",
      },
    );

    const editButton = await originalBubble.$('button[aria-label="Edit message"]');
    await editButton.waitForExist({ timeout: WAIT_TIMEOUT_MS });
    await editButton.click();

    await browser.waitUntil(
      async () => {
        const textbox = await $('[role="textbox"]');
        return (await textbox.getText()).includes(originalText);
      },
      {
        timeout: WAIT_TIMEOUT_MS,
        timeoutMsg: "Editing the message did not load the original text into the composer",
      },
    );

    await setComposerText(editedText);
    await clearSendTrace();

    const sendButton = await $('button[aria-label="Queue message"]');
    await sendButton.waitForClickable({ timeout: WAIT_TIMEOUT_MS });
    await sendButton.click();

    let diagnostics: unknown = null;
    try {
      await browser.waitUntil(
        async () => {
          const messages = (await seeded.client.session.messages({ sessionID: seeded.sessionId, limit: 20 })) as TranscriptMessage[];
          diagnostics = {
            ui: await readSendDiagnostics(),
            backendMessages: messages.map((message) => ({
              id: message.info?.id ?? null,
              role: message.info?.role ?? null,
              text: textForMessage(message),
            })),
          };
          return messages.some((message) =>
            message.info?.role === "user" &&
            message.info.id !== seeded.originalMessageId &&
            textForMessage(message) === editedText
          );
        },
        {
          timeout: WAIT_TIMEOUT_MS,
          timeoutMsg: "Edited user message was not persisted as a new backend message.",
        },
      );
    } catch (error) {
      throw new Error(
        `Edited user message was not persisted as a new backend message. Diagnostics=${JSON.stringify(diagnostics)}. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const messages = (await seeded.client.session.messages({ sessionID: seeded.sessionId, limit: 20 })) as TranscriptMessage[];
    const originalMessages = messages.filter(
      (message) => message.info?.role === "user" && message.info.id === seeded.originalMessageId,
    );
    const editedMessages = messages.filter(
      (message) => message.info?.role === "user" && textForMessage(message) === editedText,
    );

    expect(originalMessages.length).toBe(0);
    expect(editedMessages.length).toBe(1);
    expect(editedMessages[0].info?.id).not.toBe(seeded.originalMessageId);

    await browser.waitUntil(
      async () => {
        const visibleUserMessages = await $$('[data-message-role="user"]');
        const visibleTexts: string[] = [];
        for (const message of visibleUserMessages) {
          visibleTexts.push(await message.getText());
        }
        return visibleTexts.some((text) => text.includes(editedText)) &&
          !visibleTexts.some((text) => text.includes(originalText));
      },
      {
        timeout: WAIT_TIMEOUT_MS,
        timeoutMsg: "Visible transcript did not replace the original text with the edited text",
      },
    );
  });
});
