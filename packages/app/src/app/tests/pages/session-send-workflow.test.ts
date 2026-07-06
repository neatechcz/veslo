import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createSessionSendWorkflow,
  documentRuntimeBlockReasonForSkillCommand,
  documentRuntimeFormatForSkillCommand,
  type SessionSendWorkflowOptions,
} from "../../pages/session-send-workflow.js";
import type { SendTargetWorkspaceScope } from "../../context/workspace-session-selection.js";
import type { SessionFlowProgressEvent } from "../../context/session-flow-progress-presenter.js";
import type { LiveTranscriptReadPolicyEvent } from "../../context/live-transcript-read-policy.js";
import type { DocumentRuntimeStatusPayload } from "../../lib/document-runtime.js";
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
  progressEvents: SessionFlowProgressEvent["type"][];
  actions: string[];
  errors: string[];
  options: SessionSendWorkflowOptions;
  sendPromptInFlightCount: () => number;
  busyState: () => boolean;
  liveReadAllowedWorkspaceIds: string[];
  liveTranscriptPolicyEvents: LiveTranscriptReadPolicyEvent[];
};

function documentRuntimePayload(
  status: DocumentRuntimeStatusPayload["status"],
): DocumentRuntimeStatusPayload {
  const ready = status === "ready";
  return {
    runtimeId: "veslo-document-runtime",
    status,
    ready,
    updatedAt: "2026-07-02T12:00:00.000Z",
    source: "server",
    skills: [
      { id: "veslo-docx", format: "docx", ready, reason: status },
      { id: "veslo-xlsx", format: "xlsx", ready, reason: status },
      { id: "veslo-pdf", format: "pdf", ready, reason: status },
      { id: "veslo-pptx", format: "pptx", ready, reason: status },
    ],
    package: {
      installedVersion: null,
      activePackage: null,
      updateAvailable: false,
      installing: false,
      rollback: false,
      remoteOnly: status === "remote_only",
    },
    repair: {
      available: status === "missing",
      inProgress: status === "repairing",
      blockedReason: null,
      lastAttemptAt: null,
      lastError: null,
    },
    policy: {
      windowsWslRuntime: "not_applicable",
    },
  };
}

