import assert from "node:assert/strict";
import test from "node:test";

import type { Session } from "@opencode-ai/sdk/v2/client";

import type { ComposerDraft, ComposerPart, MessageWithParts } from "../../types.js";
import { createSessionMutationWorkflow } from "../../pages/session-mutation-workflow.js";
import {
  sessionSubmitAcceptedResult,
  type SessionSubmitResult,
} from "../../lib/session-send-contract.js";

function userMessage(id: string, text: string): MessageWithParts {
  return {
    info: {
      id,
      sessionID: "ses_1",
      role: "user",
    } as never,
    parts: [
      {
        id: `${id}:text`,
        sessionID: "ses_1",
        messageID: id,
        type: "text",
        text,
      } as never,
    ],
  };
}

function assistantMessage(id: string): MessageWithParts {
  return {
    info: {
      id,
      sessionID: "ses_1",
      role: "assistant",
    } as never,
    parts: [],
  };
}

const replacementDraft: ComposerDraft = {
  mode: "prompt",
  text: "edited prompt",
  resolvedText: "edited prompt",
  parts: [{ type: "text", text: "edited prompt" } satisfies ComposerPart],
  attachments: [],
};

function terminalReplacementResult(
  status: "blocked" | "failed",
  code: string,
  message: string,
  draftDisposition: "restore" | "keep" | "mark-failed",
) {
  return {
    status,
    code,
    message,
    workspaceId: "ws_1",
    conversationId: "conv_1",
    opencodeSessionId: "open_1",
    clientMessageId: "client_replace_1",
    draftDisposition,
    recoverable: status === "blocked",
  };
}

