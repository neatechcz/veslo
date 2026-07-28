import assert from "node:assert/strict";
import test from "node:test";

import type { Session } from "@opencode-ai/sdk/v2/client";

import {
  createSessionCreationWorkflow,
  type SessionCreationPreflightContext,
  type SessionCreationWorkflowOptions,
} from "../../pages/session-creation-workflow.js";
import type { SessionFlowProgressEvent } from "../../context/session-flow-progress-presenter.js";
import type { MaterializedSessionHandoff } from "../../lib/session-send-contract.js";
import type { PendingSidebarSessionMetadata } from "../../types.js";

type Harness = {
  actions: string[];
  progressEvents: SessionFlowProgressEvent["type"][];
  errors: Array<string | null>;
  events: string[];
  handoffs: MaterializedSessionHandoff[];
  options: SessionCreationWorkflowOptions;
};

const targetWorkspace = {
  workspaceId: "ws-main",
  workspaceRoot: "/repo",
  directory: "/repo",
};

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-created",
    title: "Backend title",
    slug: "backend-title",
    parentID: undefined,
    time: { created: 10, updated: 20 },
    directory: "/repo",
    ...overrides,
  } as Session;
}

function sessionPreflight(
  overrides: Partial<SessionCreationPreflightContext> = {},
): SessionCreationPreflightContext {
  return {
    traceId: "trace-test",
    managedAiReady: false,
    runtimeHealthOk: false,
    enginePrepared: false,
    effectiveSandbox: null,
    targetWorkspace: null,
    conversationWorkspaceByDirectory: new Map(),
    ...overrides,
  };
}

function createHarness(
  overrides: Partial<SessionCreationWorkflowOptions> = {},
): Harness {
  const actions: string[] = [];
  const progressEvents: SessionFlowProgressEvent["type"][] = [];
  const events: string[] = [];
  const errors: Array<string | null> = [];
  const handoffs: MaterializedSessionHandoff[] = [];
  let sessions: Session[] = [];

  const options: SessionCreationWorkflowOptions = {
    activeSendTraceId: () => "trace-active",
    addOpencodeCacheHint: (message) => message,
    baseUrl: () => "http://127.0.0.1:4096",
    currentView: () => "session",
    developerMode: () => false,
    createSendPreflightContext: (sendTraceId) =>
      sessionPreflight({
        traceId: sendTraceId?.trim() || "trace-created",
      }),
    ensureLocalRuntimeReachableForSend: async () => {
      actions.push("ensure-runtime");
      return true;
    },
    ensureServerOwnedSubmitTransportReady: async () => {
      actions.push("ensure-server-submit-transport");
      return true;
    },
    ensureManagedAiBootstrapReady: async () => {
      actions.push("ensure-managed-ai");
      return true;
    },
    isWorkspaceClientStaleError: (
      _error,
    ): _error is {
      entryWorkspaceId?: string | null;
      currentWorkspaceId?: string | null;
    } => false,
    managedAiBootstrapBusy: () => false,
    perfNow: () => 100,
    recordPerfLog: () => undefined,
    finishPerf: () => undefined,
    emitFlowProgress: (event) => {
      progressEvents.push(event.type);
    },
    applyCreatedSessionState: (result, options) => {
      if (result.workspaceScope.workspaceId) {
        actions.push("remember-scope");
      }
      if (!sessions.some((entry) => entry.id === result.sessionId)) {
        actions.push("set-sessions");
        sessions = [result.session, ...sessions];
      }
      if (result.workspaceScope.workspaceId) {
        actions.push("materialize-sidebar");
      }
      if (result.handoff) {
        options.onMaterializedSessionId?.(result.handoff);
      }
    },
    applyCreatedSessionTransition: async (result) => {
      const sessionId = result.transition.sessionId;
      if (result.transition.shouldRouteAfterSelect) {
        actions.push(`own:${sessionId}`);
      }
      actions.push(`select:${sessionId}`);
      if (result.transition.shouldRouteAfterSelect) {
        actions.push(`own:${sessionId}`);
        actions.push(`go:${sessionId}`);
      }
    },
    recordSendTrace: (event) => events.push(event),
    reloadBusy: () => false,
    resolveRuntimeSandboxStateForTarget: () => ({}) as never,
    resolveSendTargetWorkspaceScope: () => targetWorkspace,
    resolveWorkspaceRootForConversationScope: (_workspaceId, directory) =>
      directory,
    routedClient: () => ({}),
    routedClientForSendTarget: () => ({}),
    safeStringify: (value) => JSON.stringify(value),
    sendTraceStep: async (_event, run) => run(),
    setError: (message) => {
      errors.push(message);
    },
    unknownErrorMessage: () => "app.unknown_error",
    workspace: {
      activeWorkspaceDisplay: () => ({ workspaceType: "local" }),
      activeWorkspaceId: () => "ws-main",
      activeWorkspaceRoot: () => "/repo",
      connectingWorkspaceId: () => "",
    },
    abortRefreshes: () => actions.push("abort-refreshes"),
    createConversationFromVesloWriteApi: async () => {
      actions.push("create-conversation");
      return {
        ...session(),
        conversationId: "conv-created",
        opencodeSessionId: "open-created",
      };
    },
    ...overrides,
  };

  return { actions, progressEvents, errors, events, handoffs, options };
}