function createHarness(overrides: Partial<SessionSendWorkflowOptions> = {}): Harness {
  const events: string[] = [];
  const progressEvents: SessionFlowProgressEvent["type"][] = [];
  const actions: string[] = [];
  const errors: string[] = [];
  const { emitFlowProgress: overrideEmitFlowProgress, ...optionOverrides } = overrides;
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
  const liveReadAllowedWorkspaceIds: string[] = [];
  const liveTranscriptPolicyEvents: LiveTranscriptReadPolicyEvent[] = [];

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
    emitFlowProgress: (event) => {
      progressEvents.push(event.type);
      busyState = event.type !== "flow.idle";
      overrideEmitFlowProgress?.(event);
    },
    finishPerf: () => undefined,
    holdVisibleRuntimeActivity: (sessionId, reason) => actions.push(`hold:${sessionId}:${reason}`),
    isPendingSessionInstanceId: (sessionId) => Boolean(sessionId?.startsWith("pending-session:")),
    isTauriRuntime: () => false,
    isUiScopeTokenCurrent: () => true,
    isWorkspaceClientStaleError: (_error): _error is { entryWorkspaceId?: string | null; currentWorkspaceId?: string | null } =>
      false,
    isWorkspaceRuntimeReady: () => true,
    listCommands: async () => [],
    emitLiveTranscriptPolicyEvent: (event) => {
      liveTranscriptPolicyEvents.push(event);
      liveReadAllowedWorkspaceIds.push(event.workspaceId?.trim() || "ws-active");
    },
    markPendingDraftConsumed: (id) => actions.push(`mark-consumed:${id}`),
    messageFromUnknownError: (error) => error instanceof Error ? error.message : String(error),
    messages: () => [],
    modelForSession: () => model,
    modelVariant: () => null,
    pendingSessionDraftsDelete: async () => true,
    perfNow: () => 100,
    prepareSendRuntimeForSend: async () => ({
      ok: true,
      runtimeReady: true,
      managedAiReady: true,
      workspaceId: "ws-active",
      activeWorkspace: true,
      recoveryAttempted: false,
      reason: "runtime-health-skipped",
    }),
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
    setComposerDraftBySessionId: () => undefined,
    setError: (message) => {
      if (message) errors.push(message);
    },
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
    progressEvents,
    actions,
    errors,
    options,
    sendPromptInFlightCount: () => sendPromptInFlightCount,
    busyState: () => busyState,
    liveReadAllowedWorkspaceIds,
    liveTranscriptPolicyEvents,
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

test("document runtime helpers map only Veslo document skills", () => {
  assert.equal(documentRuntimeFormatForSkillCommand("veslo-docx"), "docx");
  assert.equal(documentRuntimeFormatForSkillCommand("veslo-xlsx"), "xlsx");
  assert.equal(documentRuntimeFormatForSkillCommand("veslo-pdf"), "pdf");
  assert.equal(documentRuntimeFormatForSkillCommand("veslo-pptx"), "pptx");
  assert.equal(documentRuntimeFormatForSkillCommand("custom-docx"), null);
  assert.match(
    documentRuntimeBlockReasonForSkillCommand(documentRuntimePayload("missing"), "veslo-docx") ?? "",
    /package is missing/,
  );
});

test("session send workflow blocks document skill runs when document runtime is not ready", async () => {
  const harness = createHarness({
    documentRuntimeStatus: () => documentRuntimePayload("missing"),
    listCommands: async () => [{ name: "veslo-docx", source: "skill" }],
    vesloServerClient: () => ({
      resolveSkill: async () => ({ match: { name: "veslo-docx" } }),
    }),
    vesloServerStatus: () => "connected",
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("Edit brief.docx"), {
    clientMessageId: "client-doc-runtime-missing",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent, false);
  assert.match(harness.errors.at(-1) ?? "", /package is missing/);
  assert.equal(harness.actions.some((action) => action.startsWith("run:")), false);
  assert.ok(harness.events.includes("maybeResolveSkillCommand:blocked-document-runtime"));
  assert.ok(harness.events.includes("sendPrompt:blocked-document-runtime"));
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
    emitFlowProgress: (event) => {
      busyValues.push(event.type !== "flow.idle");
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
    emitFlowProgress: (event) => {
      busyValues.push(event.type !== "flow.idle");
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

test("abortSession blocks active legacy fallback when workspace scope is missing", async () => {
  const abortCalls: string[] = [];
  const harness = createHarness({
    abortConversationFromVesloWriteApi: async () => null,
    abortSessionTyped: async (_client, sessionId) => {
      abortCalls.push(sessionId);
    },
    resolveSelectedSessionBrowseScope: () => null,
    resolveConversationAbortScope: (sessionId) => ({
      sessionId,
      workspaceId: "ws-active",
      workspaceRoot: "/active",
      directory: "/active",
      hasConversationScope: false,
      conversationId: sessionId,
      opencodeSessionId: sessionId,
    }),
  });
  const workflow = createSessionSendWorkflow(harness.options);

  await workflow.abortSession("sess-unscoped");

  assert.deepEqual(abortCalls, []);
  assert.ok(harness.events.includes("abortSession:legacy-fallback-blocked-missing-workspace-scope"));
  assert.match(harness.errors.at(-1) ?? "", /workspace scope is missing/);
});

test("abortSession blocks active legacy fallback for foreign workspace scope", async () => {
  const abortCalls: string[] = [];
  const harness = createHarness({
    abortConversationFromVesloWriteApi: async () => null,
    abortSessionTyped: async (_client, sessionId) => {
      abortCalls.push(sessionId);
    },
    routedClient: (workspaceId?: string | null) => workspaceId ? null : ({} as Client),
    resolveSelectedSessionBrowseScope: () => ({
      workspaceId: "ws-foreign",
      workspaceRoot: "/foreign",
      directory: "/foreign",
    }),
    resolveConversationAbortScope: (sessionId) => ({
      sessionId,
      workspaceId: "ws-foreign",
      workspaceRoot: "/foreign",
      directory: "/foreign",
      hasConversationScope: false,
      conversationId: sessionId,
      opencodeSessionId: sessionId,
    }),
  });
  const workflow = createSessionSendWorkflow(harness.options);

  await workflow.abortSession("sess-foreign");

  assert.deepEqual(abortCalls, []);
  assert.ok(harness.events.includes("abortSession:legacy-fallback-blocked-foreign-workspace"));
  assert.match(harness.errors.at(-1) ?? "", /belongs to another workspace/);
});

test("session send workflow retries recoverable runtime run failure once with same client message id", async () => {
  const runCalls: Array<{ clientMessageId?: string | null; forceRecovery?: boolean }> = [];
  const prepareForceRecoveryValues: Array<boolean | undefined> = [];
  const harness = createHarness({
    prepareSendRuntimeForSend: async (_event, preflight) => {
      const forceRecovery = preflight.forceRecovery === true;
      prepareForceRecoveryValues.push(preflight.forceRecovery);
      if (forceRecovery) preflight.forceRecovery = false;
      return {
        ok: true,
        runtimeReady: true,
        managedAiReady: true,
        workspaceId: "ws-active",
        activeWorkspace: true,
        recoveryAttempted: forceRecovery,
        reason: forceRecovery ? "runtime-recovery-ok" : "runtime-health-ok",
      };
    },
    runConversationFromVesloWriteApi: async (_sessionId, input, options) => {
      runCalls.push({
        clientMessageId: input.clientMessageId,
        forceRecovery: options?.preflight?.forceRecovery,
      });
      if (runCalls.length === 1) {
        throw new Error("opencode_proxy_failed: socket closed");
      }
      return true;
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("recoverable runtime failure"), {
    clientMessageId: "client-runtime-retry",
    origin: "session:normal",
  });

  assert.equal(sent, true);
  assert.deepEqual(runCalls.map((call) => call.clientMessageId), [
    "client-runtime-retry",
    "client-runtime-retry",
  ]);
  assert.deepEqual(prepareForceRecoveryValues, [undefined, true]);
  assert.equal(runCalls[1]?.forceRecovery, false);
  assert.ok(harness.events.includes("sendPrompt:conversation-run-runtime-recovery-start"));
  assert.ok(harness.events.includes("sendPrompt:conversation-run-runtime-recovery-result"));
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

test("session send workflow emits live transcript policy event after successful user send", async () => {
  const harness = createHarness({
    resolveSendTargetWorkspaceScope: () => ({
      workspaceId: "ws-send-target",
      workspaceRoot: "/send-target",
      directory: "/send-target",
    }),
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("hello"), {
    clientMessageId: "client-live-read",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent, true);
  assert.deepEqual(harness.liveReadAllowedWorkspaceIds, ["ws-send-target"]);
  assert.deepEqual(harness.liveTranscriptPolicyEvents.map((event) => event.reason), ["sendPrompt:success"]);
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

test("session send workflow uses OpenCode variant instead of raw reasoning effort for codex oauth", async () => {
  const runInputs: Array<{ sessionId: string; input: VesloConversationRunInput }> = [];
  const harness = createHarness({
    modelForSession: () => ({
      providerID: "codex_oauth",
      modelID: "gpt-5.5",
    }),
    modelVariant: () => "xhigh",
    runConversationFromVesloWriteApi: async (sessionId, input) => {
      harness.actions.push(`run:${sessionId}`);
      runInputs.push({ sessionId, input });
      return true;
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("codex oauth send"), {
    clientMessageId: "client-codex-oauth",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent, true);
  assert.equal(runInputs.length, 1);
  const input = runInputs[0]?.input;
  assert.equal(input?.kind, "prompt_async");
  assert.deepEqual(input?.model, { providerID: "codex_oauth", modelID: "gpt-5.5" });
  assert.equal(input?.variant, "xhigh");
  assert.equal("reasoning_effort" in (input ?? {}), false);
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