function createHarness(overrides: Record<string, unknown> = {}) {
  let selectedSessionId: string | null = "ses_1";
  let sessions: Session[] = [{ id: "ses_1", title: "Session", revert: null } as never];
  let prompt = "";
  let statusById: Record<string, string> = { ses_1: "idle" };
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const deps = {
    lastPromptSent: () => "retry prompt",
    sendPrompt: async (...args: unknown[]) => {
      calls.push({ name: "sendPrompt", args });
      return sessionSubmitAcceptedResult();
    },
    createClientMessageId: () => "client_msg_1",
    selectedSessionId: () => selectedSessionId,
    selectedSession: () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    messages: () => [userMessage("msg_1", "first"), assistantMessage("msg_2"), userMessage("msg_3", "latest")],
    setPrompt: (value: string) => {
      prompt = value;
    },
    ensureSelectedSessionWorkspaceActiveForSend: async (...args: unknown[]) => {
      calls.push({ name: "ensureWorkspace", args });
      return true;
    },
    routedClient: (...args: unknown[]) => {
      calls.push({ name: "routedClient", args });
      return {
        session: {
          delete: async (...deleteArgs: unknown[]) => {
            calls.push({ name: "session.delete", args: deleteArgs });
            return {};
          },
          get: async () => ({ id: "ses_1", title: "Session" }),
          messages: async () => [],
          todo: async () => [],
        },
        app: {
          agents: async () => [],
        },
      };
    },
    abortSessionSafe: async (...args: unknown[]) => {
      calls.push({ name: "abortSessionSafe", args });
    },
    revertSession: async (...args: unknown[]) => {
      calls.push({ name: "revertSession", args });
      return { id: "ses_1", revert: { messageID: String(args[2]) } };
    },
    unrevertSession: async (...args: unknown[]) => {
      calls.push({ name: "unrevertSession", args });
      return { id: "ses_1", revert: null };
    },
    upsertLocalSession: (session: Session | null | undefined) => {
      calls.push({ name: "upsertLocalSession", args: [session] });
      if (session) sessions = [session];
    },
    normalizeSendCorrelation: (options: { clientMessageId?: string; origin?: string }) => ({
      clientMessageId: options.clientMessageId ?? "",
      origin: options.origin ?? "test",
    }),
    createSendPreflightContext: () => ({
      traceId: "trace_1",
      targetWorkspace: null,
      conversationWorkspaceByDirectory: new Map(),
    }),
    recordSendTrace: (event: string, payload?: Record<string, unknown>) => {
      calls.push({ name: "recordSendTrace", args: [event, payload] });
    },
    sendTraceStep: async (_event: string, run: () => Promise<boolean>) => run(),
    resolveSendTargetWorkspaceScope: () => null,
    prepareSendRuntimeForSend: async () => ({ ok: true }),
    resolveRuntimeSandboxStateForTarget: () => null,
    routedClientForSendTarget: () => ({}),
    engineReady: () => true,
    client: () => ({}),
    reportError: (...args: unknown[]) => {
      calls.push({ name: "reportError", args });
    },
    selectedSessionModel: () => ({ providerID: "openai", modelID: "gpt-5" }),
    developerMode: () => false,
    modelVariant: () => null,
    recordPerfLog: (...args: unknown[]) => {
      calls.push({ name: "recordPerfLog", args });
    },
    finishPerf: (...args: unknown[]) => {
      calls.push({ name: "finishPerf", args });
    },
    perfNow: () => 100,
    sessionDirectoryOverrideById: () => ({}),
    workspaceProjectDir: () => "/repo",
    resolveSelectedSessionBrowseScope: () => null,
    messageFromUnknownError: String,
    safeStringify: JSON.stringify,
    renameSession: async (...args: unknown[]) => {
      calls.push({ name: "renameSession", args });
    },
    refreshSidebarWorkspaceSessions: async (...args: unknown[]) => {
      calls.push({ name: "refreshSidebarWorkspaceSessions", args });
    },
    activeWorkspaceId: () => "ws_1",
    workspaces: () => [{ id: "ws_1", workspaceType: "local", path: "/repo" }],
    activeWorkspaceRoot: () => "/repo",
    workspaceRootForId: () => "/repo",
    sessionDirectoryOverride: () => ({}),
    persistSessionDirectoryOverride: (...args: unknown[]) => {
      calls.push({ name: "persistSessionDirectoryOverride", args });
    },
    setSessions: (next: Session[]) => {
      sessions = next;
    },
    sessions: () => sessions,
    deleteSessionComposerDraft: (current: Record<string, unknown>, sessionId: string) => ({ ...current, deleted: sessionId }),
    setComposerDraftBySessionId: (updater: (current: Record<string, unknown>) => Record<string, unknown>) => {
      calls.push({ name: "setComposerDraftBySessionId", args: [updater({})] });
    },
    removeSessionFromWorkspaceSidebar: (...args: unknown[]) => {
      calls.push({ name: "removeSessionFromWorkspaceSidebar", args });
    },
    pathname: () => "/session/ses_1",
    navigate: (...args: unknown[]) => {
      calls.push({ name: "navigate", args });
    },
    setSelectedSessionId: (value: string | null) => {
      selectedSessionId = value;
    },
    clearWorkspaceLastSessionIfSelected: (...args: unknown[]) => {
      calls.push({ name: "clearWorkspaceLastSessionIfSelected", args });
    },
    sessionStatusById: () => statusById,
    setSessionStatusById: (next: Record<string, string>) => {
      statusById = next;
    },
    withoutSessionStatus: (current: Record<string, string>, _workspaceId: string, sessionId: string) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    },
    unwrap: async (value: unknown) => value,
    listCommands: async () => [],
    compactCommandDescription: () => "Compact",
    downloadSessionExport: (...args: unknown[]) => {
      calls.push({ name: "downloadSessionExport", args });
      return "session-export.json";
    },
    normalizeTodoItems: (value: unknown) => value,
    ...overrides,
  };

  const workflow = createSessionMutationWorkflow(deps as never);
  return {
    workflow,
    calls,
    get prompt() {
      return prompt;
    },
    get selectedSessionId() {
      return selectedSessionId;
    },
    get sessions() {
      return sessions;
    },
    get statusById() {
      return statusById;
    },
  };
}