test("session creation blocks while the target workspace is still connecting", async () => {
  const harness = createHarness({
    workspace: {
      activeWorkspaceDisplay: () => ({ workspaceType: "local" }),
      activeWorkspaceId: () => "ws-main",
      activeWorkspaceRoot: () => "/repo",
      connectingWorkspaceId: () => "ws-main",
    },
  });
  const workflow = createSessionCreationWorkflow(harness.options);

  const result = await workflow.createSessionAndOpen("hello");

  assert.equal(result, undefined);
  assert.deepEqual(harness.errors, [
    "Please wait for the workspace switch to complete.",
  ]);
  assert.deepEqual(harness.progressEvents, []);
  assert.ok(harness.events.includes("createSessionAndOpen:blocked-connecting"));
  assert.doesNotMatch(
    harness.actions.join("\n"),
    /create-conversation|select:/,
  );
});

test("session creation reuses send preflight readiness without rerunning runtime gates", async () => {
  const preflight = sessionPreflight({
    traceId: "trace-send",
    targetWorkspace,
    enginePrepared: true,
    runtimeHealthOk: false,
    managedAiReady: true,
  });
  const harness = createHarness();
  const workflow = createSessionCreationWorkflow(harness.options);

  const result = await workflow.createSessionAndOpen("hello", {
    preflight,
  });

  assert.equal(result, "sess-created");
  assert.equal(preflight.enginePrepared, true);
  assert.equal(preflight.managedAiReady, true);
  assert.ok(harness.events.includes("createSessionAndOpen:health-skip"));
  assert.ok(
    harness.events.includes("createSessionAndOpen:managed-ai-bootstrap-skip"),
  );
  assert.doesNotMatch(
    harness.actions.join("\n"),
    /ensure-runtime|ensure-managed-ai/,
  );
});

