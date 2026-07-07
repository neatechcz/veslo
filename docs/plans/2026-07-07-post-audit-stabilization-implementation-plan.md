# Post-Audit Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize the risky surfaces found in the last-10-commit audit: first-session submit materialization failures, inert queue policy, manual Pilot dev-runtime blast radius, and contradictory rollout docs.

**Architecture:** Keep the normal server-owned composer submit path intact. Add narrow contracts and tests around the exact boundary failures instead of reworking the workflow. Treat the current manual Pilot `pnpm dev` diff as a separate dev-runtime policy correction so product submit fixes can ship independently.

**Tech Stack:** TypeScript, Bun server tests, Node `node:test` app tests, Tauri dev launcher scripts, Markdown docs.

## Global Constraints

- Work from the nested git root: `C:\Users\jajse\Desktop\Shoptet_upravy\neatech\veslo\veslo`.
- Do not overwrite unrelated tracked worktree changes in `docs/dev/testing-playbook.md`, `docs/testing/tauri-pilot/README.md`, or `packages/desktop/scripts/tauri-dev.mjs`; inspect and edit only the hunks needed for this plan.
- Keep the server-owned composer submit path fail-closed for existing sessions; do not reintroduce app-owned legacy fallback as a hidden recovery path.
- Keep `pilot:default` out of release/default Tauri capabilities.
- Use TDD for behavior changes: write the failing test, run it red, implement the minimal change, run it green.
- Commit each task independently when executed.

---

## File Structure

- `packages/server/src/conversation-submit-contract.ts`
  - Owns the server submit result union. Add optional materialized-session fields to `blocked` and `failed` results for the specific case where first-session materialization has already happened.
- `packages/server/src/conversation-submit-service.ts`
  - Owns idempotent first-session materialization and submit result persistence. Attach materialized session metadata to post-materialization `blocked`/`failed` results.
- `packages/server/src/tests/conversation-submit-service.test.ts`
  - Unit coverage for post-materialization submit failure before route-level wiring.
- `packages/server/src/tests/server-conversations.test.ts`
  - Route-level coverage that a failing upstream `/prompt_async` after first-session creation returns materialized metadata and stays idempotent.
- `packages/app/src/app/lib/veslo-server/types.ts`
  - App-side mirror of submit result types. Keep it aligned with server contract until this file is generated automatically.
- `packages/app/src/app/pages/session-creation-workflow.ts`
  - Convert submit results with materialized metadata into a real created session even when the run submit failed or blocked after creation.
- `packages/app/src/app/pages/session-send-workflow.ts`
  - Stop first-session send cleanly after opening the materialized session when the server submit result is `failed` or `blocked`.
- `packages/app/src/app/tests/pages/session-creation-workflow.test.ts`
  - Unit coverage for materialized failure handoff during create.
- `packages/app/src/app/tests/pages/session-send-workflow.test.ts`
  - Unit coverage for first-session send failure after materialization.
- `packages/server/src/conversation-run-lifecycle-controller.ts`
  - Carry `submitQueuePolicy` into run lifecycle admission and make `server-queue-only` use the queue path explicitly.
- `packages/server/src/routes/conversations.ts`
  - Forward `request.options.submitQueuePolicy` into the lifecycle controller.
- `packages/server/src/tests/conversation-run-lifecycle-controller.test.ts`
  - Unit coverage that `server-queue-only` queues immediately instead of behaving like a dead option.
- `packages/desktop/scripts/tauri-dev.mjs`
  - Make manual Pilot runtime explicit opt-in, while preserving the existing diagnostic mode behind a flag/env var.
- `packages/desktop/scripts/tauri-dev.test.mjs`
  - Guard the manual Pilot launcher contract.
- `packages/desktop/package.json`
  - Add an explicit `dev:pilot` script if the task chooses a CLI flag rather than requiring manual environment variables.
- `docs/dev/server-owned-composer-submit.md`
  - Update BSW07B wording to match the promoted replacement workflow.
- `docs/fixes/2026-07-07-fix-37-server-owned-composer-send-workflow-complete.md`
  - Remove the stale claim that BSW07B remains outside the completed gate.
- `docs/dev/testing-playbook.md`
  - Mention the explicit manual Pilot command after the dev launcher default is narrowed.
- `docs/testing/tauri-pilot/README.md`
  - Keep Pilot docs aligned with the new explicit manual runtime command.

## Task 1: Preserve Materialized First-Session Metadata On Server Submit Failure

**Files:**
- Modify: `packages/server/src/conversation-submit-contract.ts:122-136`
- Modify: `packages/server/src/conversation-submit-service.ts:81-314`
- Test: `packages/server/src/tests/conversation-submit-service.test.ts`