test("session mutation workflow retries the last prompt with a fresh send correlation", () => {
  const harness = createHarness();
  harness.workflow.retryLastPrompt();

  assert.equal(harness.calls[0]?.name, "sendPrompt");
  assert.deepEqual(harness.calls[0]?.args[1], {
    clientMessageId: "client_msg_1",
    origin: "app:retry-last-prompt",
  });
});

test("session mutation workflow undo reverts the latest visible user message and restores its prompt", async () => {
  const harness = createHarness();
  await harness.workflow.undoLastUserMessage();

  assert.equal(harness.calls.find((call) => call.name === "revertSession")?.args[2], "msg_3");
  assert.equal(harness.prompt, "latest");
});

test("session mutation workflow redo unreverts at the end of the revert chain and clears prompt", async () => {
  const harness = createHarness({
    selectedSession: () => ({ id: "ses_1", revert: { messageID: "msg_3" } }),
  });
  await harness.workflow.redoLastUserMessage();

  assert.equal(harness.calls.some((call) => call.name === "unrevertSession"), true);
  assert.equal(harness.prompt, "");
});

test("session mutation workflow delete clears selected state and removes sidebar/session state", async () => {
  const harness = createHarness();
  await harness.workflow.deleteSessionById("ses_1");

  assert.equal(harness.selectedSessionId, null);
  assert.deepEqual(harness.sessions, []);
  assert.equal(harness.calls.some((call) => call.name === "removeSessionFromWorkspaceSidebar"), true);
  assert.equal(harness.statusById.ses_1, undefined);
});

test("session mutation workflow compact submits through server submit when local scope is available", async () => {
  const submitCalls: Array<{ workspaceId: string; directory: string; input: Record<string, unknown>; traceId?: string | null }> = [];
  const harness = createHarness({
    resolveSelectedSessionBrowseScope: () => ({
      workspaceId: "ws_1",
      workspaceRoot: "/repo",
      directory: "/repo",
      conversationId: "conv_1",
      opencodeSessionId: "open_1",
    }),
    submitConversationFromVesloWriteApi: async (
      workspaceId: string,
      directory: string,
      input: Record<string, unknown>,
      preflight?: { traceId?: string | null },
    ) => {
      submitCalls.push({ workspaceId, directory, input, traceId: preflight?.traceId });
      return {
        status: "submitted",
        workspaceId,
        conversationId: "conv_1",
        opencodeSessionId: "open_1",
        runId: "run_compact",
        clientMessageId: String(input.clientMessageId),
        draftDisposition: "clear",
      };
    },
  });
  await harness.workflow.submitCurrentSessionCompaction("ses_1");

  assert.equal(harness.selectedSessionId, "ses_1");
  assert.equal(submitCalls.length, 1);
  assert.deepEqual(submitCalls.map(({ workspaceId, directory, traceId }) => ({ workspaceId, directory, traceId })), [{
    workspaceId: "ws_1",
    directory: "/repo",
    traceId: "trace_1",
  }]);
  assert.deepEqual(submitCalls[0]?.input, {
    clientMessageId: "client_msg_1",
    origin: "app:compact-session",
    target: {
      directory: "/repo",
      conversationId: "conv_1",
      opencodeSessionId: "open_1",
    },
    draft: {
      mode: "prompt",
      text: "/compact",
      resolvedText: "/compact",
      parts: [{ type: "text", text: "/compact" }],
      command: { name: "compact", arguments: "" },
      attachments: [],
    },
    options: {
      variant: null,
      submitQueuePolicy: "normal",
    },
  });
  assert.ok(harness.calls.some((call) => call.name === "recordSendTrace" && call.args[0] === "compactSession:server-submit-success"));
});

test("session mutation workflow compact fails explicitly when server submit is unavailable", async () => {
  const harness = createHarness();
  await assert.rejects(
    () => harness.workflow.submitCurrentSessionCompaction("ses_1"),
    /Server-owned compact is unavailable/,
  );

  assert.equal(harness.selectedSessionId, "ses_1");
  assert.ok(harness.calls.some((call) => call.name === "recordSendTrace" && call.args[0] === "compactSession:server-submit-unavailable"));
});