test("session creation uses server-owned transport instead of preparing a routed runtime", async () => {
  const observedPreflights: Array<SessionCreationPreflightContext | undefined> =
    [];
  const transportPreflightSnapshots: Array<{
    enginePrepared: boolean;
    runtimeHealthOk: boolean;
    managedAiReady: boolean;
  }> = [];
  const harness = createHarness({
    ensureLocalRuntimeReachableForSend: async () => {
      throw new Error("first server submit must not prepare a routed runtime");
    },
    ensureServerOwnedSubmitTransportReady: async (_reason, preflight) => {
      transportPreflightSnapshots.push({
        enginePrepared: Boolean(preflight.enginePrepared),
        runtimeHealthOk: Boolean(preflight.runtimeHealthOk),
        managedAiReady: Boolean(preflight.managedAiReady),
      });
      return true;
    },
    ensureManagedAiBootstrapReady: async () => {
      throw new Error(
        "managed AI gate should not run before server submit materialization",
      );
    },
    routedClientForSendTarget: () => {
      throw new Error("first server submit must not require a routed client");
    },
    submitConversationFromVesloWriteApi: async (
      _workspaceId,
      _directory,
      input,
      preflight,
    ) => {
      observedPreflights.push(preflight);
      return {
        status: "submitted",
        workspaceId: "ws-main",
        conversationId: "conv-submit",
        opencodeSessionId: "open-submit",
        runId: "run-submit",
        clientMessageId: input.clientMessageId,
        draftDisposition: "clear",
        materializedSession: {
          ...session({ id: "sess-submit" }),
          conversationId: "conv-submit",
          opencodeSessionId: "open-submit",
        },
      };
    },
  });
  const workflow = createSessionCreationWorkflow(harness.options);

  const result = await workflow.createSessionAndOpen("hello", {
    clientMessageId: "client-submit",
    submitDraft: {
      mode: "prompt",
      text: "hello",
      resolvedText: "hello",
      parts: [{ type: "text", text: "hello" }],
      command: null,
      attachments: [],
    },
    preflight: sessionPreflight({
      traceId: "trace-submit",
      targetWorkspace,
      runtimeHealthOk: false,
    }),
  });

  assert.equal(result, "sess-submit");
  assert.deepEqual(transportPreflightSnapshots, [
    {
      enginePrepared: false,
      runtimeHealthOk: false,
      managedAiReady: false,
    },
  ]);
  assert.equal(observedPreflights.length, 1);
  assert.equal(observedPreflights[0]?.runtimeHealthOk, false);
  assert.equal(observedPreflights[0]?.enginePrepared, false);
  assert.equal(observedPreflights[0]?.managedAiReady, false);
  assert.ok(
    harness.events.includes(
      "createSessionAndOpen:server-submit-managed-ai-admission-skip",
    ),
  );
  assert.doesNotMatch(
    harness.actions.join("\n"),
    /ensure-runtime|ensure-managed-ai|create-conversation/,
  );
});

test("first server submit retries pre-HTTP recovery through server-owned transport with the same message id", async () => {
  const messageIds: string[] = [];
  const transportPreflights: Array<{
    forceRecovery: boolean;
    runtimeHealthOk: boolean;
    enginePrepared: boolean;
  }> = [];
  let attempts = 0;
  const harness = createHarness({
    ensureLocalRuntimeReachableForSend: async () => {
      throw new Error(
        "first server submit recovery must not prepare an engine",
      );
    },
    ensureServerOwnedSubmitTransportReady: async (_reason, preflight) => {
      transportPreflights.push({
        forceRecovery: preflight.forceRecovery === true,
        runtimeHealthOk: preflight.runtimeHealthOk === true,
        enginePrepared: preflight.enginePrepared === true,
      });
      return true;
    },
    submitConversationFromVesloWriteApi: async (
      _workspaceId,
      _directory,
      input,
      preflight,
    ) => {
      messageIds.push(input.clientMessageId);
      attempts += 1;
      if (attempts === 1) {
        throw new Error("connection reset before submit");
      }
      assert.equal(preflight?.runtimeHealthOk, false);
      assert.equal(preflight?.enginePrepared, false);
      return {
        status: "submitted",
        workspaceId: "ws-main",
        conversationId: "conv-submit",
        opencodeSessionId: "open-submit",
        runId: "run-submit",
        clientMessageId: input.clientMessageId,
        draftDisposition: "clear",
        materializedSession: {
          ...session({ id: "sess-submit" }),
          conversationId: "conv-submit",
          opencodeSessionId: "open-submit",
        },
      };
    },
  });
  const workflow = createSessionCreationWorkflow(harness.options);

  const result = await workflow.createSessionAndOpen("hello", {
    clientMessageId: "client-submit",
    submitDraft: {
      mode: "prompt",
      text: "hello",
      resolvedText: "hello",
      parts: [{ type: "text", text: "hello" }],
      command: null,
      attachments: [],
    },
    preflight: sessionPreflight({ traceId: "trace-submit", targetWorkspace }),
  });

  assert.equal(result, "sess-submit");
  assert.deepEqual(messageIds, ["client-submit", "client-submit"]);
  assert.deepEqual(transportPreflights, [
    { forceRecovery: false, runtimeHealthOk: false, enginePrepared: false },
    { forceRecovery: true, runtimeHealthOk: false, enginePrepared: false },
  ]);
  assert.doesNotMatch(harness.actions.join("\n"), /ensure-runtime/);
});

