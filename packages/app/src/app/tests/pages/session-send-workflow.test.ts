import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createSessionSendWorkflow,
  type SessionSendWorkflowOptions,
} from "../../pages/session-send-workflow.js";
import type { SendTargetWorkspaceScope } from "../../context/workspace-session-selection.js";
import type { VesloConversationRunInput } from "../../lib/veslo-server.js";
import type { Client, ComposerDraft, ModelRef } from "../../types.js";

const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");

const promptDraft = (text = "hello"): ComposerDraft => ({
  mode: "prompt",
  text,
  resolvedText: text,
  parts: [{ type: "text", text }],
  attachments: [],
});

type Harness = {
  events: string[];
  actions: string[];
  options: SessionSendWorkflowOptions;
  sendPromptInFlightCount: () => number;
  busyState: () => boolean;
};

function createHarness(overrides: Partial<SessionSendWorkflowOptions> = {}): Harness {
  const events: string[] = [];
  const actions: string[] = [];
  const { setBusy: overrideSetBusy, ...optionOverrides } = overrides;
  const targetWorkspace: SendTargetWorkspaceScope = {
    workspaceId: "ws-active",
    workspaceRoot: "/active",
    directory: "/active",
  };
  const model: ModelRef = {
    providerID: "openai",
    modelID: "gpt-4.1",
  };

  let selectedSessionId: string | null = "sess-selected";
  let sendPromptInFlightCount = 0;
  let busyState = false;

  const options: SessionSendWorkflowOptions = {
    abortConversationFromVesloWriteApi: async () => null,
    abortSessionTyped: async () => undefined,
    activePendingDraftKey: () => null,
    activePendingDraftMeta: () => null,
    activeUiScopeToken: () => ({
      key: "scope-1",
      workspaceId: "ws-active",
      workspaceRoot: "/active",
      directory: "/active",
      sessionId: selectedSessionId,
      generation: 1,
    }),
    addOpencodeCacheHint: (message) => message,
    agentForSession: () => null,
    buildCommandFileParts: () => [],
    buildPromptParts: (draft) => [{ type: "text", text: draft.resolvedText ?? draft.text }],
    busy: () => false,
    busyLabel: () => null,
    captureDisplayedConversationGuard: (sessionId) => ({
      sessionId,
      workspaceId: "ws-active",
      conversationId: "",
      opencodeSessionId: sessionId,
    }),
    clearActivePendingDraftState: () => actions.push("clear-pending-draft"),
    clearConsumedPendingDraftId: (id) => actions.push(`clear-consumed:${id}`),
    compactCurrentSession: async () => {
      actions.push("compact");
    },
    composerDraft: () => promptDraft("fallback"),
    createSendPreflightContext: (sendTraceId) => ({
      traceId: sendTraceId?.trim() || "trace-created",
      targetWorkspace: null,
      runtimeHealthOk: false,
      conversationWorkspaceByDirectory: new Map(),
    }),
    createSessionAndOpen: async () => {
      actions.push("create-session");
      return "sess-created";
    },
    developerMode: () => false,
    displayedConversationStillMatches: () => true,
    engineReady: () => true,
    finishPerf: () => undefined,
    holdVisibleRuntimeActivity: (sessionId, reason) => actions.push(`hold:${sessionId}:${reason}`),
    isPendingSessionInstanceId: (sessionId) => Boolean(sessionId?.startsWith("pending-session:")),
    isTauriRuntime: () => false,
    isUiScopeTokenCurrent: () => true,
    isWorkspaceClientStaleError: (_error): _error is { entryWorkspaceId?: string | null; currentWorkspaceId?: string | null } =>
      false,
    isWorkspaceRuntimeReady: () => true,
    listCommands: async () => [],
    markPendingDraftConsumed: (id) => actions.push(`mark-consumed:${id}`),
    messageFromUnknownError: (error) => error instanceof Error ? error.message : String(error),
    messages: () => [],
    modelForSession: () => model,
    modelVariant: () => null,
    pendingSessionDraftsDelete: async () => true,
    perfNow: () => 100,
    prepareSendRuntimeForSend: async () => true,
    providers: () => [],
    recordPerfLog: () => undefined,
    recordSendTrace: (event) => events.push(event),
    refreshPendingDraftSummaries: () => actions.push("refresh-pending-drafts"),
    registerPendingSidebarSession: () => actions.push("register-pending-sidebar"),
    releaseSendPromptInFlight: () => {
      sendPromptInFlightCount = Math.max(0, sendPromptInFlightCount - 1);
    },
    removeSessionFromWorkspaceSidebar: (workspaceId, sessionId) => actions.push(`remove-pending:${workspaceId}:${sessionId}`),
    reportError: () => undefined,
    resolveConversationAbortScope: (sessionId, target) => ({
      sessionId,
      workspaceId: target?.workspaceId?.trim() || "ws-active",
      workspaceRoot: target?.workspaceRoot?.trim() || "/active",
      directory: target?.directory?.trim() || "/active",
      hasConversationScope: Boolean(target?.conversationId?.trim()),
      conversationId: target?.conversationId?.trim() || sessionId,
      opencodeSessionId: target?.opencodeSessionId?.trim() || sessionId,
    }),
    resolveRuntimeSandboxStateForTarget: () => null,
    resolveSelectedSessionBrowseScope: (sessionId) =>
      sessionId === "sess-selected"
        ? { workspaceId: "ws-foreign", directory: "/foreign" }
        : { workspaceId: "ws-active", directory: "/active" },
    resolveSendPromptBusyOwnership: () => ({ ownsBusy: false }),
    resolveSendTargetWorkspaceScope: (sessionId) =>
      sessionId === "sess-target"
        ? { workspaceId: "ws-active", workspaceRoot: "/active", directory: "/active" }
        : targetWorkspace,
    routeStagedAttachmentsForModel: ({ draft }) => ({ draft }),
    routedClient: () => ({} as Client),
    routedClientForSendTarget: () => ({} as Client),
    runConversationFromVesloWriteApi: async (sessionId) => {
      actions.push(`run:${sessionId}`);
      return true;
    },
    safeStringify: (value) => JSON.stringify(value),
    selectedSessionId: () => selectedSessionId,
    sendTraceStep: async (_event, run) => run(),
    sessionDirectoryOverrideById: () => ({}),
    sessionStoreAppendSessionErrorTurn: () => undefined,
    sessionStoreClearCommandDisplay: () => undefined,
    sessionStoreSetCommandDisplay: () => undefined,
    setActivePendingDraftKey: () => undefined,
    setActivePendingDraftMeta: () => undefined,
    setBusy: (value) => {
      busyState = value;
      overrideSetBusy?.(value);
    },
    setBusyLabel: () => undefined,
    setBusyStartedAt: () => undefined,
    setComposerDraftBySessionId: () => undefined,
    setError: () => undefined,
    setLastPromptSent: () => undefined,
    setPrompt: (value) => actions.push(`set-prompt:${value}`),
    setSelectedSessionId: (sessionId) => {
      selectedSessionId = sessionId;
    },
    setView: () => undefined,
    stageAttachmentsIntoSessionDirectory: async () => [],
    startSendPromptInFlight: () => {
      sendPromptInFlightCount += 1;
      return () => {
        sendPromptInFlightCount = Math.max(0, sendPromptInFlightCount - 1);
      };
    },
    resolvedDevtoolsWorkspaceId: () => "ws-active",
    vesloServerClient: () => null,
    vesloServerStatus: () => "disconnected",
    workspace: {
      activeWorkspaceDisplay: () => ({ workspaceType: "local" }),
      activeWorkspaceId: () => "ws-active",
      activeWorkspaceRoot: () => "/active",
      workspaces: () => [],
    },
    ensureSelectedSessionWorkspaceActiveForSend: async () => true,
    ...optionOverrides,
  };

  return {
    events,
    actions,
    options,
    sendPromptInFlightCount: () => sendPromptInFlightCount,
    busyState: () => busyState,
  };
}