test("session mutation workflow replaces a user message through server-owned submit", async () => {
  const submitCalls: Array<{ workspaceId: string; directory: string; input: Record<string, unknown>; traceId?: string | null }> = [];
  const harness = createHarness({
    prepareSendRuntimeForSend: async () => {
      throw new Error("legacy runtime prep should not run for server-owned replacement");
    },
    revertSession: async () => {
      throw new Error("legacy app revert should not run for server-owned replacement");
    },
    sendPrompt: async () => {
      throw new Error("legacy app send should not run for server-owned replacement");
    },
    resolveSelectedSessionBrowseScope: () => ({
      workspaceId: "ws_1",
      workspaceRoot: "/repo",
      directory: "/repo",
      conversationId: "conv_1",
      opencodeSessionId: "open_1",
    }),
    submitConversationFromVesloWriteApi: async (
      workspaceId: string,
      directory: string,
      input: Record<string, unknown>,
      preflight?: { traceId?: string | null },
    ) => {
      submitCalls.push({ workspaceId, directory, input, traceId: preflight?.traceId });
      return {
        status: "submitted",
        workspaceId,
        conversationId: "conv_1",
        opencodeSessionId: "open_1",
        runId: "run_replace",
        clientMessageId: String(input.clientMessageId),
        draftDisposition: "clear",
      };
    },
  });

  const accepted = await harness.workflow.replaceUserMessage("msg_1", replacementDraft, {
    clientMessageId: "client_replace_1",
    origin: "session:replacement",
  });

  assert.equal(accepted.accepted, true);
  assert.equal(accepted.status, "submitted");
  assert.equal(accepted.runId, "run_replace");
  assert.equal(submitCalls.length, 1);
  assert.deepEqual(submitCalls.map(({ workspaceId, directory, traceId }) => ({ workspaceId, directory, traceId })), [{
    workspaceId: "ws_1",
    directory: "/repo",
    traceId: "trace_1",
  }]);
  assert.deepEqual(submitCalls[0]?.input, {
    clientMessageId: "client_replace_1",
    origin: "session:replacement",
    source: null,
    target: {
      directory: "/repo",
      conversationId: "conv_1",
      opencodeSessionId: "open_1",
    },
    draft: {
      mode: "prompt",
      text: "edited prompt",
      resolvedText: "edited prompt",
      parts: [{ type: "text", text: "edited prompt" }],
      command: null,
      attachments: [],
    },
    options: {
      replaceMessageId: "msg_1",
      variant: null,
      submitQueuePolicy: "normal",
    },
  });
  assert.ok(harness.calls.some((call) => call.name === "recordSendTrace" && call.args[0] === "replaceUserMessage:server-submit-success"));
  assert.equal(harness.calls.some((call) => call.name === "revertSession"), false);
  assert.equal(harness.calls.some((call) => call.name === "sendPrompt"), false);
});

test("session mutation workflow returns typed replacement server blocked and failed states", async () => {
  const cases: Array<{
    status: "blocked" | "failed";
    code: string;
    message: string;
    draftDisposition: "restore" | "keep" | "mark-failed";
  }> = [
    {
      status: "blocked",
      code: "replacement_state_unavailable",
      message: "Replacement state is unavailable.",
      draftDisposition: "restore",
    },
    {
      status: "failed",
      code: "replacement_submit_failed_restore_failed",
      message: "Replacement submit failed and restore failed.",
      draftDisposition: "mark-failed",
    },
  ];

  for (const item of cases) {
    const harness = createHarness({
      prepareSendRuntimeForSend: async () => {
        throw new Error("legacy runtime prep should not run for typed server replacement result");
      },
      revertSession: async () => {
        throw new Error("legacy app revert should not run for typed server replacement result");
      },
      sendPrompt: async () => {
        throw new Error("legacy app send should not run for typed server replacement result");
      },
      resolveSelectedSessionBrowseScope: () => ({
        workspaceId: "ws_1",
        workspaceRoot: "/repo",
        directory: "/repo",
        conversationId: "conv_1",
        opencodeSessionId: "open_1",
      }),
      submitConversationFromVesloWriteApi: async () =>
        terminalReplacementResult(item.status, item.code, item.message, item.draftDisposition),
    });

    const result: SessionSubmitResult = await harness.workflow.replaceUserMessage("msg_1", replacementDraft, {
      clientMessageId: "client_replace_1",
      origin: "session:replacement",
    });

    assert.equal(result.accepted, false);
    assert.equal(result.status, item.status);
    assert.equal(result.code, item.code);
    assert.equal(result.message, item.message);
    assert.equal(result.draftDisposition, item.draftDisposition);
    assert.equal(result.conversationId, "conv_1");
    assert.ok(
      harness.calls.some((call) => call.name === "recordSendTrace" && call.args[0] === `replaceUserMessage:server-submit-${item.status}`),
    );
    assert.equal(harness.calls.some((call) => call.name === "revertSession"), false);
    assert.equal(harness.calls.some((call) => call.name === "sendPrompt"), false);
  }
});