test("submitted first runs are admitted after materialization and before selection", async () => {
  const phaseOrder: string[] = [];
  const harness = createHarness({
    applyCreatedSessionState: () => {
      phaseOrder.push("state");
    },
    applyCreatedSessionTransition: async (result) => {
      phaseOrder.push(
        `transition:${String(result.transition.skipTranscriptRead === true)}`,
      );
    },
    submitConversationFromVesloWriteApi: async (
      _workspaceId,
      _directory,
      input,
    ) => ({
      status: "submitted",
      workspaceId: "server-ws-main",
      conversationId: "conv-submit",
      opencodeSessionId: "open-submit",
      runId: "run-submit",
      clientMessageId: input.clientMessageId,
      draftDisposition: "clear",
      materializedSession: {
        ...session({ id: "sess-submit" }),
        conversationId: "conv-submit",
        opencodeSessionId: "open-submit",
      },
    }),
  });
  const workflow = createSessionCreationWorkflow(harness.options);

  const result = await workflow.createSessionAndOpen("hello", {
    clientMessageId: "client-submit",
    submitDraft: {
      mode: "prompt",
      text: "hello",
      resolvedText: "hello",
      parts: [{ type: "text", text: "hello" }],
      command: null,
      attachments: [],
    },
    onSubmittedRunMaterialized: (materialized) => {
      assert.equal(materialized.sessionId, "sess-submit");
      assert.equal(materialized.workspaceId, "ws-main");
      assert.equal(materialized.result.runId, "run-submit");
      phaseOrder.push("admit");
      return true;
    },
  });

  assert.equal(result, "sess-submit");
  assert.deepEqual(phaseOrder, ["state", "admit", "transition:true"]);
});

test("session creation blocks first server submit when server-owned transport is unavailable", async () => {
  let submitCalled = false;
  const harness = createHarness({
    ensureServerOwnedSubmitTransportReady: async () => false,
    submitConversationFromVesloWriteApi: async () => {
      submitCalled = true;
      throw new Error("submit should not run without a prepared runtime");
    },
  });
  const workflow = createSessionCreationWorkflow(harness.options);

  const result = await workflow.createSessionAndOpen("hello", {
    clientMessageId: "client-submit",
    submitDraft: {
      mode: "prompt",
      text: "hello",
      resolvedText: "hello",
      parts: [{ type: "text", text: "hello" }],
      command: null,
      attachments: [],
    },
    preflight: sessionPreflight({
      traceId: "trace-submit",
      targetWorkspace,
      runtimeHealthOk: false,
    }),
  });

  assert.equal(result, undefined);
  assert.equal(submitCalled, false);
  assert.ok(
    harness.events.includes("createSessionAndOpen:blocked-runtime-unreachable"),
  );
  assert.deepEqual(harness.errors, ["Local runtime is not ready yet."]);
});