**Interfaces:**
- Consumes: `ConversationSubmitResult`, `ConversationSubmitBlockedResult`, `ConversationSubmitFailedResult`
- Produces: `materializeFailedSubmitResult(payload, materializedSession, request, workspaceId): ConversationSubmitBlockedResult | ConversationSubmitFailedResult`

- [ ] **Step 1: Write the failing service test**

Add this test near the existing `conversation-submit-service.test.ts` submit-materialization tests:

```ts
test("first-session submit failure after materialization returns materialized session metadata", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-submit-service-materialized-failed-"));
  tempDirs.push(workspaceRoot);
  let createConversationCalls = 0;
  const service = createConversationSubmitService({
    attemptStore: createConversationSubmitAttemptStore({
      dbPath: await createTempDbPath("veslo-submit-service-materialized-failed-db-"),
    }),
    conversationService: createConversationServiceStub(() => {
      createConversationCalls += 1;
    }),
    documentRuntimeStatus: () => createDocumentRuntimeStatusPayload({ status: "ready" }),
  });

  const result = await service.submit({
    workspace: workspace(workspaceRoot),
    body: {
      clientMessageId: "msg-materialized-run-failed",
      origin: "session:normal",
      target: { directory: workspaceRoot, pendingClientSessionId: "pending-materialized" },
      draft: { text: "Create then fail" },
      options: {},
    },
    submitResolvedRun: async () => {
      throw new ApiError(502, "opencode_proxy_failed", "OpenCode prompt failed");
    },
  });

  expect(result.httpStatus).toBe(200);
  expect(result.payload.status).toBe("failed");
  expect(result.payload.code).toBe("opencode_proxy_failed");
  expect(result.payload.draftDisposition).toBe("restore");
  expect("materializedSession" in result.payload ? result.payload.materializedSession : null).toMatchObject({
    id: "sess-created",
    conversationId: "conv-created",
    opencodeSessionId: "sess-created",
  });
  expect("conversationId" in result.payload ? result.payload.conversationId : null).toBe("conv-created");
  expect("opencodeSessionId" in result.payload ? result.payload.opencodeSessionId : null).toBe("sess-created");
  expect("pendingClientSessionId" in result.payload ? result.payload.pendingClientSessionId : null).toBe("pending-materialized");
  expect(createConversationCalls).toBe(1);
});
```

- [ ] **Step 2: Run the test red**

Run:

```powershell
bun test packages/server/src/tests/conversation-submit-service.test.ts -t "first-session submit failure after materialization returns materialized session metadata"
```

Expected: FAIL because `failed` results do not currently carry `materializedSession`, `conversationId`, or `opencodeSessionId`.

- [ ] **Step 3: Extend submit result types**

In `packages/server/src/conversation-submit-contract.ts`, extend blocked and failed results with optional materialized fields:

```ts
export type ConversationSubmitBlockedResult = {
  status: "blocked";
  code: string;
  message: string;
  workspaceId?: string;
  conversationId?: string;
  opencodeSessionId?: string;
  clientMessageId?: string;
  pendingClientSessionId?: string | null;
  materializedSession?: unknown | null;
  draftDisposition: "restore" | "keep";
  recoverable: boolean;
};

export type ConversationSubmitFailedResult = {
  status: "failed";
  code: string;
  message: string;
  workspaceId?: string;
  conversationId?: string;
  opencodeSessionId?: string;
  clientMessageId?: string;
  pendingClientSessionId?: string | null;
  materializedSession?: unknown | null;
  draftDisposition: "restore" | "mark-failed";
  debugTrace?: ConversationSubmitDebugTraceEntry[];
};
```

- [ ] **Step 4: Add a local helper in `conversation-submit-service.ts`**

Add this helper inside `createConversationSubmitService`, near `completeAttempt`:

```ts
      const withMaterializedSession = <T extends ConversationSubmitBlockedResult | ConversationSubmitFailedResult>(
        payload: T,
        materializedSession: Awaited<ReturnType<typeof conversationService.createConversation>>,
      ): T => ({
        ...payload,
        workspaceId: workspace.id,
        conversationId: materializedSession.conversationId,
        opencodeSessionId: materializedSession.opencodeSessionId,
        clientMessageId: request.clientMessageId,
        pendingClientSessionId: request.target?.pendingClientSessionId ?? null,
        materializedSession,
      });
```

If TypeScript rejects `ReturnType<typeof conversationService.createConversation>` because of interface narrowing, replace that helper parameter with:

```ts
        materializedSession: {
          conversationId: string;
          opencodeSessionId: string;
        } & Record<string, unknown>,
```

- [ ] **Step 5: Attach metadata to post-materialization failure paths**

In the `submitResolvedRun` branch after `conversationService.createConversation`, change the blocked/failed result return and catch block to use the helper:

