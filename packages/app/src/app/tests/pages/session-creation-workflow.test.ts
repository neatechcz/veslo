import assert from "node:assert/strict";
import test from "node:test";

import type { Session } from "@opencode-ai/sdk/v2/client";

import {
  createSessionCreationWorkflow,
  type SessionCreationWorkflowOptions,
} from "../../pages/session-creation-workflow.js";
import type { SessionFlowProgressEvent } from "../../context/session-flow-progress-presenter.js";
import type { SendRuntimePreflightContext } from "../../context/send-runtime-readiness.js";
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

function createHarness(overrides: Partial<SessionCreationWorkflowOptions> = {}): Harness {
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
    ensureLocalRuntimeReachableForSend: async () => {
      actions.push("ensure-runtime");
      return true;
    },
    ensureManagedAiBootstrapReady: async () => {
      actions.push("ensure-managed-ai");
      return true;
    },
    isWorkspaceClientStaleError: (_error): _error is {
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
    resolveWorkspaceRootForConversationScope: (_workspaceId, directory) => directory,
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
  assert.deepEqual(harness.errors, ["Please wait for the workspace switch to complete."]);
  assert.deepEqual(harness.progressEvents, []);
  assert.ok(harness.events.includes("createSessionAndOpen:blocked-connecting"));
  assert.doesNotMatch(harness.actions.join("\n"), /create-conversation|select:/);
});

test("session creation reuses send preflight readiness without rerunning runtime gates", async () => {
  const preflight: SendRuntimePreflightContext = {
    traceId: "trace-send",
    targetWorkspace,
    enginePrepared: true,
    runtimeHealthOk: false,
    managedAiReady: true,
  };
  const harness = createHarness();
  const workflow = createSessionCreationWorkflow(harness.options);

  const result = await workflow.createSessionAndOpen("hello", {
    preflight,
  });

  assert.equal(result, "sess-created");
  assert.equal(preflight.enginePrepared, true);
  assert.equal(preflight.managedAiReady, true);
  assert.ok(harness.events.includes("createSessionAndOpen:health-skip"));
  assert.ok(harness.events.includes("createSessionAndOpen:managed-ai-bootstrap-skip"));
  assert.doesNotMatch(harness.actions.join("\n"), /ensure-runtime|ensure-managed-ai/);
});

test("session creation lets server submit own first-message runtime admission", async () => {
  const observedPreflights: Array<SendRuntimePreflightContext | undefined> = [];
  const harness = createHarness({
    ensureLocalRuntimeReachableForSend: async () => {
      throw new Error("runtime gate should not run before server submit materialization");
    },
    ensureManagedAiBootstrapReady: async () => {
      throw new Error("managed AI gate should not run before server submit materialization");
    },
    routedClientForSendTarget: () => {
      throw new Error("routed client should not be required before server submit materialization");
    },
    submitConversationFromVesloWriteApi: async (_workspaceId, _directory, input, preflight) => {
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
    preflight: {
      traceId: "trace-submit",
      targetWorkspace,
      runtimeHealthOk: false,
    },
  });

  assert.equal(result, "sess-submit");
  assert.equal(observedPreflights.length, 1);
  assert.equal(observedPreflights[0]?.enginePrepared, undefined);
  assert.equal(observedPreflights[0]?.managedAiReady, undefined);
  assert.ok(harness.events.includes("createSessionAndOpen:server-submit-runtime-admission-skip"));
  assert.ok(harness.events.includes("createSessionAndOpen:server-submit-managed-ai-admission-skip"));
  assert.doesNotMatch(harness.actions.join("\n"), /ensure-runtime|ensure-managed-ai|create-conversation/);
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
        ...session({ id: "sess-failed-after-create", title: "Failed after create" }),
        conversationId: "conv-failed-after-create",
        opencodeSessionId: "open-failed-after-create",
      },
      draftDisposition: "restore",
      debugTrace: [{ source: "server", event: "run_submit_failed_after_materialization" }],
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

test("session creation passes the prepared create preflight to conversation creation", async () => {
  let observedPreflight: SendRuntimePreflightContext | undefined;
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
    createConversationFromVesloWriteApi: async (_workspaceId, _directory, _title, preflight) => {
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
  assert.deepEqual(harness.actions, ["ensure-runtime", "ensure-managed-ai", "abort-refreshes", "create-conversation"]);
  assert.doesNotMatch(harness.actions.join("\n"), /set-sessions|materialize-sidebar|select:|go:/);
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
  assert.deepEqual(harness.progressEvents, ["session.creating", "session.loading", "flow.idle"]);
});