test("session creation lets first server submit proceed without a routed client", async () => {
  let submitCalled = false;
  const harness = createHarness({
    ensureServerOwnedSubmitTransportReady: async () => true,
    routedClientForSendTarget: () => null,
    submitConversationFromVesloWriteApi: async (
      _workspaceId,
      _directory,
      input,
      preflight,
    ) => {
      submitCalled = true;
      assert.equal(preflight?.runtimeHealthOk, false);
      return {
        status: "submitted",
        workspaceId: "ws-main",
        conversationId: "conv-submit",
        opencodeSessionId: "open-submit",
        runId: "run-submit",
        clientMessageId: input.clientMessageId,
        draftDisposition: "clear",
        materializedSession: {
          ...session({ id: "sess-submit" }),
          conversationId: "conv-submit",
          opencodeSessionId: "open-submit",
        },
      };
    },
  });
  const workflow = createSessionCreationWorkflow(harness.options);

  const result = await workflow.createSessionAndOpen("hello", {
    clientMessageId: "client-submit",
    submitDraft: {
      mode: "prompt",
      text: "hello",
      resolvedText: "hello",
      parts: [{ type: "text", text: "hello" }],
      command: null,
      attachments: [],
    },
    preflight: sessionPreflight({
      traceId: "trace-submit",
      targetWorkspace,
      runtimeHealthOk: false,
    }),
  });

  assert.equal(result, "sess-submit");
  assert.equal(submitCalled, true);
  assert.equal(
    harness.events.includes("createSessionAndOpen:blocked-no-client"),
    false,
  );
  assert.deepEqual(harness.errors, [null]);
});

test("session creation lets first server submit proceed without a routed client when runtime health is skipped", async () => {
  const remoteTargetWorkspace = {
    workspaceId: "ws-remote",
    workspaceRoot: "/remote",
    directory: "/remote",
  };
  let submitCalled = false;
  const harness = createHarness({
    ensureLocalRuntimeReachableForSend: async (_reason, preflight) => {
      assert.equal(preflight.runtimeHealthOk, false);
      return true;
    },
    ensureManagedAiBootstrapReady: async () => {
      throw new Error(
        "managed AI gate should not run before server submit materialization",
      );
    },
    resolveSendTargetWorkspaceScope: () => remoteTargetWorkspace,
    routedClientForSendTarget: () => {
      throw new Error(
        "routed client should not be required when local runtime health was skipped",
      );
    },
    submitConversationFromVesloWriteApi: async (
      _workspaceId,
      _directory,
      input,
      preflight,
    ) => {
      submitCalled = true;
      assert.equal(preflight?.runtimeHealthOk, false);
      return {
        status: "submitted",
        workspaceId: "ws-remote",
        conversationId: "conv-remote-submit",
        opencodeSessionId: "open-remote-submit",
        runId: "run-remote-submit",
        clientMessageId: input.clientMessageId,
        draftDisposition: "clear",
        materializedSession: {
          ...session({ id: "sess-remote-submit", directory: "/remote" }),
          conversationId: "conv-remote-submit",
          opencodeSessionId: "open-remote-submit",
        },
      };
    },
    workspace: {
      activeWorkspaceDisplay: () => ({ workspaceType: "remote" }),
      activeWorkspaceId: () => "ws-remote",
      activeWorkspaceRoot: () => "/remote",
      connectingWorkspaceId: () => "",
    },
  });
  const workflow = createSessionCreationWorkflow(harness.options);

  const result = await workflow.createSessionAndOpen("hello", {
    clientMessageId: "client-remote-submit",
    submitDraft: {
      mode: "prompt",
      text: "hello",
      resolvedText: "hello",
      parts: [{ type: "text", text: "hello" }],
      command: null,
      attachments: [],
    },
    preflight: sessionPreflight({
      traceId: "trace-remote-submit",
      targetWorkspace: remoteTargetWorkspace,
      runtimeHealthOk: false,
    }),
  });

  assert.equal(result, "sess-remote-submit");
  assert.equal(submitCalled, true);
  assert.ok(
    harness.events.includes(
      "createSessionAndOpen:server-submit-managed-ai-admission-skip",
    ),
  );
});