```ts
            if (result.payload.status === "blocked" || result.payload.status === "failed") {
              const materializedPayload = withMaterializedSession(result.payload, materializedSession);
              return {
                payload: completeAttempt(
                  materializedPayload,
                  result.payload.status === "blocked" ? "blocked" : "failed",
                ),
                httpStatus: result.httpStatus,
              };
            }
```

```ts
            const payload: ConversationSubmitResult = withMaterializedSession({
              status: "failed",
              code: error instanceof ApiError ? error.code : "run_submit_failed",
              message: error instanceof Error ? error.message : "Run submit failed",
              draftDisposition: "restore",
              debugTrace: [{
                source: "server",
                event: "run_submit_failed_after_materialization",
                upstreamCode: error instanceof ApiError ? error.code : null,
                upstreamStatus: error instanceof ApiError ? error.status : null,
              }],
            }, materializedSession);
```

- [ ] **Step 6: Run the focused server test green**

Run:

```powershell
bun test packages/server/src/tests/conversation-submit-service.test.ts -t "first-session submit failure after materialization returns materialized session metadata"
```

Expected: PASS.

- [ ] **Step 7: Run the full submit service tests**

Run:

```powershell
bun test packages/server/src/tests/conversation-submit-service.test.ts
```

Expected: all tests pass.

- [ ] **Step 8: Commit Task 1**

```powershell
git add packages/server/src/conversation-submit-contract.ts packages/server/src/conversation-submit-service.ts packages/server/src/tests/conversation-submit-service.test.ts
git commit -m "fix: preserve materialized submit failure metadata"
```

## Task 2: Route-Level Regression For First-Session Failure After OpenCode Create

**Files:**
- Modify: `packages/server/src/tests/server-conversations.test.ts`

**Interfaces:**
- Consumes: Task 1 server submit result contract.
- Produces: Route-level evidence that `/workspace/:id/conversations/submit` returns materialized metadata and idempotent result when `/session/:id/prompt_async` fails.

- [ ] **Step 1: Write the failing route test**

Add this test after `POST /workspace/:id/conversations/submit materializes and submits a first conversation idempotently`:

