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
import { ConversationServerSubmitPreflightError } from "../../context/conversation-service.js";
import { VesloServerError } from "../../lib/veslo-server.js";
import type { VesloConversationSubmitRequest, VesloConversationSubmitResult } from "../../lib/veslo-server.js";
import { classifySendBoundaryFailurePhase, resolveSendBoundaryValidationMode } from "../../lib/send-boundary-validation.js";
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

function missingLiveBindingPreflightError(): ConversationServerSubmitPreflightError {
  return new ConversationServerSubmitPreflightError("Local OpenCode runtime binding is unavailable for this server submit.", {
    code: "local_live_binding_unavailable",
    httpAttempted: false,
  });
}

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

function documentRuntimePayload(status: DocumentRuntimeStatusPayload["status"]): DocumentRuntimeStatusPayload {
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
      progress: null,
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

  const options: SessionSendWorkflowOptions = {
    admitAcceptedConversationRun: (input: AdmittedRunInput) => {
      admittedRuns.push(input);
      actions.push(`admit:${input.sessionId}:${input.workspaceId}:${input.conversationId}:${input.opencodeSessionId}:${input.runId}:${input.clientMessageId}`);
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
    ensureLocalRuntimeReachableForSend: async () => true,
    ensureServerOwnedSubmitTransportReady: async () => true,
    emitFlowProgress: (event) => {
      progressEvents.push(event.type);
      busyState = event.type !== "flow.idle";
      overrideEmitFlowProgress?.(event);
    },
    finishPerf: () => undefined,
    holdVisibleRuntimeActivity: (sessionId, reason) => actions.push(`hold:${sessionId}:${reason}`),
    isPendingSessionInstanceKey: (sessionId: string | null | undefined) => Boolean(sessionId?.startsWith("pending-session:")),
    isTauriRuntime: () => false,
    isUiScopeTokenCurrent: () => true,
    isWorkspaceClientStaleError: (
      _error,
    ): _error is {
      entryWorkspaceId?: string | null;
      currentWorkspaceId?: string | null;
    } => false,
    isWorkspaceRuntimeReady: () => true,
    listCommands: async () => [],
    emitLiveTranscriptPolicyEvent: (event) => {
      liveTranscriptPolicyEvents.push(event);
      liveReadAllowedWorkspaceIds.push(event.workspaceId?.trim() || "ws-active");
    },
    markPendingDraftConsumed: (id) => actions.push(`mark-consumed:${id}`),
    messageFromUnknownError: (error) => (error instanceof Error ? error.message : String(error)),
    messages: () => [],
    modelForSession: () => model,
    modelVariant: () => null,
    pendingSessionDraftsDelete: async () => true,
    perfNow: () => 100,
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
      sessionId === "sess-selected" ? { workspaceId: "ws-foreign", directory: "/foreign" } : { workspaceId: "ws-active", directory: "/active" },
    resolveSendPromptBusyOwnership: () => ({ ownsBusy: false }),
    resolveSendTargetWorkspaceScope: (sessionId) =>
      sessionId === "sess-target"
        ? {
            workspaceId: "ws-active",
            workspaceRoot: "/active",
            directory: "/active",
          }
        : targetWorkspace,
    routedClient: () => ({}) as Client,
    submitConversationFromVesloWriteApi: async (workspaceId, _directory, input) => ({
      status: "submitted",
      workspaceId,
      conversationId: "conv-submit",
      opencodeSessionId: "open-submit",
      runId: "run-submit",
      clientMessageId: input.clientMessageId,
      draftDisposition: "clear",
    }),
    safeStringify: (value) => JSON.stringify(value),
    selectedSessionId: () => selectedSessionId,
    sendBoundaryValidationMode: () => "strict",
    sendTraceStep: async (_event, run) => run(),
    sessionStoreAppendSessionErrorTurn: () => undefined,
    sessionStoreClearCommandDisplay: () => undefined,
    sessionStoreSetCommandDisplay: () => undefined,
    setActivePendingDraftKey: () => undefined,
    setActivePendingDraftMeta: () => undefined,
    composerDraftCommands: { deleteDraft: () => undefined },
    setError: (message) => {
      if (message) errors.push(message);
    },
    setLastPromptSent: () => undefined,
    setPrompt: (value) => actions.push(`set-prompt:${value}`),
    setSelectedSessionId: (sessionId) => {
      selectedSessionId = sessionId;
    },
    setView: () => undefined,
    stageServerSubmitAttachments: async () => [],
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

  const sent = await workflow.sendPrompt(promptDraft(), {
    origin: "session:normal",
    clientMessageId: "",
  });

  assert.equal(sent.accepted, false);
  assert.deepEqual(harness.actions, []);
  assert.ok(harness.events.includes("sendPrompt:blocked-missing-client-message-id"));
});

test("app wiring keeps the normal send workflow on server-owned submit", () => {
  const workflowStart = appSource.indexOf("const sessionSendWorkflow = createSessionSendWorkflow({");
  const workflowEnd = appSource.indexOf("\n  });", workflowStart);

  assert.notEqual(workflowStart, -1, "app.tsx should wire createSessionSendWorkflow");
  assert.ok(workflowEnd > workflowStart, "session send workflow dependency object should be bounded");
  const workflowDeps = appSource.slice(workflowStart, workflowEnd);

  assert.match(workflowDeps, /\bsubmitConversationFromVesloWriteApi\b/, "normal production send wiring must inject server-owned submit");
});

test("session send workflow blocks when server-owned submit is not configured", async () => {
  const harness = createHarness({
    submitConversationFromVesloWriteApi: undefined,
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("compat disabled"), {
    clientMessageId: "client-compat-disabled",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, false);
  assert.equal(sent.status, "blocked");
  assert.equal(sent.code, "server_submit_unavailable");
  assert.ok(harness.events.includes("sendPrompt:blocked-server-submit-unavailable"));
});

test("document runtime helpers map only Veslo document skills", () => {
  assert.equal(documentRuntimeFormatForSkillCommand("veslo-docx"), "docx");
  assert.equal(documentRuntimeFormatForSkillCommand("veslo-xlsx"), "xlsx");
  assert.equal(documentRuntimeFormatForSkillCommand("veslo-pdf"), "pdf");
  assert.equal(documentRuntimeFormatForSkillCommand("veslo-pptx"), "pptx");
  assert.equal(documentRuntimeFormatForSkillCommand("custom-docx"), null);
  assert.match(documentRuntimeBlockReasonForSkillCommand(documentRuntimePayload("missing"), "veslo-docx") ?? "", /package is missing/);
});

test("send boundary validation mode is report-only unless explicitly strict or off", () => {
  assert.equal(resolveSendBoundaryValidationMode({}), "report");
  assert.equal(
    resolveSendBoundaryValidationMode({
      VITE_VESLO_SEND_BOUNDARY_VALIDATION: "strict",
    }),
    "strict",
  );
  assert.equal(
    resolveSendBoundaryValidationMode({
      VITE_VESLO_SEND_BOUNDARY_VALIDATION: "off",
    }),
    "off",
  );
  assert.equal(
    resolveSendBoundaryValidationMode({
      VITE_VESLO_SEND_BOUNDARY_VALIDATION: "false",
    }),
    "off",
  );
  assert.equal(
    resolveSendBoundaryValidationMode({
      VITE_VESLO_SEND_BOUNDARY_VALIDATION: "enabled",
    }),
    "report",
  );
});

test("send boundary classifier preserves the failing submit layer", () => {
  assert.equal(
    classifySendBoundaryFailurePhase({
      schema: "send-runtime-preparation-result",
      phase: "runtime-preflight",
    }),
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

test("session send workflow validates staged attachment shape before routing in strict mode", async () => {
  const harness = createHarness({
    stageServerSubmitAttachments: async () => [
      {
        name: "note.txt",
        kind: "file" as const,
        mimeType: "text/plain",
        relativePath: "",
        absolutePath: "",
      },
    ],
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(attachmentDraft("invalid staged attachment"), {
    clientMessageId: "client-invalid-staged-attachment",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, false);
  assert.equal(sent.status, "failed");
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing-stage-attachments-result:validation-failed"));
  assert.ok(!harness.events.includes("sendPrompt:server-submit-existing-success"));
});

test("session send workflow can report malformed staged attachments without blocking routing", async () => {
  const harness = createHarness({
    sendBoundaryValidationMode: () => "report",
    stageServerSubmitAttachments: async () => [
      {
        name: "note.txt",
        kind: "file" as const,
        mimeType: "text/plain",
        relativePath: "",
        absolutePath: "",
      },
    ],
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(attachmentDraft("report staged attachment"), {
    clientMessageId: "client-report-staged-attachment",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, true);
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing-stage-attachments-result:validation-failed"));
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing-success"));
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
      submitCalls.push({
        workspaceId,
        directory,
        input,
        traceId: preflight?.traceId,
      });
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
  assert.deepEqual(
    submitCalls.map(({ workspaceId, directory, traceId }) => ({
      workspaceId,
      directory,
      traceId,
    })),
    [
      {
        workspaceId: "ws-active",
        directory: "/active",
        traceId: "trace-created",
      },
    ],
  );
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
  assert.ok(harness.actions.includes("admit:sess-target:ws-active:conv-target:open-target:run-submit:client-server-submit"));
  assert.equal(harness.admittedRuns[0]?.diagnosticTraceId, "trace-created");
  assert.ok(!harness.actions.some((action) => action.startsWith("run:")));
});

test("existing-session server submit arms its known alias before the request and promotes it on submitted", async () => {
  const order: string[] = [];
  const harness = createHarness({
    armConversationRunProvisional: (input) => {
      order.push(`arm:${input.conversationId}:${input.opencodeSessionId}:${input.clientMessageId}`);
      return true;
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
    submitConversationFromVesloWriteApi: async (workspaceId, _directory, input) => {
      order.push("submit");
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
    admitAcceptedConversationRun: (input) => {
      order.push(`admit:${input.runId}`);
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("armed submit"), {
    clientMessageId: "client-armed-submit",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, true);
  assert.deepEqual(order, ["arm:conv-target:open-target:client-armed-submit", "submit", "admit:run-submit"]);
});

test("session send workflow keeps its existing-session target snapshot after scope changes", async () => {
  const actionTarget = {
    workspaceId: "ws-active",
    workspaceRoot: "/owned",
    directory: "/owned",
  };
  let targetResolutions = 0;
  const activationTargets: unknown[] = [];
  const submitTargets: Array<{ workspaceId: string; directory: string }> = [];
  const harness = createHarness({
    resolveSendTargetWorkspaceScope: () => {
      targetResolutions += 1;
      return actionTarget;
    },
    resolveSelectedSessionBrowseScope: (sessionId) =>
      sessionId === "sess-target"
        ? {
            sessionId,
            workspaceId: "ws-stale",
            workspaceRoot: "/stale",
            directory: "/stale",
            conversationId: "conv-target",
            opencodeSessionId: "open-target",
          }
        : null,
    ensureSelectedSessionWorkspaceActiveForSend: async (_sessionId, _traceId, scope) => {
      activationTargets.push(scope);
      return true;
    },
    submitConversationFromVesloWriteApi: async (workspaceId, directory, input) => {
      submitTargets.push({ workspaceId, directory });
      return {
        status: "submitted",
        workspaceId,
        conversationId: "conv-target",
        opencodeSessionId: "open-target",
        runId: "run-snapshot",
        clientMessageId: input.clientMessageId,
        draftDisposition: "clear",
      };
    },
    vesloServerStatus: () => "connected",
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("snapshot"), {
    clientMessageId: "client-snapshot",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, true);
  assert.equal(targetResolutions, 1);
  assert.deepEqual(activationTargets, [actionTarget]);
  assert.deepEqual(submitTargets, [{ workspaceId: "ws-active", directory: "/owned" }]);
});

test("session send workflow replays the same client id after a transport error", async () => {
  const clientMessageIds: string[] = [];
  let attempts = 0;
  const harness = createHarness({
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

test("session send workflow does not replay a deterministic server response", async () => {
  let attempts = 0;
  const harness = createHarness({
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
    submitConversationFromVesloWriteApi: async () => {
      attempts += 1;
      throw new VesloServerError(409, "skill_view_changed", "The runtime skill view changed");
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("deterministic response"), {
    clientMessageId: "client-server-response",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, false);
  assert.equal(sent.code, "server_submit_response_failed");
  assert.equal(attempts, 1);
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing:server-response-error"));
  assert.equal(harness.events.includes("sendPrompt:server-submit-existing:replay-after-transport-error"), false);
});

test("session send workflow replays an upstream 503 once with the same client id", async () => {
  const clientMessageIds: string[] = [];
  let attempts = 0;
  const harness = createHarness({
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
    submitConversationFromVesloWriteApi: async (workspaceId, _directory, input) => {
      attempts += 1;
      clientMessageIds.push(input.clientMessageId);
      if (attempts === 1) {
        throw new VesloServerError(503, "lifecycle_unavailable", "Upstream unavailable");
      }
      return {
        status: "submitted",
        workspaceId,
        conversationId: "conv-target",
        opencodeSessionId: "open-target",
        runId: "run-after-503",
        clientMessageId: input.clientMessageId,
        draftDisposition: "clear",
      };
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("retry upstream 503"), {
    clientMessageId: "client-replay-503",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, true);
  assert.deepEqual(clientMessageIds, ["client-replay-503", "client-replay-503"]);
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing:replay-after-transport-error"));
});

test("session send workflow does not replay a typed server-submit preflight failure", async () => {
  let attempts = 0;
  let runtimeRecoveryCalls = 0;
  const harness = createHarness({
    ensureLocalRuntimeReachableForSend: async () => {
      runtimeRecoveryCalls += 1;
      return true;
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
    submitConversationFromVesloWriteApi: async () => {
      attempts += 1;
      throw new ConversationServerSubmitPreflightError("Managed AI config is retrying its reload.");
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("preflight failure"), {
    clientMessageId: "client-preflight-failure",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(attempts, 1);
  assert.equal(runtimeRecoveryCalls, 0);
  assert.equal(sent.accepted, false);
  assert.equal(sent.code, "server_submit_preflight_failed");
  assert.equal(sent.draftDisposition, "keep");
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing:preflight-error"));
  assert.equal(harness.events.includes("sendPrompt:server-submit-existing:replay-after-transport-error"), false);
});

test("session send workflow keeps missing-binding recovery separate from one transport replay", async () => {
  const clientMessageIds: string[] = [];
  let submitAttempts = 0;
  let runtimeRecoveryCalls = 0;
  const harness = createHarness({
    ensureServerOwnedSubmitTransportReady: async (event, preflight) => {
      runtimeRecoveryCalls += 1;
      assert.equal(event, "sendPrompt");
      assert.equal(preflight.targetWorkspace?.workspaceId, "ws-active");
      assert.equal(preflight.forceRecovery, true);
      assert.equal(preflight.runtimeHealthOk, false);
      assert.equal(preflight.enginePrepared, false);
      return true;
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
    submitConversationFromVesloWriteApi: async (workspaceId, _directory, input) => {
      submitAttempts += 1;
      clientMessageIds.push(input.clientMessageId);
      if (submitAttempts === 1) throw missingLiveBindingPreflightError();
      if (submitAttempts === 2) throw new Error("connection closed after dispatch");
      return {
        status: "submitted",
        workspaceId,
        conversationId: "conv-target",
        opencodeSessionId: "open-target",
        runId: "run-recovered-replayed",
        clientMessageId: input.clientMessageId,
        draftDisposition: "clear",
      };
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("recover then replay"), {
    clientMessageId: "client-live-binding-replay",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, true);
  assert.equal(runtimeRecoveryCalls, 1);
  assert.deepEqual(clientMessageIds, ["client-live-binding-replay", "client-live-binding-replay", "client-live-binding-replay"]);
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing:missing-live-binding-recovery:start"));
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing:replay-after-transport-error"));
});

test("missing live binding recovery does not replay an unavailable undefined retry", async () => {
  let submitAttempts = 0;
  const harness = createHarness({
    ensureServerOwnedSubmitTransportReady: async () => true,
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
    submitConversationFromVesloWriteApi: async () => {
      submitAttempts += 1;
      if (submitAttempts === 1) throw missingLiveBindingPreflightError();
      return undefined;
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("recover then unavailable"), {
    clientMessageId: "client-live-binding-undefined",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, false);
  assert.equal(submitAttempts, 2);
  assert.equal(harness.events.includes("sendPrompt:server-submit-existing:replay-after-transport-error"), false);
});

test("missing live binding recovery failure disposes provisional ownership once", async () => {
  let submitAttempts = 0;
  let provisionalDisposals = 0;
  const harness = createHarness({
    armConversationRunProvisional: () => true,
    disposeConversationRunProvisional: () => {
      provisionalDisposals += 1;
      return true;
    },
    ensureServerOwnedSubmitTransportReady: async () => false,
    displayedConversationStillMatches: () => false,
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
    submitConversationFromVesloWriteApi: async () => {
      submitAttempts += 1;
      throw missingLiveBindingPreflightError();
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("failed recovery"), {
    clientMessageId: "client-live-binding-recovery-failed",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, false);
  assert.equal(submitAttempts, 1);
  assert.equal(provisionalDisposals, 1);
  assert.equal(harness.events.includes("sendPrompt:server-submit-existing:replay-after-transport-error"), false);
});

test("existing-session submit preserves a newer composer's UI while admitting the original run", async () => {
  let provisionalArms = 0;
  let lastPromptWrites = 0;
  const composerWrites: string[] = [];
  const harness = createHarness({
    armConversationRunProvisional: () => {
      provisionalArms += 1;
      return true;
    },
    displayedConversationStillMatches: () => false,
    setLastPromptSent: () => {
      lastPromptWrites += 1;
    },
    setPrompt: (value) => composerWrites.push(value),
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
    submitConversationFromVesloWriteApi: async (workspaceId, _directory, input) => ({
      status: "submitted",
      workspaceId,
      conversationId: "conv-target",
      opencodeSessionId: "open-target",
      runId: "run-original-send",
      clientMessageId: input.clientMessageId,
      draftDisposition: "clear",
    }),
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("original message"), {
    clientMessageId: "client-original-send",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, true);
  assert.equal(provisionalArms, 1);
  assert.equal(harness.admittedRuns.length, 1);
  assert.equal(harness.admittedRuns[0]?.runId, "run-original-send");
  assert.equal(lastPromptWrites, 0);
  assert.deepEqual(composerWrites, []);
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing:ui-effects-skipped"));
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
    submitConversationFromVesloWriteApi: async (workspaceId, _directory, input) =>
      ({
        status: "submitted",
        workspaceId,
        conversationId: "conv-target",
        opencodeSessionId: "open-target",
        clientMessageId: input.clientMessageId,
        draftDisposition: "clear",
      }) as unknown as VesloConversationSubmitResult,
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
    attachments: [
      {
        id: "att-1",
        name: "brief.txt",
        kind: "file",
        mimeType: "text/plain",
        size: 5,
        dataUrl: "data:text/plain;base64,YnJpZWY=",
      },
    ],
  };
  const harness = createHarness({
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
    stageServerSubmitAttachments: async (_draft, sessionId) => {
      stagedSessionIds.push(sessionId);
      return [
        {
          name: "brief.txt",
          kind: "file",
          mimeType: "text/plain",
          relativePath: "sessions/sess-target/brief.txt",
          absolutePath: "/active/sessions/sess-target/brief.txt",
        },
      ];
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
  assert.deepEqual(submitCalls[0]?.input.draft.attachments, [
    {
      name: "brief.txt",
      kind: "file",
      mimeType: "text/plain",
      dataUrl: null,
      fileSessionPath: "sessions/sess-target/brief.txt",
    },
  ]);
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
    messages: () => [{ parts: [{ type: "text", text: "already here" }] }],
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
  assert.deepEqual(
    submitCalls.map(({ workspaceId, directory }) => ({
      workspaceId,
      directory,
    })),
    [
      {
        workspaceId: "ws-active",
        directory: "/active",
      },
    ],
  );
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

test("session send workflow returns failed server submit without duplicating the pending-row error", async () => {
  const appendedErrors: Array<{ sessionId: string; message: string }> = [];
  const harness = createHarness({
    addOpencodeCacheHint: (message) => `${message} Clear the OpenCode cache and retry.`,
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
  assert.equal(sent.message, "Submit failed for client-server-failed");
  assert.deepEqual(harness.errors, []);
  assert.deepEqual(appendedErrors, []);
  assert.ok(!harness.actions.some((action) => action.startsWith("run:")));
});

test("session send workflow reports remote server-submit blocks", async () => {
  const submitCalls: VesloConversationSubmitRequest[] = [];
  const harness = createHarness({
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
  assert.equal(sent.message, "Remote workspace submit is not available through the local server.");
  assert.deepEqual(harness.errors, []);
});

test("session send workflow blocks when server submit returns no result", async () => {
  const submitCalls: VesloConversationSubmitRequest[] = [];
  const harness = createHarness({
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

  const sent = await workflow.sendPrompt(promptDraft("server unavailable"), {
    clientMessageId: "client-server-unavailable",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, false);
  assert.equal(submitCalls.length, 1);
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing-unavailable"));
  assert.match(harness.errors.at(-1) ?? "", /Server-owned conversation submit is unavailable/);
});

test("session send workflow blocks when the server submit target is missing", async () => {
  const harness = createHarness({
    resolveSendTargetWorkspaceScope: () => ({
      workspaceId: "",
      workspaceRoot: "",
      directory: "",
    }),
    submitConversationFromVesloWriteApi: async () => {
      throw new Error("server submit should not be called without a workspace and directory");
    },
    workspace: {
      activeWorkspaceDisplay: () => ({ workspaceType: "local" }),
      activeWorkspaceId: () => "ws-must-not-be-used",
      activeWorkspaceRoot: () => "/must-not-be-used",
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
  assert.match(harness.errors.at(-1) ?? "", /missing a workspace or directory/);
});

test("session send workflow blocks when first-session server materialization returns no result", async () => {
  const createOptions: Array<Parameters<SessionSendWorkflowOptions["createSessionAndOpen"]>[1]> = [];
  const harness = createHarness({
    createSessionAndOpen: async (_initialTitle, options) => {
      createOptions.push(options);
      harness.actions.push("create-session");
      return "sess-created";
    },
    listCommands: async () => {
      throw new Error("frontend command listing should not run for server-owned materialization");
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
  assert.ok(harness.events.includes("sendPrompt:maybe-resolve-skill-command:server-owned-skip"));
  assert.ok(harness.events.includes("sendPrompt:server-submit-first-missing-result"));
  assert.match(harness.errors.at(-1) ?? "", /did not return a queued or submitted result/);
});

test("session send workflow accepts first-session server submit results", async () => {
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
    selectedSessionId: () => null,
    composerDraftCommands: {
      deleteDraft: () => {
        composerDraftCleanupCalls.push("cleanup");
      },
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
  assert.ok(harness.actions.includes("admit:sess-created:ws-active:conv-created:sess-created:run-created:client-first-server-submit"));
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
        debugTrace: [
          {
            source: "server",
            event: "run_submit_failed_after_materialization",
          },
        ],
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
    composerDraftCommands: {
      deleteDraft: () => {
        harness.actions.push("set-composer-draft-by-session");
      },
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
  assert.equal(accepted.message, "OpenCode prompt failed");
  assert.deepEqual(harness.errors, []);
  assert.doesNotMatch(harness.actions.join("\n"), /append-error:/);
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

  const result = await workflow.abortSession("sess-unscoped");

  assert.deepEqual(abortCalls, []);
  assert.deepEqual(conversationAbortCalls, []);
  assert.ok(harness.events.includes("abortSession:abort-blocked-missing-workspace-scope"));
  assert.match(harness.errors.at(-1) ?? "", /workspace scope is missing/);
  assert.equal(result?.kind, "unknown");
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
    routedClient: () => ({}) as Client,
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

  assert.deepEqual(
    abortCalls.map((call) => call.sessionId),
    ["open-scoped"],
  );
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
    routedClient: (workspaceId?: string | null) => (workspaceId ? null : ({} as Client)),
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
    routedClient: () => ({}) as Client,
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

  const result = await workflow.abortSession("conv-scoped");

  assert.deepEqual(abortCalls, []);
  assert.ok(harness.events.includes("abortSession:conversation-abort-unavailable"));
  assert.ok(harness.events.includes("abortSession:conversation-abort-blocked-unavailable"));
  assert.match(harness.errors.at(-1) ?? "", /Conversation service is unavailable/);
  assert.equal(result?.kind, "unknown");
});

test("abortSession reports a durable abort request as pending reconciliation", async () => {
  const harness = createHarness({
    abortConversationFromVesloWriteApi: async () => ({
      workspaceId: "ws-active",
      conversationId: "conv-active",
      opencodeSessionId: "open-active",
      runId: "run-active",
    }),
    resolveSelectedSessionBrowseScope: () => ({
      workspaceId: "ws-active",
      workspaceRoot: "/active",
      directory: "/active",
      conversationId: "conv-active",
      opencodeSessionId: "open-active",
    }),
    resolveConversationAbortScope: (sessionId) => ({
      sessionId,
      workspaceId: "ws-active",
      workspaceRoot: "/active",
      directory: "/active",
      hasConversationScope: true,
      conversationId: "conv-active",
      opencodeSessionId: "open-active",
    }),
  });
  const workflow = createSessionSendWorkflow(harness.options);

  assert.deepEqual(await workflow.abortSession("open-active"), {
    kind: "pending_reconciliation",
    workspaceId: "ws-active",
    conversationId: "conv-active",
    opencodeSessionId: "open-active",
    runId: "run-active",
  });
});

test("session send workflow ignores a selected session from another workspace when no explicit target is provided", async () => {
  const harness = createHarness({
    createSessionAndOpen: async (_initialTitle, options) => {
      options?.onSubmitResult?.({
        status: "submitted",
        workspaceId: "ws-active",
        conversationId: "conv-created",
        opencodeSessionId: "sess-created",
        runId: "run-created",
        clientMessageId: "client-1",
        draftDisposition: "clear",
      });
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
  assert.ok(harness.events.includes("sendPrompt:server-submit-first-success"));
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
  assert.deepEqual(
    harness.liveTranscriptPolicyEvents.map((event) => event.reason),
    ["sendPrompt:success"],
  );
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
  const submitInputs: VesloConversationSubmitRequest[] = [];
  const harness = createHarness({
    modelForSession: () => ({
      providerID: "codex_oauth",
      modelID: "gpt-5.5",
    }),
    modelVariant: () => "xhigh",
    submitConversationFromVesloWriteApi: async (workspaceId, _directory, input) => {
      submitInputs.push(input);
      return {
        status: "submitted",
        workspaceId,
        conversationId: "conv-target",
        opencodeSessionId: "open-target",
        runId: "run-codex-oauth",
        clientMessageId: input.clientMessageId,
        draftDisposition: "clear",
      };
    },
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const sent = await workflow.sendPrompt(promptDraft("codex oauth send"), {
    clientMessageId: "client-codex-oauth",
    origin: "session:normal",
    targetSessionId: "sess-target",
  });

  assert.equal(sent.accepted, true);
  assert.equal(submitInputs.length, 1);
  const input = submitInputs[0];
  assert.equal(input?.options?.model, undefined);
  assert.equal(input?.options?.variant, "xhigh");
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
  assert.ok(harness.events.includes("sendPrompt:server-submit-existing-success"));
});