test("session creation opens a materialized session when first server submit failed after create", async () => {
  const submitResults: unknown[] = [];
  const harness = createHarness({
    submitConversationFromVesloWriteApi: async () => ({
      status: "failed",
      code: "opencode_proxy_failed",
      message: "OpenCode prompt failed",
      workspaceId: "ws-main",
      conversationId: "conv-failed-after-create",
      opencodeSessionId: "open-failed-after-create",
      clientMessageId: "client-failed-after-create",
      pendingClientSessionId: "pending-failed-after-create",
      materializedSession: {
        ...session({
          id: "sess-failed-after-create",
          title: "Failed after create",
        }),
        conversationId: "conv-failed-after-create",
        opencodeSessionId: "open-failed-after-create",
      },
      draftDisposition: "restore",
      debugTrace: [
        { source: "server", event: "run_submit_failed_after_materialization" },
      ],
    }),
  });
  const workflow = createSessionCreationWorkflow(harness.options);

  const result = await workflow.createSessionAndOpen("hello", {
    submitDraft: {
      mode: "prompt",
      text: "hello",
      resolvedText: "hello",
      parts: [{ type: "text", text: "hello" }],
    },
    clientMessageId: "client-failed-after-create",
    onSubmitResult: (submitResult) => submitResults.push(submitResult),
  });

  assert.equal(result, "sess-failed-after-create");
  assert.ok(harness.actions.includes("set-sessions"));
  assert.ok(harness.actions.includes("select:sess-failed-after-create"));
  assert.equal(submitResults.length, 1);
  assert.deepEqual(harness.errors, [null]);
});

test("typed first-submit rejection does not become a raw session creation error", async () => {
  const submitResults: unknown[] = [];
  const harness = createHarness({
    submitConversationFromVesloWriteApi: async () => ({
      status: "blocked",
      code: "attachment_format_unsupported",
      message: "raw server fallback must not own the UI",
      recoverable: true,
      workspaceId: "ws-main",
      conversationId: "",
      opencodeSessionId: "",
      clientMessageId: "client-msg-rejected",
      pendingClientSessionId: "pending-msg-rejected",
      materializedSession: null,
      draftDisposition: "restore",
      details: {
        attachmentName: "message.msg",
        format: "MSG",
      },
      debugTrace: [],
    }),
  });
  const workflow = createSessionCreationWorkflow(harness.options);

  const result = await workflow.createSessionAndOpen("", {
    submitDraft: {
      mode: "prompt",
      text: "",
      resolvedText: "",
      parts: [],
      attachments: [
        {
          name: "message.msg",
          mimeType: "application/octet-stream",
          kind: "file",
          dataUrl: "data:application/octet-stream;base64,AA==",
        },
      ],
    },
    clientMessageId: "client-msg-rejected",
    onSubmitResult: (submitResult) => submitResults.push(submitResult),
  });

  assert.equal(result, undefined);
  assert.equal(submitResults.length, 1);
  assert.deepEqual(harness.errors, [null]);
  assert.ok(
    harness.events.includes(
      "createSessionAndOpen:submit-stopped-materialization",
    ),
  );
  assert.doesNotMatch(harness.actions.join("\n"), /set-sessions|select:|go:/);
});

test("session creation passes the prepared create preflight to conversation creation", async () => {
  let observedPreflight: SessionCreationPreflightContext | undefined;
  const harness = createHarness({
    ensureLocalRuntimeReachableForSend: async (_reason, preflight) => {
      preflight.runtimeHealthOk = true;
      return true;
    },
    ensureManagedAiBootstrapReady: async (preflight) => {
      preflight.managedAiReady = true;
      return true;
    },
    resolveRuntimeSandboxStateForTarget: () => ({ mode: "test" }),
    createConversationFromVesloWriteApi: async (
      _workspaceId,
      _directory,
      _title,
      preflight,
    ) => {
      observedPreflight = preflight;
      return {
        ...session(),
        conversationId: "conv-created",
        opencodeSessionId: "open-created",
      };
    },
  });
  const workflow = createSessionCreationWorkflow(harness.options);

  const result = await workflow.createSessionAndOpen("hello");

  assert.equal(result, "sess-created");
  assert.equal(observedPreflight?.traceId, "trace-active");
  assert.equal(observedPreflight?.runtimeHealthOk, true);
  assert.equal(observedPreflight?.enginePrepared, true);
  assert.equal(observedPreflight?.managedAiReady, true);
  assert.deepEqual(observedPreflight?.targetWorkspace, targetWorkspace);
  assert.deepEqual(observedPreflight?.effectiveSandbox, { mode: "test" });
  assert.equal(
    observedPreflight?.conversationWorkspaceByDirectory instanceof Map,
    true,
  );
});