```ts
test("POST /workspace/:id/conversations/submit returns materialized session when first run submit fails", async () => {
  await useTempVesloDataDir();
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-conversations-submit-materialized-failed-"));
  tempDirs.push(workspaceRoot);
  const upstreamRequests: string[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      upstreamRequests.push(url.pathname);
      if (request.method === "POST" && url.pathname === "/session") {
        return Response.json({
          id: "sess-submit-created-failed",
          title: "Create then fail",
          time: { created: Date.now(), updated: Date.now() },
          directory: workspaceRoot,
        });
      }
      if (request.method === "POST" && url.pathname === "/session/sess-submit-created-failed/prompt_async") {
        return Response.json({ error: "prompt failed" }, { status: 502 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  runningServers.push({ stop: () => upstream.stop(true) });
  const server = createTestServer({
    workspaces: [{ id: "ws_1", name: "Workspace", path: workspaceRoot, workspaceType: "local" }],
    opencodeBaseUrl: `http://${upstream.hostname}:${upstream.port}`,
  });

  const submit = () =>
    fetch(`${server.url}/workspace/ws_1/conversations/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer client-token",
        "x-veslo-send-trace-id": "submit-materialized-failed-trace",
      },
      body: JSON.stringify({
        clientMessageId: "msg-submit-materialized-failed",
        origin: "session:normal",
        target: { directory: workspaceRoot, pendingClientSessionId: "pending-submit-materialized-failed" },
        draft: { text: "Create then fail" },
        options: { submitQueuePolicy: "normal" },
      }),
    });

  const response = await submit();
  expect(response.status).toBe(200);
  const payload = await response.json() as {
    status?: string;
    code?: string;
    conversationId?: string;
    opencodeSessionId?: string;
    pendingClientSessionId?: string | null;
    materializedSession?: { id?: string; conversationId?: string; opencodeSessionId?: string };
    draftDisposition?: string;
  };
  expect(payload.status).toBe("failed");
  expect(payload.draftDisposition).toBe("restore");
  expect(payload.conversationId).toBeTruthy();
  expect(payload.opencodeSessionId).toBe("sess-submit-created-failed");
  expect(payload.pendingClientSessionId).toBe("pending-submit-materialized-failed");
  expect(payload.materializedSession?.id).toBe("sess-submit-created-failed");
  expect(payload.materializedSession?.conversationId).toBe(payload.conversationId);
  expect(payload.materializedSession?.opencodeSessionId).toBe("sess-submit-created-failed");

  const retryResponse = await submit();
  expect(retryResponse.status).toBe(200);
  expect(await retryResponse.json()).toEqual(payload);
  expect(upstreamRequests).toEqual([
    "/session",
    "/session/sess-submit-created-failed/prompt_async",
  ]);
});
```

- [ ] **Step 2: Run the route test red or green depending on Task 1**

Run:

```powershell
bun test packages/server/src/tests/server-conversations.test.ts -t "returns materialized session when first run submit fails"
```

Expected before Task 1: FAIL. Expected after Task 1: PASS.

- [ ] **Step 3: Run the focused conversation route group**

Run:

```powershell
bun test packages/server/src/tests/server-conversations.test.ts -t "POST /workspace/:id/conversations/submit"
```

Expected: all submit route tests pass.

- [ ] **Step 4: Commit Task 2**

```powershell
git add packages/server/src/tests/server-conversations.test.ts
git commit -m "test: cover materialized first-submit failure route"
```

## Task 3: Let The App Open Materialized Sessions Even When First Run Submit Failed

**Files:**
- Modify: `packages/app/src/app/lib/veslo-server/types.ts:1459-1472`
- Modify: `packages/app/src/app/pages/session-creation-workflow.ts:159-184`
- Modify: `packages/app/src/app/pages/session-send-workflow.ts:1568-1592`
- Test: `packages/app/src/app/tests/pages/session-creation-workflow.test.ts`
- Test: `packages/app/src/app/tests/pages/session-send-workflow.test.ts`

**Interfaces:**
- Consumes: Task 1 `failed`/`blocked` submit result optional materialized fields.
- Produces: A materialized session can be selected/opened, while the submitted draft is restored and an error is shown for the failed run submit.

- [ ] **Step 1: Update app submit result mirror types**

In `packages/app/src/app/lib/veslo-server/types.ts`, add the same optional materialized fields to `blocked` and `failed` union members:

```ts
  | {
      status: "blocked";
      code: string;
      message: string;
      workspaceId?: string;
      conversationId?: string;
      opencodeSessionId?: string;
      clientMessageId?: string;
      pendingClientSessionId?: string | null;
      materializedSession?: unknown | null;
      draftDisposition: "restore" | "keep";
      recoverable: boolean;
    }
  | {
      status: "failed";
      code: string;
      message: string;
      workspaceId?: string;
      conversationId?: string;
      opencodeSessionId?: string;
      clientMessageId?: string;
      pendingClientSessionId?: string | null;
      materializedSession?: unknown | null;
      draftDisposition: "restore" | "mark-failed";
      debugTrace?: VesloConversationSubmitDebugTraceEntry[];
    };
```

- [ ] **Step 2: Write the failing session creation test**

Add this test after `session creation lets server submit own first-message runtime admission`:

```ts
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
    submitDraft: { text: "hello" },
    clientMessageId: "client-failed-after-create",
    onSubmitResult: (submitResult) => submitResults.push(submitResult),
  });

  assert.equal(result, "sess-failed-after-create");
  assert.ok(harness.actions.includes("set-sessions"));
  assert.ok(harness.actions.includes("select:sess-failed-after-create"));
  assert.equal(submitResults.length, 1);
  assert.deepEqual(harness.errors, []);
});
```

- [ ] **Step 3: Run the creation test red**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-creation-workflow.test.ts --test-name-pattern "opens a materialized session"
```

Expected: FAIL because `createdSessionFromSubmitResult` throws on `failed`.

- [ ] **Step 4: Change `createdSessionFromSubmitResult` to prefer materialized metadata**

Replace the early failed/blocked throw in `packages/app/src/app/pages/session-creation-workflow.ts` with:

```ts
    if (result.status !== "materialized" && result.status !== "submitted" && result.status !== "queued" &&
      result.status !== "blocked" && result.status !== "failed") {
      throw new Error(`Conversation submit returned ${result.status} before session materialization was complete.`);
    }
    const materialized = result.materializedSession;
    if (!materialized || typeof materialized !== "object" || Array.isArray(materialized)) {
      if (result.status === "blocked" || result.status === "failed") {
        throw new Error(result.message);
      }
      throw new Error("Conversation submit did not return a materialized session.");
    }
```

Keep the existing return shape, including:

```ts
      conversationId: result.conversationId,
      opencodeSessionId: result.opencodeSessionId,
```

- [ ] **Step 5: Run the creation test green**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-creation-workflow.test.ts --test-name-pattern "opens a materialized session"
```

Expected: PASS.

- [ ] **Step 6: Write the failing first-send workflow test**

Add this test near the first server-submit creation tests in `session-send-workflow.test.ts`:

```ts
test("session send workflow opens first materialized session and reports failed server submit", async () => {
  const createOptions: Array<Parameters<SessionSendWorkflowOptions["createSessionAndOpen"]>[1]> = [];
  const harness = createHarness({
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
  });
  const workflow = createSessionSendWorkflow(harness.options);

  const accepted = await workflow.sendPrompt({
    content: "hello",
    sessionID: null,
    clientMessageId: "client-first-failed",
  });

  assert.equal(accepted, false);
  assert.equal(createOptions.length, 1);
  assert.ok(harness.events.includes("sendPrompt:server-submit-first-failed"));
  assert.deepEqual(harness.errors, ["OpenCode prompt failed Clear the OpenCode cache and retry."]);
  assert.ok(harness.actions.includes("append-error:sess-first-failed:OpenCode prompt failed Clear the OpenCode cache and retry."));
  assert.doesNotMatch(harness.actions.join("\n"), /run:/);
});
```

Adjust the assertion helper names to the existing harness action strings in `session-send-workflow.test.ts`; do not weaken the assertions to only check `accepted === false`.

- [ ] **Step 7: Run the first-send workflow test red**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts --test-name-pattern "opens first materialized session"
```

Expected: FAIL because the code assumes the first server submit result is `submitted` or `queued`.

- [ ] **Step 8: Handle failed/blocked first-submit results after session materialization**

In `packages/app/src/app/pages/session-send-workflow.ts`, immediately after:

```ts
    const serverFirstSubmitResult = serverFirstSubmitResultHolder.current;
    if (serverFirstSubmitResult) {
```

add:

```ts
      if (serverFirstSubmitResult.status === "failed" || serverFirstSubmitResult.status === "blocked") {
        const hintedMessage = deps.addOpencodeCacheHint(serverFirstSubmitResult.message);
        deps.recordSendTrace("sendPrompt:server-submit-first-failed", {
          traceId: sendTraceId,
          sessionID,
          clientMessageId: sendCorrelation.clientMessageId,
          origin: sendCorrelation.origin,
          status: serverFirstSubmitResult.status,
          code: serverFirstSubmitResult.code,
          draftDisposition: serverFirstSubmitResult.draftDisposition,
        });
        deps.setError(hintedMessage);
        deps.sessionStoreAppendSessionErrorTurn(sessionID, hintedMessage);
        cleanupPendingSidebarSession();
        stopSendPromptBusy();
        return false;
      }
```

Leave the existing submitted/queued success block unchanged after this guard.

- [ ] **Step 9: Run focused app tests green**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-creation-workflow.test.ts src/app/tests/pages/session-send-workflow.test.ts --test-name-pattern "materialized session|first materialized session"
```

Expected: PASS.

- [ ] **Step 10: Run the full workflow test pair**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-creation-workflow.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit Task 3**

```powershell
git add packages/app/src/app/lib/veslo-server/types.ts packages/app/src/app/pages/session-creation-workflow.ts packages/app/src/app/pages/session-send-workflow.ts packages/app/src/app/tests/pages/session-creation-workflow.test.ts packages/app/src/app/tests/pages/session-send-workflow.test.ts
git commit -m "fix: handle materialized first-submit failures in app"
```

## Task 4: Make Submit Queue Policy Observable And Enforced

**Files:**
- Modify: `packages/server/src/conversation-run-lifecycle-controller.ts:125-136`
- Modify: `packages/server/src/conversation-run-lifecycle-controller.ts:356-414`
- Modify: `packages/server/src/conversation-run-lifecycle-controller.ts:1077-1109`
- Modify: `packages/server/src/routes/conversations.ts:606-617`
- Test: `packages/server/src/tests/conversation-run-lifecycle-controller.test.ts`
- Test: `packages/server/src/tests/server-conversations.test.ts`

**Interfaces:**
- Consumes: `request.options.submitQueuePolicy`
- Produces: `ConversationRunLifecycleSubmitInput.submitQueuePolicy?: "normal" | "send-now" | "server-queue-only"`

- [ ] **Step 1: Add lifecycle input type**

In `packages/server/src/conversation-run-lifecycle-controller.ts`, add a local exported policy type:

```ts
export type ConversationRunLifecycleSubmitQueuePolicy = "normal" | "send-now" | "server-queue-only";
```

Then extend `ConversationRunLifecycleSubmitInput`:

```ts
  submitQueuePolicy?: ConversationRunLifecycleSubmitQueuePolicy;
```

- [ ] **Step 2: Write the failing lifecycle test**

Add this test after `submitRun registers inactive local runs before submitting`:

```ts
test("submitRun queues immediately for server-queue-only policy", async () => {
  const { controller, lifecycle, queue, submitCalls, timers } = controllerHarness();

  const result = await controller.submitRun(submitInput({
    submitQueuePolicy: "server-queue-only",
  }));

  expect(result.httpStatus).toBe(202);
  expect(result.payload.status).toBe("queued");
  expect(result.payload.reservedRunId).toBe("run-reserved");
  expect(result.payload.queueItemId).toBe("queue-1");
  expect(result.payload.activeRunId).toBe(null);
  expect(lifecycle.calls).toEqual([]);
  expect(queue.enqueueCalls[0]?.activeRunId).toBe(null);
  expect(submitCalls).toEqual([]);
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([1_500]);
});
```

- [ ] **Step 3: Run the lifecycle test red**

Run:

```powershell
bun test packages/server/src/tests/conversation-run-lifecycle-controller.test.ts -t "server-queue-only policy"
```

Expected: FAIL because the lifecycle controller currently registers/submits immediately when no active run exists.

- [ ] **Step 4: Enforce `server-queue-only` before lifecycle active peek**

In `submitRun(input)`, after recording `server:conversation-run:lifecycle-owner`, add:

```ts
      if (input.submitQueuePolicy === "server-queue-only") {
        input.runTrace.record("server:conversation-run:queue-policy-server-only", {
          workspaceId: input.workspace.id,
          conversationId: input.target.conversationId,
          runId: input.runId,
          clientMessageId: input.clientMessageId,
          origin: input.origin,
        });
        return queueRun(input, null);
      }
```

This must run before the active-run peek and before direct `submitAcceptedRun`.

- [ ] **Step 5: Include policy in queued trace/body for diagnostics**

In `queueRun`, add the policy into the serialized body and trace payload:

```ts
      ...(input.submitQueuePolicy ? { submitQueuePolicy: input.submitQueuePolicy } : {}),
```

and:

```ts
      submitQueuePolicy: input.submitQueuePolicy ?? null,
```

- [ ] **Step 6: Forward the request policy from the route**

In `packages/server/src/routes/conversations.ts`, change the lifecycle submit call:

```ts
          submitQueuePolicy: request.options?.submitQueuePolicy ?? "normal",
```

Place it beside `origin` and `expectAiGatewayStart`.

- [ ] **Step 7: Add a route-level assertion to the existing send-now queue test**

In `server-conversations.test.ts`, keep the existing `send-now` behavior test and add a second submit request using:

```ts
options: {
  submitQueuePolicy: "server-queue-only",
},
```

Assert the response is `queued`, `draftDisposition` is `clear`, and the upstream `/prompt_async` request has not happened before the queue drain timer runs. If the existing test harness makes timer timing brittle, keep the route-level check to payload shape and rely on the lifecycle unit test for "no immediate submit".

- [ ] **Step 8: Run queue policy tests green**

Run:

```powershell
bun test packages/server/src/tests/conversation-run-lifecycle-controller.test.ts -t "server-queue-only policy"
bun test packages/server/src/tests/server-conversations.test.ts -t "send-now when lifecycle has an active run"
```

Expected: PASS.

- [ ] **Step 9: Run full server lifecycle tests**

Run:

```powershell
bun test packages/server/src/tests/conversation-run-lifecycle-controller.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 4**

```powershell
git add packages/server/src/conversation-run-lifecycle-controller.ts packages/server/src/routes/conversations.ts packages/server/src/tests/conversation-run-lifecycle-controller.test.ts packages/server/src/tests/server-conversations.test.ts
git commit -m "fix: enforce server submit queue policy"
```

## Task 5: Make Manual Tauri Pilot Runtime Explicit Opt-In

**Files:**
- Modify: `packages/desktop/scripts/tauri-dev.mjs`
- Modify: `packages/desktop/scripts/tauri-dev.test.mjs`
- Modify: `packages/desktop/package.json`
- Modify: `docs/dev/testing-playbook.md`
- Modify: `docs/testing/tauri-pilot/README.md`

**Interfaces:**
- Consumes: current manual Pilot runtime code in `tauri-dev.mjs`
- Produces: standard `pnpm --filter @neatech/veslo dev` stays standard; `pnpm --filter @neatech/veslo dev:pilot` enables manual Pilot diagnostics.

- [ ] **Step 1: Write launcher contract tests first**

Replace the current default-enabled assertion in `packages/desktop/scripts/tauri-dev.test.mjs` with source-level guards that encode opt-in behavior:

```js
test("tauri-dev keeps the manual Pilot runtime opt-in", () => {
  const source = readFileSync(scriptPath, "utf8");

  assert.match(source, /function shouldEnableManualPilotRuntime/);
  assert.match(source, /return false;/);
  assert.match(source, /VESLO_TAURI_PILOT/);
  assert.match(source, /VESLO_DEV_PILOT/);
  assert.match(source, /VESLO_E2E/);
  assert.match(source, /--veslo-pilot/);
  assert.match(source, /manual-pilot/);
  assert.match(source, /pilot:default/);
  assert.match(source, /TAURI_PILOT_SOCKET/);
  assert.match(source, /"--features"/);
  assert.match(source, /"e2e"/);
});
```

- [ ] **Step 2: Run the launcher test red**

Run:

```powershell
node --test packages/desktop/scripts/tauri-dev.test.mjs
```

Expected: FAIL while `shouldEnableManualPilotRuntime()` still defaults to `true` and no explicit CLI flag exists.

- [ ] **Step 3: Add an internal Pilot flag parser**

In `packages/desktop/scripts/tauri-dev.mjs`, add:

```js
const MANUAL_PILOT_ARG = "--veslo-pilot";

function parseDevRuntimeArgs(argv = process.argv.slice(2)) {
  const tauriArgs = [];
  let manualPilot = false;
  for (const arg of argv) {
    if (arg === MANUAL_PILOT_ARG) {
      manualPilot = true;
      continue;
    }
    tauriArgs.push(arg);
  }
  return { manualPilot, tauriArgs };
}
```

- [ ] **Step 4: Change manual Pilot runtime default to standard mode**

Replace `shouldEnableManualPilotRuntime` with:

```js
function shouldEnableManualPilotRuntime(env = process.env, flags = { manualPilot: false }) {
  if (flags.manualPilot) return true;
  const explicit = env.VESLO_TAURI_PILOT ?? env.VESLO_DEV_PILOT ?? env.VESLO_E2E;
  if (explicit?.trim()) {
    return !isFalseyFlag(explicit);
  }
  return false;
}
```

- [ ] **Step 5: Strip internal flag before forwarding args to Tauri**

Near the current `args` construction, use:

```js
const devRuntimeArgs = parseDevRuntimeArgs();
const manualPilotRuntime = shouldEnableManualPilotRuntime(process.env, devRuntimeArgs)
  ? createManualPilotRuntime(process.env)
  : null;
```

and replace:

```js
  ...process.argv.slice(2),
```

with:

```js
  ...devRuntimeArgs.tauriArgs,
```

- [ ] **Step 6: Add explicit package script**

In `packages/desktop/package.json`, add:

```json
"dev:pilot": "node ./scripts/tauri-dev.mjs --veslo-pilot"
```

Keep existing `dev` unchanged.

- [ ] **Step 7: Update Pilot docs**

In `docs/dev/testing-playbook.md` and `docs/testing/tauri-pilot/README.md`, replace any wording that implies `pnpm dev` always starts manual Pilot diagnostics with:

````md
Manual Tauri Pilot diagnostics are opt-in. Use:

```powershell
pnpm --filter @neatech/veslo dev:pilot
```

Standard development remains:

```powershell
pnpm --filter @neatech/veslo dev
```
````

- [ ] **Step 8: Run launcher and config tests green**

Run:

```powershell
node --test packages/desktop/scripts/tauri-dev.test.mjs packages/desktop/scripts/tauri-config.test.mjs
```

Expected: PASS. `tauri-config.test.mjs` must still prove `pilot:default` is not in default/release capability.

- [ ] **Step 9: Commit Task 5**

```powershell
git add packages/desktop/scripts/tauri-dev.mjs packages/desktop/scripts/tauri-dev.test.mjs packages/desktop/package.json docs/dev/testing-playbook.md docs/testing/tauri-pilot/README.md
git commit -m "fix: make manual tauri pilot runtime opt-in"
```

## Task 6: Resolve BSW07B Documentation Drift

**Files:**
- Modify: `docs/dev/server-owned-composer-submit.md:69-72`
- Modify: `docs/fixes/2026-07-07-fix-37-server-owned-composer-send-workflow-complete.md:20-25`
- Modify: `docs/fixes/2026-07-07-fix-37-server-owned-composer-send-workflow-complete.md:77-82`
- Modify: `docs/plans/2026-07-06-server-owned-composer-send-workflow-implementation-plan.md`

**Interfaces:**
- Consumes: current implementation state where replacement submit uses `options.replaceMessageId`.
- Produces: consistent docs: BSW07B is promoted/done for server-owned replacement; BSW08A remains follow-up.

- [ ] **Step 1: Confirm current replacement route evidence**

Run:

```powershell
rg -n "replaceMessageId|revert|restore" packages/server/src/routes/conversations.ts packages/server/src/tests/server-conversations.test.ts docs/plans/2026-07-06-server-owned-composer-send-workflow-implementation-plan.md docs/fixes/2026-07-07-fix-37-server-owned-composer-send-workflow-complete.md docs/dev/server-owned-composer-submit.md
```

Expected: server route/tests contain replacement submit behavior; docs contain contradictory follow-up wording.

- [ ] **Step 2: Update server-owned composer submit doc**

In `docs/dev/server-owned-composer-submit.md`, replace:

```md
The old direct run helper remains in the app service for explicit compatibility
surfaces and tests where the submit adapter is unavailable. It is not the
normal wired input-submit path. Edit-message replacement and full queue UI API
migration remain separate follow-ups.
```

with:

```md
The old direct run helper remains in the app service for explicit compatibility
surfaces and tests where the submit adapter is unavailable. It is not the
normal wired input-submit path. Edit-message replacement is server-owned through
`options.replaceMessageId`; the full queue UI API migration remains a separate
follow-up.
```

- [ ] **Step 3: Update fix-37 completed-gate doc**

In `docs/fixes/2026-07-07-fix-37-server-owned-composer-send-workflow-complete.md`, replace the summary bullets:

```md
- BSW01A and BSW05A are included in the completed gate.
- BSW07B and BSW08A remain explicit follow-ups and are allowed to stay
  `done: false`.
- BSW06B remains a documented follow-up for full raw attachment byte staging.
```

with:

```md
- BSW01A, BSW05A, and promoted BSW07B are included in the completed gate.
- BSW08A remains an explicit follow-up and is allowed to stay `done: false`.
- BSW06B remains a documented follow-up for full raw attachment byte staging.
```

Replace the follow-up section:

```md
- BSW07B: edit-message replacement as a server-owned compensating workflow.
- BSW08A: durable server queue APIs for the full app-local draft queue UI.
```

with:

```md
- BSW08A: durable server queue APIs for the full app-local draft queue UI.
```

- [ ] **Step 4: Add a short audit note to the implementation plan**

In `docs/plans/2026-07-06-server-owned-composer-send-workflow-implementation-plan.md`, add one dated note near the existing 2026-07-07 notes:

```md
- 2026-07-07 post-audit correction: downstream docs were aligned so BSW07B is
  no longer described as an open follow-up. BSW08A remains the queue UI API
  follow-up.
```

- [ ] **Step 5: Run doc drift search**

Run:

```powershell
rg -n "BSW07B.*follow-up|Edit-message replacement.*follow-up|edit-message replacement.*separate follow-up" docs
```

Expected: no stale line says BSW07B/edit-message replacement remains a separate follow-up.

- [ ] **Step 6: Commit Task 6**

```powershell
git add docs/dev/server-owned-composer-submit.md docs/fixes/2026-07-07-fix-37-server-owned-composer-send-workflow-complete.md docs/plans/2026-07-06-server-owned-composer-send-workflow-implementation-plan.md
git commit -m "docs: align server-owned replacement status"
```

## Task 7: Final Verification Gate

**Files:**
- No code changes unless a verification failure reveals a real defect.

**Interfaces:**
- Consumes: Tasks 1-6.
- Produces: verified branch state and a short handoff note.

- [ ] **Step 1: Run server typecheck**

Run:

```powershell
pnpm --filter veslo-server typecheck
```

Expected: exit 0.

- [ ] **Step 2: Run focused server tests**

Run:

```powershell
bun test packages/server/src/tests/conversation-submit-service.test.ts packages/server/src/tests/conversation-run-lifecycle-controller.test.ts packages/server/src/tests/server-conversations.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Run app typecheck**

Run:

```powershell
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: exit 0.

- [ ] **Step 4: Run focused app workflow tests**

Run:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts src/app/tests/pages/session-creation-workflow.test.ts src/app/tests/pages/session-mutation-workflow.test.ts src/app/tests/context/conversation-service.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run desktop launcher tests**

Run:

```powershell
node --test packages/desktop/scripts/tauri-dev.test.mjs packages/desktop/scripts/tauri-config.test.mjs
```

Expected: all tests pass.

- [ ] **Step 6: Run legacy audit**

Run:

```powershell
pnpm --filter @neatech/veslo-ui audit:legacy
```

Expected: exit 0. Residual compatibility matches are allowed only where the audit doc explicitly allowlists them.

- [ ] **Step 7: Run whitespace check**

Run:

```powershell
git diff --check
```

Expected: no output.

- [ ] **Step 8: Inspect final diff**

Run:

```powershell
git status --short --branch --untracked-files=no
git diff --stat HEAD
```

Expected: only task-related files are changed since the task commits, or the branch is clean if each task was committed.

## Rollback Plan

- If Task 1 or Task 3 introduces app-visible regressions, revert the server/app materialized-failure commits together; the contract and client behavior are coupled.
- If Task 4 causes queue drain regressions, revert only the queue-policy commit. The first-session materialization fix does not depend on it.
- If Task 5 disrupts local dev startup, revert only the opt-in Pilot commit. It is intentionally isolated from submit workflow fixes.
- Docs-only Task 6 can be reverted independently.

## Self-Review

- Spec coverage: The plan covers all audit findings that looked actionable: materialized first-submit failure, inert queue policy, broad manual Pilot default, and BSW07B doc drift.
- Placeholder scan: No task uses placeholder language. Where test harness strings may differ, the plan requires adapting to existing harness action names without weakening behavior assertions.
- Type consistency: Server and app submit result unions both add the same optional materialized fields. Lifecycle policy type is local to the lifecycle controller and receives route input from `request.options.submitQueuePolicy`.
- Scope check: The tasks are independent enough to commit separately. The server/app materialized-failure tasks should be executed sequentially because Task 3 consumes Task 1's contract.