test("app modelForSession keeps the send workflow contract without dead per-session model maps", () => {
  const helperStart = appSource.indexOf("function modelForSession(sessionId: string | null | undefined): ModelRef {");
  assert.ok(helperStart >= 0, "app.tsx should expose modelForSession for the send workflow");
  const helperEnd = appSource.indexOf("\n  function agentForSession", helperStart);
  assert.ok(helperEnd > helperStart, "modelForSession should end before agentForSession");
  const helperSource = appSource.slice(helperStart, helperEnd);

  assert.doesNotMatch(
    appSource,
    /\b(sessionModelOverrideById|setSessionModelOverrideById|sessionModelById|setSessionModelById)\b/,
    "app.tsx should not keep unpopulated per-session model maps around modelForSession",
  );
  assert.match(
    helperSource,
    /const managedModel = managedAiAccessModel\(\);\s+if \(managedModel\) return managedModel;/,
    "managed AI access should still override the global default model",
  );
  assert.match(
    helperSource,
    /const id = sessionId\?\.trim\(\) \?\? "";\s+if \(!id\) return globalDefault;/,
    "missing session ids should still fall back to the global default model",
  );
  assert.match(
    helperSource,
    /if \(id === selectedSessionId\(\)\) \{[\s\S]*?const fromMessages = lastUserModelFromMessages\(messages\(\)\);[\s\S]*?if \(fromMessages\) return fromMessages;[\s\S]*?\}/,
    "selected sessions should still reuse the last user-message model when available",
  );
});

test("session send workflow blocks sends without a client message id", async () => {
  const harness = createHarness();
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft(), { origin: "session:normal", clientMessageId: "" });

  assert.equal(sent, false);
  assert.deepEqual(harness.actions, []);
  assert.ok(harness.events.includes("sendPrompt:blocked-missing-client-message-id"));
});