test("session mutation workflow strict validation blocks malformed replacement server result", async () => {
  const harness = createHarness({
    prepareSendRuntimeForSend: async () => {
      throw new Error("legacy runtime prep should not run for malformed server result");
    },
    revertSession: async () => {
      throw new Error("legacy app revert should not run for malformed server result");
    },
    sendBoundaryValidationMode: () => "strict",
    sendPrompt: async () => {
      throw new Error("legacy app send should not run for malformed server result");
    },
    resolveSelectedSessionBrowseScope: () => ({
      workspaceId: "ws_1",
      workspaceRoot: "/repo",
      directory: "/repo",
      conversationId: "conv_1",
      opencodeSessionId: "open_1",
    }),
    submitConversationFromVesloWriteApi: async () => ({
      status: "submitted",
      workspaceId: "ws_1",
      conversationId: "conv_1",
      opencodeSessionId: "open_1",
      clientMessageId: "client_replace_1",
      draftDisposition: "clear",
    }),
  });

  const result = await harness.workflow.replaceUserMessage("msg_1", replacementDraft, {
    clientMessageId: "client_replace_1",
    origin: "session:replacement",
  });

  assert.equal(result.accepted, false);
  assert.equal(result.status, "failed");
  assert.equal(result.code, "replacement_submit_invalid_result");
  assert.match(result.message ?? "", /conversation-submit-terminal-result/);
  assert.ok(
    harness.calls.some((call) =>
      call.name === "recordSendTrace" && call.args[0] === "replaceUserMessage:server-submit-result:validation-failed"
    ),
  );
  assert.equal(harness.calls.some((call) => call.name === "revertSession"), false);
  assert.equal(harness.calls.some((call) => call.name === "sendPrompt"), false);
});

test("session mutation workflow strict validation blocks malformed legacy replacement runtime preflight", async () => {
  const harness = createHarness({
    sendBoundaryValidationMode: () => "strict",
    submitConversationFromVesloWriteApi: undefined,
    prepareSendRuntimeForSend: async () => ({ ok: true }),
  });

  const result = await harness.workflow.replaceUserMessage("msg_1", replacementDraft, {
    clientMessageId: "client_replace_1",
    origin: "session:replacement",
  });

  assert.equal(result.accepted, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "replacement_runtime_invalid_contract");
  assert.match(result.message ?? "", /send-runtime-preparation-result/);
  assert.ok(
    harness.calls.some((call) =>
      call.name === "recordSendTrace" && call.args[0] === "replaceUserMessage:runtime-preflight:validation-failed"
    ),
  );
  assert.equal(harness.calls.some((call) => call.name === "revertSession"), false);
});

test("session mutation workflow lists the built-in compact command when backend commands omit it", async () => {
  const harness = createHarness();
  const commands = await harness.workflow.listCommands();

  assert.equal(commands[0]?.id, "builtin:compact");
  assert.equal(commands[0]?.name, "compact");
});
