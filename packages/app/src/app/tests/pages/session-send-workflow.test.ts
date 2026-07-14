import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createConversationRunCompatibilityBridge,
  createSessionSendWorkflow,
  documentRuntimeBlockReasonForSkillCommand,
  documentRuntimeFormatForSkillCommand,
  type ConversationRunCompatibilityBridgeOptions,
  type SessionSendWorkflowOptions,
} from "../../pages/session-send-workflow.js";
import type { SendTargetWorkspaceScope } from "../../context/workspace-session-selection.js";
import type { SessionFlowProgressEvent } from "../../context/session-flow-progress-presenter.js";
import type { LiveTranscriptReadPolicyEvent } from "../../context/live-transcript-read-policy.js";
import type { DocumentRuntimeStatusPayload } from "../../lib/document-runtime.js";
import type {
  VesloConversationRunInput,
  VesloConversationSubmitRequest,
  VesloConversationSubmitResult,
} from "../../lib/veslo-server.js";
import {
  classifySendBoundaryFailurePhase,
  resolveSendBoundaryValidationMode,
  validateSendRuntimePreparationResult,
} from "../../lib/send-boundary-validation.js";
import type { Client, ComposerDraft, ModelRef } from "../../types.js";

const appSource = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");

const promptDraft = (text = "hello"): ComposerDraft => ({
  mode: "prompt",
  text,
  resolvedText: text,
  parts: [{ type: "text", text }],
  attachments: [],
});

const attachmentDraft = (text = "with attachment"): ComposerDraft => ({
  mode: "prompt",
  text,
  resolvedText: text,
  parts: [{ type: "text", text }],
  attachments: [
    {
      id: "att-1",
      name: "note.txt",
      kind: "file",
      mimeType: "text/plain",
      size: 4,
      dataUrl: "data:text/plain;base64,dGVzdA==",
    },
  ],
});

const compactDraft = (): ComposerDraft => ({
  mode: "prompt",
  text: "/compact",
  resolvedText: "/compact",
  parts: [{ type: "text", text: "/compact" }],
  attachments: [],
  command: { name: "compact", arguments: "" },
});

type AdmittedRunInput = Parameters<SessionSendWorkflowOptions["admitAcceptedConversationRun"]>[0];

type Harness = {
  events: string[];
  progressEvents: SessionFlowProgressEvent["type"][];
  actions: string[];
  admittedRuns: AdmittedRunInput[];
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

function createHarness(
  overrides: Partial<SessionSendWorkflowOptions & ConversationRunCompatibilityBridgeOptions> = {},
): Harness {
  const events: string[] = [];
  const progressEvents: SessionFlowProgressEvent["type"][] = [];
  const actions: string[] = [];
  const admittedRuns: AdmittedRunInput[] = [];
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

  const optionsWithBridge = {
    admitAcceptedConversationRun: (input: AdmittedRunInput) => {
      admittedRuns.push(input);
      actions.push(
        `admit:${input.sessionId}:${input.workspaceId}:${input.conversationId}:${input.opencodeSessionId}:${input.runId}:${input.clientMessageId}`,
      );
    },
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
      workspaceRoot: "/active",
      directory: "/active",
      conversationId: "",
      opencodeSessionId: sessionId,
    }),
    clearActivePendingDraftState: () => actions.push("clear-pending-draft"),
    clearConsumedPendingDraftId: (id) => actions.push(`clear-consumed:${id}`),
    submitCurrentSessionCompaction: async () => {
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
    isPendingSessionInstanceKey: (sessionId: string | null | undefined) =>
      Boolean(sessionId?.startsWith("pending-session:")),
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
    submitConversationRunViaVesloWriteApi: async (sessionId) => {
      actions.push(`run:${sessionId}`);
      return true;
    },
    safeStringify: (value) => JSON.stringify(value),
    selectedSessionId: () => selectedSessionId,
    sendBoundaryValidationMode: () => "strict",
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
  } as SessionSendWorkflowOptions & ConversationRunCompatibilityBridgeOptions;

  const hasExplicitCompatibilityBridge = Object.prototype.hasOwnProperty.call(
    optionsWithBridge,
    "conversationRunCompatibilityBridge",
  );
  const options: SessionSendWorkflowOptions = {
    ...optionsWithBridge,
    conversationRunCompatibilityBridge: hasExplicitCompatibilityBridge
      ? optionsWithBridge.conversationRunCompatibilityBridge
      : createConversationRunCompatibilityBridge(optionsWithBridge),
    stageServerSubmitAttachments:
      optionsWithBridge.stageServerSubmitAttachments ?? optionsWithBridge.stageAttachmentsIntoSessionDirectory,
  };

  return {
    events,
    progressEvents,
    actions,
    admittedRuns,
    errors,
    options,
    sendPromptInFlightCount: () => sendPromptInFlightCount,
    busyState: () => busyState,
    liveReadAllowedWorkspaceIds,
    liveTranscriptPolicyEvents,
  };
}

test("app modelForSession keeps the send workflow contract without dead per-session model maps", () => {
  const helperStart = appSource.indexOf("function modelForSession(_sessionId: string | null | undefined): ModelRef {");
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
  assert.match(helperSource, /return globalDefault;/, "sessions should fall back to the runtime default");
  assert.doesNotMatch(
    helperSource,
    /lastUserModelFromMessages|selectedSessionId\(\)|messages\(\)/,
    "stale transcript metadata must not restore per-session user model authority",
  );
});

test("session send workflow blocks sends without a client message id", async () => {
  const harness = createHarness();
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft(), { origin: "session:normal", clientMessageId: "" });

  assert.equal(sent.accepted, false);
  assert.deepEqual(harness.actions, []);
  assert.ok(harness.events.includes("sendPrompt:blocked-missing-client-message-id"));
});

test("app wiring keeps the normal send workflow free of conversation run compatibility bridge dependency", () => {
  const workflowStart = appSource.indexOf("const sessionSendWorkflow = createSessionSendWorkflow({");
  const workflowEnd = appSource.indexOf("\n  });", workflowStart);

  assert.notEqual(workflowStart, -1, "app.tsx should wire createSessionSendWorkflow");
  assert.ok(workflowEnd > workflowStart, "session send workflow dependency object should be bounded");
  const workflowDeps = appSource.slice(workflowStart, workflowEnd);

  assert.doesNotMatch(
    workflowDeps,
    /\bconversationRunCompatibilityBridge\b/,
    "normal production send wiring must not inject the conversation run compatibility bridge",
  );
});