test("session creation recovers a stale local Veslo bearer during first create", async () => {
  let createCalls = 0;
  const ensureForceRecoveryValues: boolean[] = [];
  const harness = createHarness({
    ensureLocalRuntimeReachableForSend: async (_reason, preflight) => {
      ensureForceRecoveryValues.push(preflight.forceRecovery === true);
      preflight.runtimeHealthOk = true;
      preflight.enginePrepared = true;
      if (preflight.forceRecovery) preflight.forceRecovery = false;
      return true;
    },
    createConversationFromVesloWriteApi: async () => {
      createCalls += 1;
      if (createCalls === 1) {
        throw new Error(
          '{"code":"unauthorized","message":"Invalid bearer token"}',
        );
      }
      return {
        ...session({ id: "sess-recovered" }),
        conversationId: "conv-recovered",
        opencodeSessionId: "open-recovered",
      };
    },
  });
  const workflow = createSessionCreationWorkflow(harness.options);

  const result = await workflow.createSessionAndOpen("hello");

  assert.equal(result, "sess-recovered");
  assert.equal(createCalls, 2);
  assert.deepEqual(ensureForceRecoveryValues, [false, true]);
  assert.ok(
    harness.events.includes(
      "createSessionAndOpen:create-runtime-recovery-start",
    ),
  );
  assert.ok(
    harness.events.includes(
      "createSessionAndOpen:create-runtime-recovery-result",
    ),
  );
  assert.ok(harness.events.includes("createSessionAndOpen:create-ok"));
});

test("session creation can return a backend result without route or sidebar effects", async () => {
  const harness = createHarness();
  const workflow = createSessionCreationWorkflow(harness.options);

  const result = await workflow.createSession("hello", {
    blockAppDuringCreate: false,
  });

  assert.equal(result?.sessionId, "sess-created");
  assert.equal(result?.workspaceScope.workspaceId, "ws-main");
  assert.equal(result?.workspaceScope.directory, "/repo");
  assert.equal(result?.handoff, null);
  assert.deepEqual(harness.actions, [
    "ensure-runtime",
    "ensure-managed-ai",
    "abort-refreshes",
    "create-conversation",
  ]);
  assert.doesNotMatch(
    harness.actions.join("\n"),
    /set-sessions|materialize-sidebar|select:|go:/,
  );
});

test("session creation materializes sidebar state and own-navigation guard before selecting", async () => {
  const pendingSession: PendingSidebarSessionMetadata = {
    id: "pending-1",
    workspaceId: "ws-main",
    workspaceRoot: "/repo",
    title: "hello",
    createdAt: 10,
  };
  const harness = createHarness();
  const workflow = createSessionCreationWorkflow(harness.options);

  const result = await workflow.createSessionAndOpen("hello", {
    pendingSession,
    clientMessageId: "client-1",
    sendTraceId: "trace-1",
    onMaterializedSessionId: (handoff) => harness.handoffs.push(handoff),
  });

  assert.equal(result, "sess-created");
  assert.equal(harness.handoffs[0]?.pendingSessionKey, "pending-1");
  assert.equal(harness.handoffs[0]?.clientMessageId, "client-1");

  const order = harness.actions.join("\n");
  assert.match(
    order,
    /create-conversation[\s\S]*remember-scope[\s\S]*set-sessions[\s\S]*materialize-sidebar[\s\S]*own:sess-created[\s\S]*select:sess-created[\s\S]*own:sess-created[\s\S]*go:sess-created/,
  );
  assert.deepEqual(harness.progressEvents, [
    "session.creating",
    "session.loading",
    "flow.idle",
  ]);
});