test("session send workflow releases in-flight tracking when runtime preparation throws", async () => {
  const busyValues: boolean[] = [];
  const inFlightCountsDuringPrepare: number[] = [];
  const harness = createHarness({
    isWorkspaceRuntimeReady: () => false,
    releaseSendPromptInFlight: undefined,
    prepareSendRuntimeForSend: async () => {
      inFlightCountsDuringPrepare.push(harness.sendPromptInFlightCount());
      assert.equal(harness.busyState(), true, "runtime preparation should happen while send busy state is active");
      throw new Error("runtime preparation failed");
    },
    resolveSendPromptBusyOwnership: () => ({ ownsBusy: true }),
    setBusy: (value) => {
      busyValues.push(value);
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  await assert.rejects(
    () => workflow.sendPrompt(promptDraft("runtime failure"), {
      clientMessageId: "client-runtime-failure",
      origin: "session:normal",
    }),
    /runtime preparation failed/,
  );

  assert.equal(harness.sendPromptInFlightCount(), 0);
  assert.deepEqual(inFlightCountsDuringPrepare, [1]);
  assert.deepEqual(busyValues, [true, false]);
  assert.equal(harness.busyState(), false);
});

test("session send workflow releases in-flight tracking when conversation run throws", async () => {
  const busyValues: boolean[] = [];
  const runSnapshots: Array<{
    sessionId: string;
    input: VesloConversationRunInput;
    inFlightCount: number;
    busy: boolean;
  }> = [];
  const harness = createHarness({
    resolveSendPromptBusyOwnership: () => ({ ownsBusy: true }),
    runConversationFromVesloWriteApi: async (sessionId, input) => {
      harness.actions.push(`run:${sessionId}`);
      runSnapshots.push({
        sessionId,
        input,
        inFlightCount: harness.sendPromptInFlightCount(),
        busy: harness.busyState(),
      });
      throw new Error("conversation run failed");
    },
    setBusy: (value) => {
      busyValues.push(value);
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("downstream failure"), {
    clientMessageId: "client-run-failure",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent, false);
  assert.equal(harness.sendPromptInFlightCount(), 0);
  assert.deepEqual(runSnapshots.map((snapshot) => ({
    sessionId: snapshot.sessionId,
    kind: snapshot.input.kind,
    clientMessageId: snapshot.input.clientMessageId,
    origin: snapshot.input.origin,
    inFlightCount: snapshot.inFlightCount,
    busy: snapshot.busy,
  })), [{
    sessionId: "sess-target",
    kind: "prompt_async",
    clientMessageId: "client-run-failure",
    origin: "session:normal",
    inFlightCount: 1,
    busy: true,
  }]);
  assert.deepEqual(busyValues, [true, false]);
  assert.equal(harness.busyState(), false);
  assert.ok(harness.actions.includes("run:sess-target"));
  assert.ok(harness.events.includes("sendPrompt:conversation-run-error"));
  assert.ok(harness.events.includes("sendPrompt:error"));
});

test("session send workflow ignores a selected session from another workspace when no explicit target is provided", async () => {
  const harness = createHarness({
    createSessionAndOpen: async () => {
      harness.actions.push("create-session");
      return "sess-created";
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("from foreign selection"), {
    clientMessageId: "client-1",
    origin: "session:normal",
  });

  assert.equal(sent, true);
  assert.ok(harness.actions.includes("create-session"));
  assert.ok(harness.actions.includes("run:sess-created"));
  assert.ok(!harness.actions.includes("run:sess-selected"));
});

test("session send workflow selects the model from the materialized session id", async () => {
  const modelSessionIds: Array<string | null | undefined> = [];
  const runInputs: Array<{ sessionId: string; input: VesloConversationRunInput }> = [];
  const harness = createHarness({
    modelForSession: (sessionId) => {
      modelSessionIds.push(sessionId);
      return {
        providerID: "openai",
        modelID: sessionId === "sess-created" ? "gpt-4.1" : "wrong-session",
      };
    },
    runConversationFromVesloWriteApi: async (sessionId, input) => {
      harness.actions.push(`run:${sessionId}`);
      runInputs.push({ sessionId, input });
      return true;
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("create then send"), {
    clientMessageId: "client-created-model",
    origin: "session:normal",
  });

  assert.equal(sent, true);
  assert.deepEqual(modelSessionIds, ["sess-created"]);
  assert.deepEqual(runInputs.map(({ sessionId, input }) => ({
    sessionId,
    kind: input.kind,
    model: input.kind === "prompt_async" ? input.model : null,
    clientMessageId: input.clientMessageId,
    origin: input.origin,
  })), [{
    sessionId: "sess-created",
    kind: "prompt_async",
    model: { providerID: "openai", modelID: "gpt-4.1" },
    clientMessageId: "client-created-model",
    origin: "session:normal",
  }]);
  assert.ok(harness.actions.includes("create-session"));
  assert.ok(harness.actions.includes("run:sess-created"));
});

test("session send workflow sends to an explicit target session without creating a new one", async () => {
  const harness = createHarness();
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("explicit target"), {
    clientMessageId: "client-2",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent, true);
  assert.ok(!harness.actions.includes("create-session"));
  assert.ok(harness.actions.includes("run:sess-target"));
});