test("session send workflow blocks compatibility bridge when it is not configured", async () => {
  const harness = createHarness({
    conversationRunCompatibilityBridge: null as never,
    submitConversationFromVesloWriteApi: undefined,
    submitConversationRunViaVesloWriteApi: async () => {
      throw new Error("compatibility run should not run when fallback is disabled");
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("compat disabled"), {
    clientMessageId: "client-compat-disabled",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, false);
  assert.equal(sent.status, "blocked");
  assert.equal(sent.code, "conversation_run_bridge_disabled");
  assert.ok(harness.events.includes("sendPrompt:blocked-conversation-run-bridge-disabled"));
  assert.ok(!harness.actions.some((action) => action.startsWith("run:")));
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

  assert.equal(sent.accepted, false);
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

test("send boundary validation mode is report-only unless explicitly strict or off", () => {
  assert.equal(resolveSendBoundaryValidationMode({}), "report");
  assert.equal(resolveSendBoundaryValidationMode({ VITE_VESLO_SEND_BOUNDARY_VALIDATION: "strict" }), "strict");
  assert.equal(resolveSendBoundaryValidationMode({ VITE_VESLO_SEND_BOUNDARY_VALIDATION: "off" }), "off");
  assert.equal(resolveSendBoundaryValidationMode({ VITE_VESLO_SEND_BOUNDARY_VALIDATION: "false" }), "off");
  assert.equal(resolveSendBoundaryValidationMode({ VITE_VESLO_SEND_BOUNDARY_VALIDATION: "enabled" }), "report");
});

test("send boundary validation reports successful Zod checks without blocking send", () => {
  const traces: Array<{ event: string; payload?: Record<string, unknown> }> = [];
  const value = {
    ok: true,
    runtimeReady: true,
    managedAiReady: true,
    workspaceId: "ws-active",
    activeWorkspace: true,
    recoveryAttempted: false,
    reason: "runtime-health-ok",
  };

  const checked = validateSendRuntimePreparationResult(value, {
    context: { phase: "runtime-preflight" },
    event: "sendPrompt:runtime-preflight:validation-failed",
    mode: "report",
    recordSendTrace: (event, payload) => traces.push({ event, payload }),
    traceId: "trace-zod-ok",
  });

  assert.equal(checked.ok, true);
  assert.deepEqual(traces.map((trace) => trace.event), ["sendPrompt:runtime-preflight:validation-checked"]);
  assert.equal(traces[0]?.payload?.schema, "send-runtime-preparation-result");
  assert.equal(traces[0]?.payload?.validator, "zod");
  assert.equal(traces[0]?.payload?.validationMode, "report");
  assert.equal(traces[0]?.payload?.strict, false);
  assert.equal(traces[0]?.payload?.traceId, "trace-zod-ok");
  assert.deepEqual((traces[0]?.payload?.payload as { keys?: string[] }).keys, [
    "ok",
    "runtimeReady",
    "managedAiReady",
    "workspaceId",
    "activeWorkspace",
    "recoveryAttempted",
    "reason",
  ]);

  traces.length = 0;
  const disabled = validateSendRuntimePreparationResult(value, {
    event: "sendPrompt:runtime-preflight:validation-failed",
    mode: "off",
    recordSendTrace: (event, payload) => traces.push({ event, payload }),
  });

  assert.equal(disabled.ok, true);
  assert.deepEqual(traces, []);
});

test("send boundary validation traces strict Zod issue diagnostics without raw payloads", () => {
  const traces: Array<{ event: string; payload?: Record<string, unknown> }> = [];
  const value = {
    ok: true,
    runtimeReady: true,
    managedAiReady: true,
  };

  const checked = validateSendRuntimePreparationResult(value, {
    context: { phase: "runtime-preflight" },
    event: "sendPrompt:runtime-preflight:validation-failed",
    mode: "strict",
    recordSendTrace: (event, payload) => traces.push({ event, payload }),
    traceId: "trace-zod-failed",
  });

  assert.equal(checked.ok, false);
  assert.equal(traces[0]?.event, "sendPrompt:runtime-preflight:validation-failed");
  const payload = traces[0]?.payload ?? {};
  assert.equal(payload.schema, "send-runtime-preparation-result");
  assert.equal(payload.validator, "zod");
  assert.equal(payload.validationMode, "strict");
  assert.equal(payload.strict, true);
  assert.equal(payload.blocking, true);
  assert.equal(payload.traceId, "trace-zod-failed");
  assert.equal(payload.issueCount, 4);
  assert.deepEqual(payload.issueCodeCounts, { invalid_type: 3, invalid_value: 1 });
  assert.deepEqual(payload.issuePaths, ["workspaceId", "activeWorkspace", "recoveryAttempted", "reason"]);
  assert.deepEqual(payload.primaryIssue, {
    code: "invalid_type",
    expected: "string",
    received: null,
    message: "Invalid input: expected string, received undefined",
    path: "workspaceId",
  });
  assert.deepEqual((payload.payload as { keys?: string[]; keyCount?: number }), {
    valueType: "object",
    status: null,
    keys: ["ok", "runtimeReady", "managedAiReady"],
    keyCount: 3,
  });
});

test("send boundary classifier preserves the failing submit layer", () => {
  assert.equal(
    classifySendBoundaryFailurePhase({ schema: "send-runtime-preparation-result", phase: "runtime-preflight" }),
    "app-runtime-preflight",
  );
  assert.equal(
    classifySendBoundaryFailurePhase({
      event: "submitConversationFromVesloWriteApi:managed-ai-runtime-auth-prime:result",
      message: "Managed AI gateway authorization is not ready for this runtime.",
    }),
    "managed-ai-auth-prime",
  );
  assert.equal(
    classifySendBoundaryFailurePhase({
      code: "opencode_request_failed",
      debugTrace: [{ event: "server:conversation-submit:conversation-create-failed" }],
      message: "POST /workspace/ws-1/opencode/session returned 404",
    }),
    "server-session-create",
  );
  assert.equal(
    classifySendBoundaryFailurePhase({
      debugTrace: [{ event: "server:conversation-run:opencode-submit:error" }],
      message: "POST /workspace/ws-1/opencode/session/sess-1/prompt_async failed",
    }),
    "server-run-submit",
  );
  assert.equal(
    classifySendBoundaryFailurePhase({
      event: "server:conversation-run:queue-drain-scheduled",
      message: "queued behind active run",
    }),
    "queued-run-drain",
  );
});

test("session send workflow reports invalid runtime preflight contracts", async () => {
  const harness = createHarness({
    prepareSendRuntimeForSend: async () => ({
      ok: true,
      runtimeReady: true,
      managedAiReady: true,
    } as unknown as Awaited<ReturnType<ConversationRunCompatibilityBridgeOptions["prepareSendRuntimeForSend"]>>),
    submitConversationRunViaVesloWriteApi: async () => {
      throw new Error("compatibility run should not run after invalid preflight");
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("invalid preflight"), {
    clientMessageId: "client-invalid-preflight",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, false);
  assert.equal(sent.status, "blocked");
  assert.equal(sent.code, "conversation_run_prepare_blocked");
  assert.ok(harness.events.includes("sendPrompt:runtime-preflight:validation-failed"));
  assert.match(harness.errors.at(-1) ?? "", /send-runtime-preparation-result/);
  assert.ok(!harness.actions.some((action) => action.startsWith("run:")));
});

test("session send workflow can report invalid preflight contracts without blocking send", async () => {
  const harness = createHarness({
    prepareSendRuntimeForSend: async () => ({
      ok: true,
      runtimeReady: true,
      managedAiReady: true,
    } as unknown as Awaited<ReturnType<ConversationRunCompatibilityBridgeOptions["prepareSendRuntimeForSend"]>>),
    sendBoundaryValidationMode: () => "report",
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("report-only preflight"), {
    clientMessageId: "client-report-only-preflight",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, true);
  assert.ok(harness.events.includes("sendPrompt:runtime-preflight:validation-failed"));
  assert.ok(harness.actions.includes("run:sess-target"));
});

test("session send workflow can disable boundary validation reporting", async () => {
  const harness = createHarness({
    prepareSendRuntimeForSend: async () => ({
      ok: true,
      runtimeReady: true,
      managedAiReady: true,
    } as unknown as Awaited<ReturnType<ConversationRunCompatibilityBridgeOptions["prepareSendRuntimeForSend"]>>),
    sendBoundaryValidationMode: () => "off",
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("validation off preflight"), {
    clientMessageId: "client-validation-off-preflight",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, true);
  assert.equal(harness.events.includes("sendPrompt:runtime-preflight:validation-failed"), false);
  assert.ok(harness.actions.includes("run:sess-target"));
});

test("session send workflow strict validation blocks compatibility bridge prepare with missing workspace scope", async () => {
  const targetlessWorkspace = {
    activeWorkspaceDisplay: () => ({ workspaceType: "local" }),
    activeWorkspaceId: () => "",
    activeWorkspaceRoot: () => "",
    workspaces: () => [],
  };
  const harness = createHarness({
    resolveSendTargetWorkspaceScope: () => null,
    workspace: targetlessWorkspace,
    submitConversationRunViaVesloWriteApi: async () => {
      throw new Error("compatibility run should not run with invalid prepare scope");
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("missing workspace scope"), {
    clientMessageId: "client-missing-workspace-scope",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, false);
  assert.equal(sent.status, "blocked");
  assert.equal(sent.code, "conversation_run_prepare_blocked");
  assert.ok(harness.events.includes("sendPrompt:conversation-run-bridge-prepare-input:validation-failed"));
  assert.match(harness.errors.at(-1) ?? "", /conversation-run-bridge-prepare-input/);
  assert.ok(!harness.actions.some((action) => action.startsWith("run:")));
});

test("session send workflow report validation logs compatibility bridge prepare scope without blocking send", async () => {
  const targetlessWorkspace = {
    activeWorkspaceDisplay: () => ({ workspaceType: "local" }),
    activeWorkspaceId: () => "",
    activeWorkspaceRoot: () => "",
    workspaces: () => [],
  };
  const harness = createHarness({
    resolveSendTargetWorkspaceScope: () => null,
    sendBoundaryValidationMode: () => "report",
    workspace: targetlessWorkspace,
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("report missing workspace scope"), {
    clientMessageId: "client-report-missing-workspace-scope",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, true);
  assert.ok(harness.events.includes("sendPrompt:conversation-run-bridge-prepare-input:validation-failed"));
  assert.ok(harness.actions.includes("run:sess-target"));
});

test("session send workflow validates staged attachment shape before routing in strict mode", async () => {
  const harness = createHarness({
    routeStagedAttachmentsForModel: () => {
      throw new Error("routing should not run with invalid staged attachments");
    },
    stageAttachmentsIntoSessionDirectory: async () => [{
      name: "note.txt",
      kind: "file" as const,
      mimeType: "text/plain",
      relativePath: "",
      absolutePath: "",
    }],
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(attachmentDraft("invalid staged attachment"), {
    clientMessageId: "client-invalid-staged-attachment",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, false);
  assert.equal(sent.status, "blocked");
  assert.ok(harness.events.includes("sendPrompt:stage-attachments-result:validation-failed"));
  assert.ok(!harness.actions.some((action) => action.startsWith("run:")));
});

test("session send workflow can report malformed staged attachments without blocking routing", async () => {
  const harness = createHarness({
    sendBoundaryValidationMode: () => "report",
    stageAttachmentsIntoSessionDirectory: async () => [{
      name: "note.txt",
      kind: "file" as const,
      mimeType: "text/plain",
      relativePath: "",
      absolutePath: "",
    }],
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(attachmentDraft("report staged attachment"), {
    clientMessageId: "client-report-staged-attachment",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, true);
  assert.ok(harness.events.includes("sendPrompt:stage-attachments-result:validation-failed"));
  assert.ok(harness.actions.includes("run:sess-target"));
});

test("session send workflow keeps busy state and releases in-flight tracking when conversation run throws", async () => {
  const busyValues: boolean[] = [];
  const runSnapshots: Array<{
    sessionId: string;
    input: VesloConversationRunInput;
    inFlightCount: number;
    busy: boolean;
  }> = [];
  const harness = createHarness({
    resolveSendPromptBusyOwnership: () => ({ ownsBusy: true }),
    submitConversationRunViaVesloWriteApi: async (sessionId, input) => {
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

  assert.equal(sent.accepted, false);
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

test("session send workflow submits an existing local prompt through server submit without runtime prep", async () => {
  const submitCalls: Array<{
    workspaceId: string;
    directory: string;
    input: VesloConversationSubmitRequest;
    traceId?: string | null;
  }> = [];
  const harness = createHarness({
    listCommands: async () => {
      throw new Error("frontend command listing should not run for server submit");
    },
    prepareSendRuntimeForSend: async () => {
      throw new Error("runtime prep should not run for server submit");
    },
    submitConversationRunViaVesloWriteApi: async () => {
      throw new Error("compatibility run should not run for server submit");
    },
    resolveSelectedSessionBrowseScope: (sessionId) =>
      sessionId === "sess-target"
        ? {
            sessionId,
            workspaceId: "ws-active",
            workspaceRoot: "/active",
            directory: "/active",
            conversationId: "conv-target",
            opencodeSessionId: "open-target",
          }
        : null,
    submitConversationFromVesloWriteApi: async (workspaceId, directory, input, preflight) => {
      submitCalls.push({ workspaceId, directory, input, traceId: preflight?.traceId });
      return {
        status: "submitted",
        workspaceId,
        conversationId: "conv-target",
        opencodeSessionId: "open-target",
        runId: "run-submit",
        clientMessageId: input.clientMessageId,
        draftDisposition: "clear",
      };
    },
    vesloServerClient: () => ({
      resolveSkill: async () => {
        throw new Error("frontend skill resolution should not run for server submit");
      },
    }),
    vesloServerStatus: () => "connected",
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("server submit"), {
    clientMessageId: "client-server-submit",
    origin: "session:normal",
    source: "enter",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, true);
  assert.equal(submitCalls.length, 1);
  assert.deepEqual(submitCalls.map(({ workspaceId, directory, traceId }) => ({
    workspaceId,
    directory,
    traceId,
  })), [{
    workspaceId: "ws-active",
    directory: "/active",
    traceId: "trace-created",
  }]);
  assert.deepEqual(submitCalls[0]?.input, {
    clientMessageId: "client-server-submit",
    origin: "session:normal",
    source: "enter",
    target: {
      directory: "/active",
      conversationId: "conv-target",
      opencodeSessionId: "open-target",
    },
    draft: {
      mode: "prompt",
      text: "server submit",
      resolvedText: "server submit",
      parts: [{ type: "text", text: "server submit" }],
      command: null,
      attachments: [],
    },
    options: {
      agent: null,
      variant: null,
      submitQueuePolicy: "normal",
    },
  });
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing:start"));
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing-success"));
  assert.ok(harness.actions.includes(
    "admit:sess-target:ws-active:conv-target:open-target:run-submit:client-server-submit",
  ));
  assert.equal(harness.admittedRuns[0]?.diagnosticTraceId, "trace-created");
  assert.ok(!harness.actions.some((action) => action.startsWith("run:")));
});

test("session send workflow replays the same client id after a transport error", async () => {
  const clientMessageIds: string[] = [];
  let attempts = 0;
  const harness = createHarness({
    prepareSendRuntimeForSend: async () => {
      throw new Error("runtime prep should not run for server submit");
    },
    submitConversationRunViaVesloWriteApi: async () => {
      throw new Error("compatibility run should not run for server submit");
    },
    resolveSelectedSessionBrowseScope: (sessionId) => sessionId === "sess-target"
      ? {
          sessionId,
          workspaceId: "ws-active",
          workspaceRoot: "/active",
          directory: "/active",
          conversationId: "conv-target",
          opencodeSessionId: "open-target",
        }
      : null,
    submitConversationFromVesloWriteApi: async (workspaceId, _directory, input) => {
      attempts += 1;
      clientMessageIds.push(input.clientMessageId);
      if (attempts === 1) throw new Error("connection closed after dispatch");
      return {
        status: "submitted",
        workspaceId,
        conversationId: "conv-target",
        opencodeSessionId: "open-target",
        runId: "run-replayed",
        clientMessageId: input.clientMessageId,
        draftDisposition: "clear",
      };
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("replay transport"), {
    clientMessageId: "client-replay-same-id",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, true);
  assert.deepEqual(clientMessageIds, ["client-replay-same-id", "client-replay-same-id"]);
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing:replay-after-transport-error"));
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing-success"));
});

test("session send workflow blocks existing-session submit when scoped workspace activation reports missing scope", async () => {
  let submitCalls = 0;
  const harness = createHarness({
    ensureSelectedSessionWorkspaceActiveForSend: async () => false,
    resolveSelectedSessionBrowseScope: () => null,
    resolveSendTargetWorkspaceScope: () => null,
    submitConversationFromVesloWriteApi: async () => {
      submitCalls += 1;
      throw new Error("server submit should not run after scoped workspace block");
    },
    vesloServerStatus: () => "connected",
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("server submit"), {
    clientMessageId: "client-scope-block",
    origin: "session:normal",
    source: "enter",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, false);
  assert.equal(sent.code, "workspace_scope_unavailable");
  assert.equal(submitCalls, 0);
  assert.ok(harness.events.includes("sendPrompt:blocked-scoped-workspace"));
});

test("session send workflow reports invalid server submit result contracts", async () => {
  const appendedErrors: Array<{ sessionId: string; message: string }> = [];
  const harness = createHarness({
    prepareSendRuntimeForSend: async () => {
      throw new Error("runtime prep should not run after invalid server submit result");
    },
    submitConversationRunViaVesloWriteApi: async () => {
      throw new Error("compatibility run should not run after invalid server submit result");
    },
    resolveSelectedSessionBrowseScope: (sessionId) =>
      sessionId === "sess-target"
        ? {
            sessionId,
            workspaceId: "ws-active",
            workspaceRoot: "/active",
            directory: "/active",
            conversationId: "conv-target",
            opencodeSessionId: "open-target",
          }
        : null,
    sessionStoreAppendSessionErrorTurn: (sessionId, message) => {
      appendedErrors.push({ sessionId, message });
    },
    submitConversationFromVesloWriteApi: async (workspaceId, _directory, input) => ({
      status: "submitted",
      workspaceId,
      conversationId: "conv-target",
      opencodeSessionId: "open-target",
      clientMessageId: input.clientMessageId,
      draftDisposition: "clear",
    } as unknown as VesloConversationSubmitResult),
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("invalid submit result"), {
    clientMessageId: "client-invalid-submit-result",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, false);
  assert.equal(sent.status, "failed");
  assert.equal(sent.code, "server_submit_invalid_result");
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing-result:validation-failed"));
  assert.match(sent.message ?? "", /runId/);
  assert.match(harness.errors.at(-1) ?? "", /runId/);
  assert.equal(appendedErrors.length, 1);
  assert.ok(!harness.events.includes("sendPrompt:server-submit-existing-success"));
  assert.ok(!harness.actions.some((action) => action.startsWith("run:")));
});

test("session send workflow stages existing local attachments as server submit refs", async () => {
  const submitCalls: Array<{
    workspaceId: string;
    directory: string;
    input: VesloConversationSubmitRequest;
  }> = [];
  const stagedSessionIds: string[] = [];
  const attachmentDraft: ComposerDraft = {
    mode: "prompt",
    text: "review attachment",
    resolvedText: "review attachment",
    parts: [{ type: "text", text: "review attachment" }],
    attachments: [{
      id: "att-1",
      name: "brief.txt",
      kind: "file",
      mimeType: "text/plain",
      size: 5,
      dataUrl: "data:text/plain;base64,YnJpZWY=",
    }],
  };
  const harness = createHarness({
    buildCommandFileParts: () => {
      throw new Error("compatibility command file part construction should not run for server submit attachments");
    },
    buildPromptParts: () => {
      throw new Error("compatibility prompt part construction should not run for server submit attachments");
    },
    prepareSendRuntimeForSend: async () => {
      throw new Error("runtime prep should not run for server submit attachments");
    },
    routeStagedAttachmentsForModel: () => {
      throw new Error("compatibility attachment routing should not run for server submit attachments");
    },
    submitConversationRunViaVesloWriteApi: async () => {
      throw new Error("compatibility run should not run for server submit attachments");
    },
    resolveSelectedSessionBrowseScope: (sessionId) =>
      sessionId === "sess-target"
        ? {
            sessionId,
            workspaceId: "ws-active",
            workspaceRoot: "/active",
            directory: "/active",
            conversationId: "conv-target",
            opencodeSessionId: "open-target",
          }
        : null,
    stageAttachmentsIntoSessionDirectory: async (_draft, sessionId) => {
      stagedSessionIds.push(sessionId);
      return [{
        name: "brief.txt",
        kind: "file",
        mimeType: "text/plain",
        relativePath: "sessions/sess-target/brief.txt",
        absolutePath: "/active/sessions/sess-target/brief.txt",
      }];
    },
    submitConversationFromVesloWriteApi: async (workspaceId, directory, input) => {
      submitCalls.push({ workspaceId, directory, input });
      return {
        status: "submitted",
        workspaceId,
        conversationId: "conv-target",
        opencodeSessionId: "open-target",
        runId: "run-submit-attachment",
        clientMessageId: input.clientMessageId,
        draftDisposition: "clear",
      };
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(attachmentDraft, {
    clientMessageId: "client-server-submit-attachment",
    origin: "session:normal",
    source: "enter",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, true);
  assert.deepEqual(stagedSessionIds, ["sess-target"]);
  assert.equal(submitCalls.length, 1);
  assert.deepEqual(submitCalls[0]?.input.draft.attachments, [{
    name: "brief.txt",
    kind: "file",
    mimeType: "text/plain",
    dataUrl: "data:text/plain;base64,YnJpZWY=",
    fileSessionPath: "sessions/sess-target/brief.txt",
  }]);
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing-stage-attachments"));
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing-success"));
  assert.ok(!harness.actions.some((action) => action.startsWith("run:")));
});

test("session send workflow submits existing local compact through server submit", async () => {
  const submitCalls: Array<{
    workspaceId: string;
    directory: string;
    input: VesloConversationSubmitRequest;
  }> = [];
  const lastPromptSends: string[] = [];
  const harness = createHarness({
    submitCurrentSessionCompaction: async () => {
      throw new Error("compatibility compact should not run for server submit");
    },
    messages: () => [{ parts: [{ type: "text", text: "already here" }] }],
    prepareSendRuntimeForSend: async () => {
      throw new Error("runtime prep should not run for server compact submit");
    },
    submitConversationRunViaVesloWriteApi: async () => {
      throw new Error("compatibility run should not run for server compact submit");
    },
    resolveSelectedSessionBrowseScope: (sessionId) =>
      sessionId === "sess-target"
        ? {
            sessionId,
            workspaceId: "ws-active",
            workspaceRoot: "/active",
            directory: "/active",
            conversationId: "conv-target",
            opencodeSessionId: "open-target",
          }
        : null,
    setLastPromptSent: (value) => {
      lastPromptSends.push(value);
    },
    submitConversationFromVesloWriteApi: async (workspaceId, directory, input) => {
      submitCalls.push({ workspaceId, directory, input });
      return {
        status: "submitted",
        workspaceId,
        conversationId: "conv-target",
        opencodeSessionId: "open-target",
        runId: "run-compact",
        clientMessageId: input.clientMessageId,
        draftDisposition: "clear",
      };
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(compactDraft(), {
    clientMessageId: "client-server-compact",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, true);
  assert.equal(submitCalls.length, 1);
  assert.deepEqual(submitCalls.map(({ workspaceId, directory }) => ({ workspaceId, directory })), [{
    workspaceId: "ws-active",
    directory: "/active",
  }]);
  assert.deepEqual(submitCalls[0]?.input.draft, {
    mode: "prompt",
    text: "/compact",
    resolvedText: "/compact",
    parts: [{ type: "text", text: "/compact" }],
    command: { name: "compact", arguments: "" },
    attachments: [],
  });
  assert.equal(submitCalls[0]?.input.options?.submitQueuePolicy, "normal");
  assert.deepEqual(lastPromptSends, []);
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing:start"));
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing-success"));
  assert.ok(harness.events.includes("sendPrompt:compact-success"));
  assert.ok(!harness.actions.includes("compact"));
  assert.ok(!harness.actions.some((action) => action.startsWith("run:")));
  assert.equal(harness.liveTranscriptPolicyEvents.at(-1)?.type, "conversation-compact.succeeded");
  assert.equal(harness.liveTranscriptPolicyEvents.at(-1)?.reason, "sendPrompt:compact-success");
});

test("session send workflow handles queued server submit results for send-now", async () => {
  const submitCalls: Array<{
    workspaceId: string;
    directory: string;
    input: VesloConversationSubmitRequest;
  }> = [];
  const harness = createHarness({
    prepareSendRuntimeForSend: async () => {
      throw new Error("runtime prep should not run for queued server submit");
    },
    submitConversationRunViaVesloWriteApi: async () => {
      throw new Error("compatibility run should not run for queued server submit");
    },
    resolveSelectedSessionBrowseScope: (sessionId) =>
      sessionId === "sess-target"
        ? {
            sessionId,
            workspaceId: "ws-active",
            workspaceRoot: "/active",
            directory: "/active",
            conversationId: "conv-target",
            opencodeSessionId: "open-target",
          }
        : null,
    submitConversationFromVesloWriteApi: async (workspaceId, directory, input) => {
      submitCalls.push({ workspaceId, directory, input });
      return {
        status: "queued",
        workspaceId,
        conversationId: "conv-target",
        opencodeSessionId: "open-target",
        queueItemId: "queue-submit",
        reservedRunId: "run-reserved",
        queuePosition: 1,
        clientMessageId: input.clientMessageId,
        draftDisposition: "clear",
      };
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("server queued"), {
    clientMessageId: "client-server-queued",
    origin: "session:send-now",
    source: "send-now",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, true);
  assert.equal(sent.status, "queued");
  assert.equal(sent.queueItemId, "queue-submit");
  assert.equal(sent.reservedRunId, "run-reserved");
  assert.equal(submitCalls.length, 1);
  assert.equal(submitCalls[0]?.input.options?.submitQueuePolicy, "send-now");
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing:start"));
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing-success"));
  assert.ok(harness.actions.includes("hold:sess-target:sendPrompt:server-submit-existing-success"));
  assert.ok(!harness.actions.some((action) => action.startsWith("run:")));
  const queuedEvent = harness.liveTranscriptPolicyEvents.at(-1);
  assert.equal(queuedEvent?.type, "conversation-run.queued");
  assert.equal(queuedEvent?.reason, "sendPrompt:queued");
  assert.equal(queuedEvent?.type === "conversation-run.queued" ? queuedEvent.queueItemId : null, "queue-submit");
});

test("session send workflow does not clear the active composer for explicit server submit drafts", async () => {
  const submitCalls: VesloConversationSubmitRequest[] = [];
  const lastPromptSends: string[] = [];
  const promptWrites: string[] = [];
  const harness = createHarness({
    prepareSendRuntimeForSend: async () => {
      throw new Error("runtime prep should not run for explicit server submit");
    },
    submitConversationRunViaVesloWriteApi: async () => {
      throw new Error("compatibility run should not run for explicit server submit");
    },
    resolveSelectedSessionBrowseScope: (sessionId) =>
      sessionId === "sess-target"
        ? {
            sessionId,
            workspaceId: "ws-active",
            workspaceRoot: "/active",
            directory: "/active",
            conversationId: "conv-target",
            opencodeSessionId: "open-target",
          }
        : null,
    setLastPromptSent: (value) => {
      lastPromptSends.push(value);
    },
    setPrompt: (value) => {
      promptWrites.push(value);
    },
    submitConversationFromVesloWriteApi: async (_workspaceId, _directory, input) => {
      submitCalls.push(input);
      return {
        status: "submitted",
        workspaceId: "ws-active",
        conversationId: "conv-target",
        opencodeSessionId: "open-target",
        runId: "run-explicit-draft",
        clientMessageId: input.clientMessageId,
        draftDisposition: "clear",
      };
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("explicit draft"), {
    clientMessageId: "client-server-explicit-draft",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, true);
  assert.equal(submitCalls.length, 1);
  assert.deepEqual(lastPromptSends, ["explicit draft"]);
  assert.deepEqual(promptWrites, []);
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing-success"));
});

test("session send workflow reports failed server submit into the visible transcript", async () => {
  const appendedErrors: Array<{ sessionId: string; message: string }> = [];
  const harness = createHarness({
    addOpencodeCacheHint: (message) => `${message} Clear the OpenCode cache and retry.`,
    prepareSendRuntimeForSend: async () => {
      throw new Error("runtime prep should not run after failed server submit");
    },
    submitConversationRunViaVesloWriteApi: async () => {
      throw new Error("compatibility run should not run after failed server submit");
    },
    resolveSelectedSessionBrowseScope: (sessionId) =>
      sessionId === "sess-target"
        ? {
            sessionId,
            workspaceId: "ws-active",
            workspaceRoot: "/active",
            directory: "/active",
            conversationId: "conv-target",
            opencodeSessionId: "open-target",
          }
        : null,
    sessionStoreAppendSessionErrorTurn: (sessionId, message) => {
      appendedErrors.push({ sessionId, message });
    },
    submitConversationFromVesloWriteApi: async (_workspaceId, _directory, input) => ({
      status: "failed",
      code: "run_submit_failed",
      message: `Submit failed for ${input.clientMessageId}`,
      queueItemId: "queue-failed",
      reservedRunId: "run-failed",
      draftDisposition: "restore",
      debugTrace: [{ source: "server", event: "run_submit_failed" }],
    }),
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("server failure"), {
    clientMessageId: "client-server-failed",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, false);
  assert.equal(sent.queueItemId, "queue-failed");
  assert.equal(sent.reservedRunId, "run-failed");
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing-failed"));
  assert.match(harness.errors.at(-1) ?? "", /Clear the OpenCode cache/);
  assert.deepEqual(appendedErrors, [{
    sessionId: "sess-target",
    message: "Submit failed for client-server-failed Clear the OpenCode cache and retry.",
  }]);
  assert.ok(!harness.actions.some((action) => action.startsWith("run:")));
});

test("session send workflow reports remote server-submit blocks without compatibility run", async () => {
  const submitCalls: VesloConversationSubmitRequest[] = [];
  const harness = createHarness({
    prepareSendRuntimeForSend: async () => {
      throw new Error("runtime prep should not run for remote server submit");
    },
    resolveSelectedSessionBrowseScope: (sessionId) =>
      sessionId === "sess-remote"
        ? {
            sessionId,
            workspaceId: "ws-remote",
            workspaceRoot: "/remote",
            directory: "/remote",
            conversationId: "conv-remote",
            opencodeSessionId: "open-remote",
          }
        : null,
    resolveSendTargetWorkspaceScope: () => ({
      workspaceId: "ws-remote",
      workspaceRoot: "/remote",
      directory: "/remote",
    }),
    submitConversationRunViaVesloWriteApi: async () => {
      throw new Error("compatibility run should not run for remote server submit block");
    },
    submitConversationFromVesloWriteApi: async (_workspaceId, _directory, input) => {
      submitCalls.push(input);
      return {
        status: "blocked",
        code: "remote_submit_unavailable",
        message: "Remote workspace submit is not available through the local server.",
        draftDisposition: "restore",
        recoverable: false,
      };
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("remote submit"), {
    clientMessageId: "client-remote-submit",
    origin: "session:normal",
    targetSessionId: "sess-remote",
  });

  assert.equal(sent.accepted, false);
  assert.equal(submitCalls.length, 1);
  assert.equal(submitCalls[0]?.target?.conversationId, "conv-remote");
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing-blocked"));
  assert.match(harness.errors.at(-1) ?? "", /Remote workspace submit/);
});

test("session send workflow blocks compatibility run when server submit is unavailable", async () => {
  const submitCalls: VesloConversationSubmitRequest[] = [];
  const prepareCalls: string[] = [];
  const harness = createHarness({
    prepareSendRuntimeForSend: async (reason) => {
      prepareCalls.push(reason);
      return {
        ok: true,
        runtimeReady: true,
        managedAiReady: true,
        workspaceId: "ws-active",
        activeWorkspace: true,
        recoveryAttempted: false,
        reason: "runtime-health-ok",
      };
    },
    resolveSelectedSessionBrowseScope: (sessionId) =>
      sessionId === "sess-target"
        ? {
            sessionId,
            workspaceId: "ws-active",
            workspaceRoot: "/active",
            directory: "/active",
            conversationId: "conv-target",
            opencodeSessionId: "open-target",
          }
        : null,
    submitConversationFromVesloWriteApi: async (_workspaceId, _directory, input) => {
      submitCalls.push(input);
      return null;
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("compatibility bridge"), {
    clientMessageId: "client-server-unavailable",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, false);
  assert.equal(submitCalls.length, 1);
  assert.deepEqual(prepareCalls, []);
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing-unavailable"));
  assert.ok(!harness.actions.some((action) => action.startsWith("run:")));
  assert.match(harness.errors.at(-1) ?? "", /Server-owned conversation submit is unavailable/);
});

test("session send workflow blocks compatibility run when server submit target is missing", async () => {
  const harness = createHarness({
    prepareSendRuntimeForSend: async () => {
      throw new Error("compatibility runtime prep should not run after server target resolution failed");
    },
    resolveSendTargetWorkspaceScope: () => ({
      workspaceId: "",
      workspaceRoot: "",
      directory: "",
    }),
    submitConversationRunViaVesloWriteApi: async () => {
      throw new Error("compatibility run should not run after server target resolution failed");
    },
    submitConversationFromVesloWriteApi: async () => {
      throw new Error("server submit should not be called without a workspace and directory");
    },
    workspace: {
      activeWorkspaceDisplay: () => ({ workspaceType: "local" }),
      activeWorkspaceId: () => "",
      activeWorkspaceRoot: () => "",
      workspaces: () => [],
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("missing target"), {
    clientMessageId: "client-server-missing-target",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, false);
  assert.ok(harness.events.includes("sendPrompt:maybe-resolve-skill-command:server-owned-skip"));
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing-missing-target"));
  assert.ok(!harness.actions.some((action) => action.startsWith("run:")));
  assert.match(harness.errors.at(-1) ?? "", /missing a workspace or directory/);
});

test("session send workflow blocks first-session compatibility run when server submit materialization is unavailable", async () => {
  const createOptions: Array<Parameters<SessionSendWorkflowOptions["createSessionAndOpen"]>[1]> = [];
  const runInputs: VesloConversationRunInput[] = [];
  const harness = createHarness({
    createSessionAndOpen: async (_initialTitle, options) => {
      createOptions.push(options);
      harness.actions.push("create-session");
      return "sess-created";
    },
    listCommands: async () => {
      throw new Error("frontend command listing should not run for server-owned materialization");
    },
    submitConversationRunViaVesloWriteApi: async (_sessionId, input) => {
      runInputs.push(input);
      return true;
    },
    submitConversationFromVesloWriteApi: async () => null,
    vesloServerClient: () => ({
      resolveSkill: async () => {
        throw new Error("frontend skill resolution should not run for server-owned materialization");
      },
    }),
    vesloServerStatus: () => "connected",
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("use company search skill"), {
    clientMessageId: "client-server-materialize-skill",
    origin: "session:normal",
    source: "enter",
  });

  assert.equal(sent.accepted, false);
  assert.equal(createOptions.length, 1);
  assert.deepEqual(createOptions[0]?.submitDraft, {
    mode: "prompt",
    text: "use company search skill",
    resolvedText: "use company search skill",
    parts: [{ type: "text", text: "use company search skill" }],
    command: null,
    attachments: [],
  });
  assert.equal(runInputs.length, 0);
  assert.ok(harness.events.includes("sendPrompt:maybe-resolve-skill-command:server-owned-skip"));
  assert.ok(harness.events.includes("sendPrompt:server-submit-first-missing-result"));
  assert.match(harness.errors.at(-1) ?? "", /did not return a queued or submitted result/);
});

test("session send workflow accepts first-session server submit results without compatibility run", async () => {
  const createOptions: Array<Parameters<SessionSendWorkflowOptions["createSessionAndOpen"]>[1]> = [];
  const composerDraftCleanupCalls: string[] = [];
  const harness = createHarness({
    activePendingDraftKey: () => "pending-draft:first-submit",
    activePendingDraftMeta: () => ({ id: "pending-id-first-submit" }),
    createSessionAndOpen: async (_initialTitle, options) => {
      createOptions.push(options);
      options?.onSubmitResult?.({
        status: "submitted",
        workspaceId: "ws-active",
        conversationId: "conv-created",
        opencodeSessionId: "sess-created",
        runId: "run-created",
        clientMessageId: "client-first-server-submit",
        materializedSession: {
          id: "sess-created",
          conversationId: "conv-created",
          opencodeSessionId: "sess-created",
        },
        draftDisposition: "clear",
      });
      harness.actions.push("create-session");
      return "sess-created";
    },
    prepareSendRuntimeForSend: async () => {
      throw new Error("runtime prep should not run before first-session server submit");
    },
    routedClientForSendTarget: () => {
      throw new Error("routed client should not be required before first-session server submit");
    },
    submitConversationRunViaVesloWriteApi: async () => {
      throw new Error("compatibility run should not run after first-session server submit");
    },
    selectedSessionId: () => null,
    setComposerDraftBySessionId: (updater) => {
      composerDraftCleanupCalls.push("cleanup");
      updater({});
    },
    submitConversationFromVesloWriteApi: async () => null,
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("first server submit"), {
    clientMessageId: "client-first-server-submit",
    origin: "session:normal",
    source: "enter",
  });

  assert.equal(sent.accepted, true);
  assert.equal(createOptions[0]?.submitDraft?.text, "first server submit");
  assert.ok(harness.events.includes("sendPrompt:server-submit-first-success"));
  assert.equal(harness.liveTranscriptPolicyEvents.at(-1)?.reason, "sendPrompt:success");
  assert.ok(harness.actions.includes(
    "admit:sess-created:ws-active:conv-created:sess-created:run-created:client-first-server-submit",
  ));
  assert.equal(harness.admittedRuns[0]?.diagnosticTraceId, "trace-created");
  assert.ok(harness.actions.includes("clear-pending-draft"));
  assert.ok(harness.actions.includes("refresh-pending-drafts"));
  assert.deepEqual(composerDraftCleanupCalls, ["cleanup"]);
  assert.ok(!harness.actions.some((action) => action.startsWith("run:")));
});

test("session send workflow emits queued event for first-session queued submit results", async () => {
  const harness = createHarness({
    createSessionAndOpen: async (_initialTitle, options) => {
      options?.onSubmitResult?.({
        status: "queued",
        workspaceId: "ws-active",
        conversationId: "conv-created",
        opencodeSessionId: "sess-created",
        queueItemId: "queue-created",
        reservedRunId: "run-reserved-created",
        queuePosition: 1,
        clientMessageId: "client-first-server-queued",
        materializedSession: {
          id: "sess-created",
          conversationId: "conv-created",
          opencodeSessionId: "sess-created",
        },
        draftDisposition: "clear",
      });
      harness.actions.push("create-session");
      return "sess-created";
    },
    prepareSendRuntimeForSend: async () => {
      throw new Error("runtime prep should not run before first-session queued server submit");
    },
    submitConversationRunViaVesloWriteApi: async () => {
      throw new Error("compatibility run should not run after first-session queued server submit");
    },
    selectedSessionId: () => null,
    submitConversationFromVesloWriteApi: async () => null,
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("first server queued"), {
    clientMessageId: "client-first-server-queued",
    origin: "session:normal",
    source: "enter",
  });

  assert.equal(sent.accepted, true);
  assert.equal(sent.status, "queued");
  assert.equal(sent.queueItemId, "queue-created");
  const queuedEvent = harness.liveTranscriptPolicyEvents.at(-1);
  assert.equal(queuedEvent?.type, "conversation-run.queued");
  assert.equal(queuedEvent?.reason, "sendPrompt:queued");
  assert.equal(queuedEvent?.type === "conversation-run.queued" ? queuedEvent.queueItemId : null, "queue-created");
  assert.ok(!harness.actions.some((action) => action.startsWith("admit:")));
  assert.ok(!harness.actions.some((action) => action.startsWith("run:")));
});

test("session send workflow preserves pre-materialized first-session terminal submit results", async () => {
  const scenarios: Array<{
    name: string;
    result: Extract<VesloConversationSubmitResult, { status: "blocked" | "failed" }>;
  }> = [
    {
      name: "blocked",
      result: {
        status: "blocked",
        code: "remote_submit_unavailable",
        message: "Server-owned submit is not available for remote workspaces yet",
        workspaceId: "ws-remote",
        clientMessageId: "client-first-blocked",
        draftDisposition: "restore",
        recoverable: true,
      },
    },
    {
      name: "failed",
      result: {
        status: "failed",
        code: "conversation_create_failed",
        message: "Conversation creation failed",
        clientMessageId: "client-first-failed-before-session",
        draftDisposition: "restore",
        debugTrace: [{ source: "server", event: "conversation_create_failed" }],
      },
    },
  ];

  for (const scenario of scenarios) {
    const createOptions: Array<Parameters<SessionSendWorkflowOptions["createSessionAndOpen"]>[1]> = [];
    const harness = createHarness({
      createSessionAndOpen: async (_initialTitle, options) => {
        createOptions.push(options);
        options?.onSubmitResult?.(scenario.result);
        harness.actions.push(`create-session:${scenario.name}`);
        return undefined;
      },
      prepareSendRuntimeForSend: async () => {
        throw new Error("runtime prep should not run before first-session terminal server submit");
      },
      submitConversationRunViaVesloWriteApi: async () => {
        throw new Error("compatibility run should not run after first-session terminal server submit");
      },
      selectedSessionId: () => null,
      submitConversationFromVesloWriteApi: async () => null,
    });
    const workflow = createSessionSendWorkflow(harness.options);

    const sent = await workflow.sendPrompt(promptDraft(`first server ${scenario.name}`), {
      clientMessageId: scenario.result.clientMessageId ?? `client-first-${scenario.name}`,
      origin: "session:normal",
      source: "enter",
    });

    assert.equal(createOptions.length, 1);
    assert.equal(sent.accepted, false);
    assert.equal(sent.status, scenario.result.status);
    assert.equal(sent.code, scenario.result.code);
    assert.equal(sent.message, scenario.result.message);
    assert.equal(sent.draftDisposition, scenario.result.draftDisposition);
    assert.ok(harness.events.includes("sendPrompt:server-submit-first-failed"));
    assert.equal(harness.events.includes("sendPrompt:blocked-no-session"), false);
    assert.ok(!harness.actions.some((action) => action.startsWith("run:")));
  }
});

test("session send workflow opens first materialized session and reports failed server submit", async () => {
  const createOptions: Array<Parameters<SessionSendWorkflowOptions["createSessionAndOpen"]>[1]> = [];
  const pendingDraftMeta = { id: "pending-id-first-failed", title: "hello" };
  let activePendingDraftKey: string | null = "pending-draft:first-failed";
  let activePendingDraftMeta: typeof pendingDraftMeta | null = pendingDraftMeta;
  const harness = createHarness({
    activePendingDraftKey: () => activePendingDraftKey,
    activePendingDraftMeta: () => activePendingDraftMeta,
    addOpencodeCacheHint: (message) => `${message} Clear the OpenCode cache and retry.`,
    createSessionAndOpen: async (_initialTitle, options) => {
      createOptions.push(options);
      options?.onSubmitResult?.({
        status: "failed",
        code: "opencode_proxy_failed",
        message: "OpenCode prompt failed",
        workspaceId: "ws-main",
        conversationId: "conv-first-failed",
        opencodeSessionId: "open-first-failed",
        clientMessageId: "client-first-failed",
        materializedSession: {
          id: "sess-first-failed",
          title: "hello",
          conversationId: "conv-first-failed",
          opencodeSessionId: "open-first-failed",
        },
        draftDisposition: "restore",
        debugTrace: [{ source: "server", event: "run_submit_failed_after_materialization" }],
      });
      return "sess-first-failed";
    },
    clearActivePendingDraftState: () => {
      activePendingDraftKey = "";
      activePendingDraftMeta = null;
      harness.actions.push("clear-pending-draft");
    },
    sessionStoreAppendSessionErrorTurn: (sessionId, message) => {
      harness.actions.push(`append-error:${sessionId}:${message}`);
    },
    setActivePendingDraftKey: (key) => {
      activePendingDraftKey = key;
      harness.actions.push(`set-active-pending-draft-key:${key}`);
    },
    setActivePendingDraftMeta: (meta) => {
      const nextMeta = meta as typeof pendingDraftMeta | null;
      activePendingDraftMeta = nextMeta;
      harness.actions.push(`set-active-pending-draft-meta:${nextMeta?.id ?? "null"}`);
    },
    setComposerDraftBySessionId: (updater) => {
      harness.actions.push("set-composer-draft-by-session");
      updater({});
    },
    setView: (view) => {
      harness.actions.push(`set-view:${view}`);
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const accepted = await workflow.sendPrompt(promptDraft("hello"), {
    clientMessageId: "client-first-failed",
    origin: "session:normal",
    source: "enter",
  });

  assert.equal(accepted.accepted, false);
  assert.equal(createOptions.length, 1);
  assert.ok(harness.events.includes("sendPrompt:server-submit-first-failed"));
  assert.deepEqual(harness.errors, ["OpenCode prompt failed Clear the OpenCode cache and retry."]);
  assert.ok(harness.actions.includes("append-error:sess-first-failed:OpenCode prompt failed Clear the OpenCode cache and retry."));
  assert.equal(activePendingDraftKey, "pending-draft:first-failed");
  assert.deepEqual(activePendingDraftMeta, pendingDraftMeta);
  assert.doesNotMatch(
    harness.actions.join("\n"),
    /clear-pending-draft|refresh-pending-drafts|mark-consumed:|clear-consumed:|set-active-pending-draft-key:|set-active-pending-draft-meta:|set-composer-draft-by-session|set-view:/,
  );
  assert.doesNotMatch(harness.actions.join("\n"), /run:/);
});

test("abortSession blocks abort when workspace scope is missing", async () => {
  const abortCalls: string[] = [];
  const conversationAbortCalls: string[] = [];
  const harness = createHarness({
    abortConversationFromVesloWriteApi: async (sessionId) => {
      conversationAbortCalls.push(sessionId);
      return null;
    },
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
  assert.deepEqual(conversationAbortCalls, []);
  assert.ok(harness.events.includes("abortSession:abort-blocked-missing-workspace-scope"));
  assert.match(harness.errors.at(-1) ?? "", /workspace scope is missing/);
});

test("abortSession preserves a resolved scoped abort when selected scope lookup is missing", async () => {
  const abortCalls: Array<{ sessionId: string; target?: unknown }> = [];
  const harness = createHarness({
    abortConversationFromVesloWriteApi: async (sessionId, target) => {
      abortCalls.push({ sessionId, target });
      return null;
    },
    abortSessionTyped: async () => {
      throw new Error("compatibility abort should not run for scoped server abort");
    },
    routedClient: () => ({} as Client),
    resolveSelectedSessionBrowseScope: () => null,
    resolveConversationAbortScope: (sessionId) => ({
      sessionId,
      workspaceId: "ws-active",
      workspaceRoot: "/active",
      directory: "/active",
      hasConversationScope: true,
      conversationId: "conv-scoped",
      opencodeSessionId: "open-scoped",
    }),
  });
  const workflow = createSessionSendWorkflow(harness.options);

  await workflow.abortSession("open-scoped");

  assert.deepEqual(abortCalls.map((call) => call.sessionId), ["open-scoped"]);
  assert.equal(harness.events.includes("abortSession:abort-blocked-missing-workspace-scope"), false);
  assert.ok(harness.events.includes("abortSession:conversation-abort-unavailable"));
  assert.ok(harness.events.includes("abortSession:conversation-abort-blocked-unavailable"));
  assert.match(harness.errors.at(-1) ?? "", /Conversation service is unavailable/);
});

test("abortSession permits an explicit scoped abort for a foreign workspace", async () => {
  const abortCalls: string[] = [];
  const conversationAbortCalls: Array<{ sessionId: string; target?: unknown }> = [];
  const harness = createHarness({
    abortConversationFromVesloWriteApi: async (sessionId, target) => {
      conversationAbortCalls.push({ sessionId, target });
      return null;
    },
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

  const target = {
    workspaceId: "ws-foreign",
    workspaceRoot: "/foreign",
    directory: "/foreign",
    conversationId: "conv-foreign",
    opencodeSessionId: "open-foreign",
  };
  await workflow.abortSession("sess-foreign", target);

  assert.deepEqual(abortCalls, []);
  assert.deepEqual(conversationAbortCalls, [{ sessionId: "sess-foreign", target }]);
  assert.equal(harness.events.includes("abortSession:abort-blocked-missing-workspace-scope"), false);
  assert.ok(harness.events.includes("abortSession:conversation-abort-unavailable"));
  assert.ok(harness.events.includes("abortSession:conversation-abort-blocked-unavailable"));
});

test("abortSession blocks scoped abort when server abort is unavailable", async () => {
  const abortCalls: string[] = [];
  const harness = createHarness({
    abortConversationFromVesloWriteApi: async () => null,
    abortSessionTyped: async (_client, sessionId) => {
      abortCalls.push(sessionId);
    },
    routedClient: () => ({} as Client),
    resolveSelectedSessionBrowseScope: () => ({
      workspaceId: "ws-active",
      workspaceRoot: "/active",
      directory: "/active",
      conversationId: "conv-scoped",
      opencodeSessionId: "open-scoped",
    }),
    resolveConversationAbortScope: (sessionId) => ({
      sessionId,
      workspaceId: "ws-active",
      workspaceRoot: "/active",
      directory: "/active",
      hasConversationScope: true,
      conversationId: "conv-scoped",
      opencodeSessionId: "open-scoped",
    }),
  });
  const workflow = createSessionSendWorkflow(harness.options);

  await workflow.abortSession("conv-scoped");

  assert.deepEqual(abortCalls, []);
  assert.ok(harness.events.includes("abortSession:conversation-abort-unavailable"));
  assert.ok(harness.events.includes("abortSession:conversation-abort-blocked-unavailable"));
  assert.match(harness.errors.at(-1) ?? "", /Conversation service is unavailable/);
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
    submitConversationRunViaVesloWriteApi: async (_sessionId, input, options) => {
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

  assert.equal(sent.accepted, true);
  assert.deepEqual(runCalls.map((call) => call.clientMessageId), [
    "client-runtime-retry",
    "client-runtime-retry",
  ]);
  assert.deepEqual(prepareForceRecoveryValues, [undefined, true]);
  assert.equal(runCalls[1]?.forceRecovery, false);
  assert.ok(harness.events.includes("sendPrompt:conversation-run-runtime-recovery-start"));
  assert.ok(harness.events.includes("sendPrompt:conversation-run-runtime-recovery-result"));
});

test("session send workflow recovers a stale local Veslo bearer during conversation run", async () => {
  const runCalls: Array<{ clientMessageId?: string | null; forceRecovery?: boolean }> = [];
  const prepareReasons: string[] = [];
  const harness = createHarness({
    prepareSendRuntimeForSend: async (_event, preflight) => {
      prepareReasons.push(preflight.forceRecovery === true ? "forced" : "normal");
      if (preflight.forceRecovery) preflight.forceRecovery = false;
      return {
        ok: true,
        runtimeReady: true,
        managedAiReady: true,
        workspaceId: "ws-active",
        activeWorkspace: true,
        recoveryAttempted: prepareReasons.at(-1) === "forced",
        reason: prepareReasons.at(-1) === "forced" ? "runtime-recovery-ok" : "runtime-health-ok",
      };
    },
    submitConversationRunViaVesloWriteApi: async (_sessionId, input, options) => {
      runCalls.push({
        clientMessageId: input.clientMessageId,
        forceRecovery: options?.preflight?.forceRecovery,
      });
      if (runCalls.length === 1) {
        throw new Error('{"code":"unauthorized","message":"Invalid bearer token"}');
      }
      return true;
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("stale local bearer"), {
    clientMessageId: "client-invalid-bearer",
    origin: "session:normal",
  });

  assert.equal(sent.accepted, true);
  assert.deepEqual(runCalls.map((call) => call.clientMessageId), [
    "client-invalid-bearer",
    "client-invalid-bearer",
  ]);
  assert.deepEqual(prepareReasons, ["normal", "forced"]);
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

  assert.equal(sent.accepted, true);
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

  assert.equal(sent.accepted, true);
  assert.deepEqual(harness.liveReadAllowedWorkspaceIds, ["ws-send-target"]);
  assert.deepEqual(harness.liveTranscriptPolicyEvents.map((event) => event.reason), ["sendPrompt:success"]);
});

test("session send workflow omits a model override from first server submit", async () => {
  const modelSessionIds: Array<string | null | undefined> = [];
  const createOptions: Array<Parameters<SessionSendWorkflowOptions["createSessionAndOpen"]>[1]> = [];
  const harness = createHarness({
    createSessionAndOpen: async (_initialTitle, options) => {
      createOptions.push(options);
      options?.onSubmitResult?.({
        status: "submitted",
        workspaceId: "ws-active",
        conversationId: "conv-created",
        opencodeSessionId: "sess-created",
        runId: "run-created-model",
        clientMessageId: "client-created-model",
        materializedSession: {
          id: "sess-created",
          conversationId: "conv-created",
          opencodeSessionId: "sess-created",
        },
        draftDisposition: "clear",
      });
      harness.actions.push("create-session");
      return "sess-created";
    },
    modelForSession: (sessionId) => {
      modelSessionIds.push(sessionId);
      return {
        providerID: "openai",
        modelID: sessionId === "sess-created" ? "gpt-4.1" : "gpt-4.1-default",
      };
    },
    submitConversationRunViaVesloWriteApi: async () => {
      throw new Error("compatibility run should not run after first server submit");
    },
    submitConversationFromVesloWriteApi: async () => null,
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("create then send"), {
    clientMessageId: "client-created-model",
    origin: "session:normal",
  });

  assert.equal(sent.accepted, true);
  assert.deepEqual(modelSessionIds, []);
  assert.equal(createOptions[0]?.submitOptions?.model, undefined);
  assert.equal(createOptions[0]?.clientMessageId, "client-created-model");
  assert.equal(createOptions[0]?.submitOrigin, "session:normal");
  assert.equal(createOptions[0]?.submitDraft?.mode, "prompt");
  assert.equal(createOptions[0]?.submitDraft?.text, "create then send");
  assert.ok(harness.actions.includes("create-session"));
  assert.ok(!harness.actions.some((action) => action.startsWith("run:")));
});

test("session send workflow uses OpenCode variant instead of raw reasoning effort for codex oauth", async () => {
  const runInputs: Array<{ sessionId: string; input: VesloConversationRunInput }> = [];
  const harness = createHarness({
    modelForSession: () => ({
      providerID: "codex_oauth",
      modelID: "gpt-5.5",
    }),
    modelVariant: () => "xhigh",
    submitConversationRunViaVesloWriteApi: async (sessionId, input) => {
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

  assert.equal(sent.accepted, true);
  assert.equal(runInputs.length, 1);
  const input = runInputs[0]?.input;
  assert.equal(input?.kind, "prompt_async");
  assert.equal(input?.model, undefined);
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

  assert.equal(sent.accepted, true);
  assert.ok(!harness.actions.includes("create-session"));
  assert.ok(harness.actions.includes("run:sess-target"));
});
