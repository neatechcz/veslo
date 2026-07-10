import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  createConversationSubmitAttemptStore,
  deriveConversationSubmitOpenCodeSessionId,
} from "../conversation-submit-attempt-store.js";
import { createConversationBindingStore } from "../conversation-binding-store.js";
import {
  createConversationSubmitService,
} from "../conversation-submit-service.js";
import { createConversationService, type ConversationService } from "../conversation-service.js";
import { createConversationSubmitRequestHash, parseConversationSubmitRequest } from "../conversation-submit-contract.js";
import { ApiError } from "../errors.js";
import { createDocumentRuntimeStatusPayload } from "../routes/document-runtime.js";
import type { WorkspaceInfo } from "../types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

const createTempDbPath = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return join(dir, "submit-attempts.sqlite");
};

const workspace = (root: string): WorkspaceInfo => ({
  id: "ws_1",
  name: "Workspace",
  path: root,
  workspaceType: "local",
  baseUrl: "http://127.0.0.1:9",
});

const remoteWorkspace = (root: string): WorkspaceInfo => ({
  ...workspace(root),
  id: "ws_remote",
  name: "Remote",
  workspaceType: "remote",
});

const createConversationServiceStub = (
  onCreate: (input: Parameters<ConversationService["createConversation"]>[0]) => void,
): ConversationService => ({
  listConversations: async () => ({ workspaceId: "ws_1", items: [], source: "sqlite" }),
  resolveOpenCodeSessionForRead: async () => null,
  loadTranscript: async () => ({
    workspaceId: "ws_1",
    sessionId: "sess_1",
    opencodeSessionId: "sess_1",
    limit: 0,
    messages: [],
    partsByMessageId: {},
  }),
  appendTranscript: async () => ({
    workspaceId: "ws_1",
    sessionId: "sess_1",
    opencodeSessionId: "sess_1",
    limit: 0,
    messages: [],
    partsByMessageId: {},
  }),
  createConversation: async (input) => {
    onCreate(input);
    return {
      workspaceId: "ws_1",
      id: "sess_1",
      conversationId: "conv_1",
      opencodeSessionId: "sess_1",
      parentConversationId: null,
      branchId: null,
      title: "Created",
      slug: "created",
      directory: "/workspace",
      parentID: null,
      time: { created: 1, updated: 1 },
    };
  },
  importOpenCodeSessions: async () => ({ workspaceId: "ws_1", items: [] }),
});

describe("conversation submit service", () => {
  test("returns server-resolved run input in dry-run submit results", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-submit-service-dry-run-resolution-"));
    tempDirs.push(workspaceRoot);
    let createConversationCalls = 0;
    const service = createConversationSubmitService({
      attemptStore: createConversationSubmitAttemptStore({
        dbPath: await createTempDbPath("veslo-submit-service-dry-run-resolution-db-"),
      }),
      conversationService: createConversationServiceStub(() => {
        createConversationCalls += 1;
      }),
      documentRuntimeStatus: () => createDocumentRuntimeStatusPayload({ status: "ready" }),
    });

    const result = await service.submit({
      workspace: workspace(workspaceRoot),
      body: {
        clientMessageId: "msg-dry-run-resolution",
        origin: "session:normal",
        target: { directory: workspaceRoot },
        draft: {
          mode: "prompt",
          text: " /review   src/app.ts ",
          parts: [{ type: "text", text: "/review src/app.ts" }],
        },
        options: { dryRun: true },
      },
      resolveDirectory: async () => workspaceRoot,
    });

    expect(result.httpStatus).toBe(200);
    expect(result.payload).toMatchObject({
      status: "dry_run",
      resolvedRunInput: {
        kind: "command",
        command: "review",
        arguments: "src/app.ts",
      },
    });
    expect(createConversationCalls).toBe(0);
  });

  test("checkpoints a deterministic OpenCode session id before materializing a first-session submit", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-submit-service-precheckpoint-"));
    tempDirs.push(workspaceRoot);
    const attemptStore = createConversationSubmitAttemptStore({
      dbPath: await createTempDbPath("veslo-submit-service-precheckpoint-db-"),
    });
    const clientMessageId = "msg-precheckpoint";
    const expectedOpenCodeSessionId = deriveConversationSubmitOpenCodeSessionId({
      workspaceId: "ws_1",
      clientMessageId,
    });
    let attemptAtCreate: ReturnType<typeof attemptStore.get> = null;
    const service = createConversationSubmitService({
      attemptStore,
      conversationService: createConversationServiceStub((input) => {
        expect(input.requestedOpenCodeSessionId).toBe(expectedOpenCodeSessionId);
        attemptAtCreate = attemptStore.get("ws_1", clientMessageId);
      }),
      documentRuntimeStatus: () => createDocumentRuntimeStatusPayload({ status: "ready" }),
    });

    const response = await service.submit({
      workspace: workspace(workspaceRoot),
      body: {
        clientMessageId,
        origin: "session:normal",
        target: { directory: workspaceRoot },
        draft: {
          mode: "prompt",
          text: "Persist identity before session create",
          parts: [{ type: "text", text: "Persist identity before session create" }],
        },
        options: {},
      },
      resolveDirectory: async () => workspaceRoot,
    });

    expect(response.payload.status).toBe("materialized");
    expect(attemptAtCreate).toMatchObject({
      status: "materializing",
      opencodeSessionId: expectedOpenCodeSessionId,
      conversationId: null,
    });
    expect(attemptStore.get("ws_1", clientMessageId)).toMatchObject({
      status: "materialized",
      opencodeSessionId: "sess_1",
      conversationId: "conv_1",
    });
  });

  test("reuses a stored materialized target when resultJson is absent", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-submit-service-stored-target-"));
    tempDirs.push(workspaceRoot);
    const attemptStore = createConversationSubmitAttemptStore({
      dbPath: await createTempDbPath("veslo-submit-service-stored-target-db-"),
    });
    const clientMessageId = "msg-stored-target";
    const body = {
      clientMessageId,
      origin: "session:normal",
      target: { directory: workspaceRoot },
      draft: {
        mode: "prompt",
        text: "Resume the stored target",
        parts: [{ type: "text", text: "Resume the stored target" }],
      },
      options: {},
    };
    attemptStore.claim({
      workspaceId: "ws_1",
      clientMessageId,
      requestHash: createConversationSubmitRequestHash(parseConversationSubmitRequest(body)),
    });
    attemptStore.update({
      workspaceId: "ws_1",
      clientMessageId,
      status: "materialized",
      conversationId: "conv-stored",
      opencodeSessionId: "sess-stored",
    });
    let createConversationCalls = 0;
    let submitRunCalls = 0;
    const service = createConversationSubmitService({
      attemptStore,
      conversationService: createConversationServiceStub(() => {
        createConversationCalls += 1;
      }),
      documentRuntimeStatus: () => createDocumentRuntimeStatusPayload({ status: "ready" }),
    });

    const response = await service.submit({
      workspace: workspace(workspaceRoot),
      body,
      resolveDirectory: async () => workspaceRoot,
      submitResolvedRun: async (input) => {
        submitRunCalls += 1;
        expect(input.request.target).toMatchObject({
          conversationId: "conv-stored",
          opencodeSessionId: "sess-stored",
        });
        return {
          httpStatus: 200,
          payload: {
            status: "submitted",
            workspaceId: "ws_1",
            conversationId: "conv-stored",
            opencodeSessionId: "sess-stored",
            runId: "run-stored",
            clientMessageId,
            draftDisposition: "clear",
          },
        };
      },
    });

    expect(response.payload.status).toBe("submitted");
    expect(createConversationCalls).toBe(0);
    expect(submitRunCalls).toBe(1);
  });

  test("a new service instance recovers the one upstream session after a pre-checkpoint process loss", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "veslo-submit-service-recovery-"));
    tempDirs.push(dataDir);
    const workspaceRoot = join(dataDir, "workspace");
    const attemptDbPath = join(dataDir, "submit-attempts.sqlite");
    const clientMessageId = "msg-recover-precheckpoint";
    const requestedOpenCodeSessionId = deriveConversationSubmitOpenCodeSessionId({
      workspaceId: "ws_1",
      clientMessageId,
    });
    const upstreamSessions = new Map<string, Record<string, unknown>>([
      [requestedOpenCodeSessionId, {
        id: requestedOpenCodeSessionId,
        title: "Recovered first session",
        directory: workspaceRoot,
        parentID: null,
        time: { created: 100, updated: 100 },
      }],
    ]);
    const upstreamCreateIds: string[] = [];
    const createConversationServiceForRecovery = () => createConversationService({
      readStore: {
        listConversations: async (input) => ({ workspaceId: input.workspaceId, items: [], source: "sqlite" as const }),
        getTranscript: async (input) => ({
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          limit: input.limit,
          messages: [],
          partsByMessageId: {},
          fetchedAt: 100,
          source: "sqlite" as const,
        }),
      },
      bindingStore: createConversationBindingStore({ dataDir }),
      createOpenCodeSession: async (input) => {
        const id = input.requestedOpenCodeSessionId;
        expect(id).toBe(requestedOpenCodeSessionId);
        upstreamCreateIds.push(id ?? "");
        const session = id ? upstreamSessions.get(id) : undefined;
        if (!session) throw new Error("upstream session identity was not recoverable");
        return session;
      },
    });
    const body = {
      clientMessageId,
      origin: "session:normal",
      target: { directory: workspaceRoot },
      draft: {
        mode: "prompt",
        text: "Recover first-session submit",
        parts: [{ type: "text", text: "Recover first-session submit" }],
      },
      options: {},
    };
    const initialAttemptStore = createConversationSubmitAttemptStore({ dbPath: attemptDbPath });
    initialAttemptStore.claim({
      workspaceId: "ws_1",
      clientMessageId,
      requestHash: createConversationSubmitRequestHash(parseConversationSubmitRequest(body)),
    });
    initialAttemptStore.update({
      workspaceId: "ws_1",
      clientMessageId,
      status: "materializing",
      opencodeSessionId: requestedOpenCodeSessionId,
    });
    await createConversationServiceForRecovery().createConversation({
      workspace: workspace(workspaceRoot),
      directory: workspaceRoot,
      title: "Recovered first session",
      requestedOpenCodeSessionId,
    });

    let submitRunCalls = 0;
    const recoveredService = createConversationSubmitService({
      attemptStore: createConversationSubmitAttemptStore({ dbPath: attemptDbPath }),
      conversationService: createConversationServiceForRecovery(),
      documentRuntimeStatus: () => createDocumentRuntimeStatusPayload({ status: "ready" }),
    });
    const response = await recoveredService.submit({
      workspace: workspace(workspaceRoot),
      body,
      resolveDirectory: async () => workspaceRoot,
      submitResolvedRun: async (input) => {
        submitRunCalls += 1;
        expect(input.request.target?.opencodeSessionId).toBe(requestedOpenCodeSessionId);
        return {
          httpStatus: 200,
          payload: {
            status: "submitted",
            workspaceId: "ws_1",
            conversationId: input.request.target?.conversationId ?? "",
            opencodeSessionId: input.request.target?.opencodeSessionId ?? "",
            runId: "run-recovered",
            clientMessageId,
            draftDisposition: "clear",
          },
        };
      },
    });

    expect(response.payload.status).toBe("submitted");
    expect(upstreamCreateIds).toEqual([requestedOpenCodeSessionId, requestedOpenCodeSessionId]);
    expect([...upstreamSessions]).toHaveLength(1);
    expect(submitRunCalls).toBe(1);
  });

  test("resolves compact submit as a summarize run for existing targets", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-submit-service-compact-resolution-"));
    tempDirs.push(workspaceRoot);
    let createConversationCalls = 0;
    const service = createConversationSubmitService({
      attemptStore: createConversationSubmitAttemptStore({
        dbPath: await createTempDbPath("veslo-submit-service-compact-resolution-db-"),
      }),
      conversationService: createConversationServiceStub(() => {
        createConversationCalls += 1;
      }),
      documentRuntimeStatus: () => createDocumentRuntimeStatusPayload({ status: "ready" }),
    });

    const result = await service.submit({
      workspace: workspace(workspaceRoot),
      body: {
        clientMessageId: "msg-compact-resolution",
        origin: "session:normal",
        target: { conversationId: "conv-compact", directory: workspaceRoot },
        draft: {
          mode: "prompt",
          text: "/compact",
          parts: [{ type: "text", text: "/compact" }],
        },
        options: { dryRun: true },
      },
      resolveDirectory: async () => workspaceRoot,
    });

    expect(result.httpStatus).toBe(200);
    expect(result.payload).toMatchObject({
      status: "dry_run",
      resolvedRunInput: {
        kind: "summarize",
      },
    });
    expect(createConversationCalls).toBe(0);
  });

  test("blocks document-runtime skill commands before session materialization", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-submit-service-doc-runtime-"));
    tempDirs.push(workspaceRoot);
    let createConversationCalls = 0;
    let resolveDirectoryCalls = 0;
    const service = createConversationSubmitService({
      attemptStore: createConversationSubmitAttemptStore({
        dbPath: await createTempDbPath("veslo-submit-service-doc-runtime-db-"),
      }),
      conversationService: createConversationServiceStub(() => {
        createConversationCalls += 1;
      }),
      documentRuntimeStatus: () => createDocumentRuntimeStatusPayload({
        status: "missing",
        now: () => new Date("2026-07-06T12:00:00.000Z"),
      }),
    });

    const result = await service.submit({
      workspace: workspace(workspaceRoot),
      body: {
        clientMessageId: "msg-doc-runtime-block",
        origin: "session:normal",
        target: { directory: workspaceRoot },
        draft: {
          mode: "prompt",
          text: "/veslo-docx Create a document",
          parts: [{ type: "text", text: "/veslo-docx Create a document" }],
          command: { name: "veslo-docx", arguments: "Create a document" },
        },
        options: { dryRun: true },
      },
      resolveDirectory: async () => {
        resolveDirectoryCalls += 1;
        return workspaceRoot;
      },
    });

    expect(result.httpStatus).toBe(200);
    expect(result.payload).toMatchObject({
      status: "blocked",
      code: "document_runtime_blocked",
      draftDisposition: "restore",
      recoverable: true,
    });
    expect(result.payload.status === "blocked" ? result.payload.message : "").toContain(
      "Document runtime package is missing",
    );
    expect(createConversationCalls).toBe(0);
    expect(resolveDirectoryCalls).toBe(0);
  });

  test("falls back to prompt when implicit document-runtime skill is unavailable", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-submit-service-implicit-doc-runtime-"));
    tempDirs.push(workspaceRoot);
    let createConversationCalls = 0;
    let resolveDirectoryCalls = 0;
    let skillResolveCalls = 0;
    const service = createConversationSubmitService({
      attemptStore: createConversationSubmitAttemptStore({
        dbPath: await createTempDbPath("veslo-submit-service-implicit-doc-runtime-db-"),
      }),
      conversationService: createConversationServiceStub(() => {
        createConversationCalls += 1;
      }),
      documentRuntimeStatus: () => createDocumentRuntimeStatusPayload({
        status: "missing",
        now: () => new Date("2026-07-06T12:00:00.000Z"),
      }),
      resolveSkillCommand: async ({ text, workspace, includeGlobal }) => {
        skillResolveCalls += 1;
        expect(text).toBe("pouzij MS Word skill a priprav upravu brief.docx");
        expect(workspace?.workspaceType).toBe("local");
        expect(includeGlobal).toBe(true);
        return "veslo-docx";
      },
    });

    const result = await service.submit({
      workspace: workspace(workspaceRoot),
      body: {
        clientMessageId: "msg-implicit-doc-runtime-block",
        origin: "session:normal",
        target: { directory: workspaceRoot },
        draft: {
          mode: "prompt",
          text: "pouzij MS Word skill a priprav upravu brief.docx",
          parts: [{ type: "text", text: "pouzij MS Word skill a priprav upravu brief.docx" }],
        },
        options: { dryRun: true },
      },
      resolveDirectory: async () => {
        resolveDirectoryCalls += 1;
        return workspaceRoot;
      },
    });

    expect(result.httpStatus).toBe(200);
    expect(result.payload).toMatchObject({
      status: "dry_run",
      draftDisposition: "keep",
      resolvedRunInput: {
        kind: "prompt_async",
        text: "pouzij MS Word skill a priprav upravu brief.docx",
      },
    });
    expect(skillResolveCalls).toBe(1);
    expect(createConversationCalls).toBe(0);
    expect(resolveDirectoryCalls).toBe(1);
  });

  test("returns debug trace when implicit skill resolution fails before dry-run submit", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-submit-service-skill-fallback-"));
    tempDirs.push(workspaceRoot);
    const service = createConversationSubmitService({
      attemptStore: createConversationSubmitAttemptStore({
        dbPath: await createTempDbPath("veslo-submit-service-skill-fallback-db-"),
      }),
      conversationService: createConversationServiceStub(() => undefined),
      documentRuntimeStatus: () => createDocumentRuntimeStatusPayload({ status: "ready" }),
      resolveSkillCommand: async () => {
        throw new Error("skill registry unavailable");
      },
    });

    const result = await service.submit({
      workspace: workspace(workspaceRoot),
      body: {
        clientMessageId: "msg-skill-fallback-trace",
        origin: "session:normal",
        target: { directory: workspaceRoot },
        draft: {
          mode: "prompt",
          text: "plain prompt",
          parts: [{ type: "text", text: "plain prompt" }],
        },
        options: { dryRun: true },
      },
      resolveDirectory: async () => workspaceRoot,
    });

    expect(result.httpStatus).toBe(200);
    expect(result.payload).toMatchObject({
      status: "dry_run",
      debugTrace: [
        {
          event: "implicit_skill_resolution_failed",
          message: "skill registry unavailable",
        },
      ],
    });
  });

  test("returns debug trace when implicit skill resolution fails before real submit", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-submit-service-real-skill-fallback-"));
    tempDirs.push(workspaceRoot);
    const service = createConversationSubmitService({
      attemptStore: createConversationSubmitAttemptStore({
        dbPath: await createTempDbPath("veslo-submit-service-real-skill-fallback-db-"),
      }),
      conversationService: createConversationServiceStub(() => undefined),
      documentRuntimeStatus: () => createDocumentRuntimeStatusPayload({ status: "ready" }),
      resolveSkillCommand: async () => {
        throw new Error("skill registry unavailable");
      },
    });

    const result = await service.submit({
      workspace: workspace(workspaceRoot),
      body: {
        clientMessageId: "msg-real-skill-fallback-trace",
        origin: "session:normal",
        target: { conversationId: "conv-existing", directory: workspaceRoot },
        draft: {
          mode: "prompt",
          text: "plain prompt",
          parts: [{ type: "text", text: "plain prompt" }],
        },
      },
      resolveDirectory: async () => workspaceRoot,
      submitResolvedRun: async (input) => ({
        httpStatus: 200,
        payload: {
          status: "submitted",
          workspaceId: input.workspace.id,
          conversationId: input.request.target?.conversationId ?? "conv-existing",
          opencodeSessionId: "sess-existing",
          runId: "run-existing",
          clientMessageId: input.request.clientMessageId,
          draftDisposition: "clear",
          debugTrace: [{ source: "runner", event: "server:conversation-run:submitted" }],
        },
      }),
    });

    expect(result.httpStatus).toBe(200);
    expect(result.payload).toMatchObject({
      status: "submitted",
      debugTrace: [
        {
          event: "implicit_skill_resolution_failed",
          message: "skill registry unavailable",
        },
        { event: "server:conversation-run:submitted" },
      ],
    });
  });

  test("submits resolved existing targets through the injected run submitter idempotently", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-submit-service-existing-run-"));
    tempDirs.push(workspaceRoot);
    let createConversationCalls = 0;
    let resolveDirectoryCalls = 0;
    let submitRunCalls = 0;
    const service = createConversationSubmitService({
      attemptStore: createConversationSubmitAttemptStore({
        dbPath: await createTempDbPath("veslo-submit-service-existing-run-db-"),
      }),
      conversationService: createConversationServiceStub(() => {
        createConversationCalls += 1;
      }),
      documentRuntimeStatus: () => createDocumentRuntimeStatusPayload({ status: "ready" }),
    });
    const body = {
      clientMessageId: "msg-existing-submit",
      origin: "session:normal",
      target: { conversationId: "conv-existing", directory: workspaceRoot },
      draft: {
        mode: "prompt",
        text: "Submit existing",
        parts: [{ type: "text", text: "Submit existing" }],
      },
    };
    const submit = () => service.submit({
      workspace: workspace(workspaceRoot),
      body,
      runtimeAuthorizationActorTokenHash: "actor-hash",
      resolveDirectory: async () => {
        resolveDirectoryCalls += 1;
        return workspaceRoot;
      },
      submitResolvedRun: async (input) => {
        submitRunCalls += 1;
        expect(input.directory).toBe(workspaceRoot);
        expect(input.runtimeAuthorizationActorTokenHash).toBe("actor-hash");
        expect(input.request.target?.conversationId).toBe("conv-existing");
        expect(input.resolvedRunInput).toMatchObject({
          kind: "prompt_async",
          text: "Submit existing",
          parts: [{ type: "text", text: "Submit existing" }],
        });
        return {
          httpStatus: 200,
          payload: {
            status: "submitted",
            workspaceId: "ws_1",
            conversationId: "conv-existing",
            opencodeSessionId: "sess-existing",
            runId: "run-existing",
            clientMessageId: input.request.clientMessageId,
            draftDisposition: "clear",
          },
        };
      },
    });

    const first = await submit();
    expect(first.httpStatus).toBe(200);
    expect(first.payload).toMatchObject({
      status: "submitted",
      conversationId: "conv-existing",
      opencodeSessionId: "sess-existing",
      runId: "run-existing",
      clientMessageId: "msg-existing-submit",
      draftDisposition: "clear",
    });
    const retry = await submit();
    expect(retry.payload).toEqual(first.payload);
    expect(submitRunCalls).toBe(1);
    expect(resolveDirectoryCalls).toBe(1);
    expect(createConversationCalls).toBe(0);
  });

  test("keeps canonical identity absent for a legacy submitted replay", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-submit-service-legacy-canonical-replay-"));
    tempDirs.push(workspaceRoot);
    const attemptStore = createConversationSubmitAttemptStore({
      dbPath: await createTempDbPath("veslo-submit-service-legacy-canonical-replay-db-"),
    });
    const body = {
      clientMessageId: "msg-legacy-canonical-replay",
      origin: "session:normal",
      target: { conversationId: "conv-existing", directory: workspaceRoot },
      draft: {
        mode: "prompt",
        text: "Replay legacy submit",
        parts: [{ type: "text", text: "Replay legacy submit" }],
      },
    };
    const request = parseConversationSubmitRequest(body);
    attemptStore.claim({
      workspaceId: "ws_1",
      clientMessageId: request.clientMessageId,
      requestHash: createConversationSubmitRequestHash(request),
    });
    attemptStore.update({
      workspaceId: "ws_1",
      clientMessageId: request.clientMessageId,
      status: "completed",
      conversationId: "conv-existing",
      opencodeSessionId: "sess-existing",
      runId: "run-existing",
      resultJson: JSON.stringify({
        status: "submitted",
        workspaceId: "ws_1",
        conversationId: "conv-existing",
        opencodeSessionId: "sess-existing",
        runId: "run-existing",
        clientMessageId: request.clientMessageId,
        draftDisposition: "clear",
      }),
    });
    const service = createConversationSubmitService({
      attemptStore,
      conversationService: createConversationServiceStub(() => {
        throw new Error("legacy replay must not materialize a conversation");
      }),
      documentRuntimeStatus: () => createDocumentRuntimeStatusPayload({ status: "ready" }),
    });

    const result = await service.submit({
      workspace: workspace(workspaceRoot),
      body,
      resolveDirectory: async () => {
        throw new Error("legacy replay must not resolve the target directory");
      },
      submitResolvedRun: async () => {
        throw new Error("legacy replay must not submit upstream");
      },
    });
    expect(result.payload).toMatchObject({
      status: "submitted",
      runId: "run-existing",
    });
    expect("canonicalMessageId" in result.payload).toBe(false);
    expect("canonicalMessageId" in JSON.parse(
      attemptStore.get("ws_1", request.clientMessageId)?.resultJson ?? "{}",
    )).toBe(false);
  });

  test("joins concurrent identical existing-target submits before upstream result is persisted", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-submit-service-existing-run-concurrent-"));
    tempDirs.push(workspaceRoot);
    let createConversationCalls = 0;
    let resolveDirectoryCalls = 0;
    let submitRunCalls = 0;
    let releaseSubmit: () => void = () => {
      throw new Error("submit was released before the upstream call started");
    };
    const submitRelease = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    let markFirstSubmitStarted: () => void = () => undefined;
    const firstSubmitStarted = new Promise<void>((resolve) => {
      markFirstSubmitStarted = resolve;
    });
    const service = createConversationSubmitService({
      attemptStore: createConversationSubmitAttemptStore({
        dbPath: await createTempDbPath("veslo-submit-service-existing-run-concurrent-db-"),
      }),
      conversationService: createConversationServiceStub(() => {
        createConversationCalls += 1;
      }),
      documentRuntimeStatus: () => createDocumentRuntimeStatusPayload({ status: "ready" }),
    });
    const body = {
      clientMessageId: "msg-existing-submit-concurrent",
      origin: "session:normal",
      target: { conversationId: "conv-existing", directory: workspaceRoot },
      draft: {
        mode: "prompt",
        text: "Submit existing concurrently",
        parts: [{ type: "text", text: "Submit existing concurrently" }],
      },
    };
    const submit = () => service.submit({
      workspace: workspace(workspaceRoot),
      body,
      resolveDirectory: async () => {
        resolveDirectoryCalls += 1;
        return workspaceRoot;
      },
      submitResolvedRun: async (input) => {
        submitRunCalls += 1;
        const callNumber = submitRunCalls;
        if (callNumber === 1) markFirstSubmitStarted();
        await submitRelease;
        return {
          httpStatus: 200,
          payload: {
            status: "submitted",
            workspaceId: "ws_1",
            conversationId: "conv-existing",
            opencodeSessionId: "sess-existing",
            runId: `run-existing-${callNumber}`,
            clientMessageId: input.request.clientMessageId,
            draftDisposition: "clear",
          },
        };
      },
    });

    const firstPromise = submit();
    await firstSubmitStarted;
    const secondPromise = submit();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseSubmit();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.httpStatus).toBe(200);
    expect(second.httpStatus).toBe(200);
    expect(first.payload).toMatchObject({
      status: "submitted",
      conversationId: "conv-existing",
      opencodeSessionId: "sess-existing",
      runId: "run-existing-1",
      clientMessageId: "msg-existing-submit-concurrent",
      draftDisposition: "clear",
    });
    expect(second.payload).toEqual(first.payload);
    expect(submitRunCalls).toBe(1);
    expect(resolveDirectoryCalls).toBe(1);
    expect(createConversationCalls).toBe(0);
  });

  test("retries an existing-target submit after a failed replayable attempt", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-submit-service-existing-run-retry-failed-"));
    tempDirs.push(workspaceRoot);
    let createConversationCalls = 0;
    let submitRunCalls = 0;
    const service = createConversationSubmitService({
      attemptStore: createConversationSubmitAttemptStore({
        dbPath: await createTempDbPath("veslo-submit-service-existing-run-retry-failed-db-"),
      }),
      conversationService: createConversationServiceStub(() => {
        createConversationCalls += 1;
      }),
      documentRuntimeStatus: () => createDocumentRuntimeStatusPayload({ status: "ready" }),
    });
    const body = {
      clientMessageId: "msg-existing-submit-retry-failed",
      origin: "session:normal",
      target: { conversationId: "conv-existing", directory: workspaceRoot },
      draft: {
        mode: "prompt",
        text: "Submit existing after failure",
        parts: [{ type: "text", text: "Submit existing after failure" }],
      },
    };
    const submit = () => service.submit({
      workspace: workspace(workspaceRoot),
      body,
      resolveDirectory: async () => workspaceRoot,
      submitResolvedRun: async (input) => {
        submitRunCalls += 1;
        if (submitRunCalls === 1) {
          throw new ApiError(502, "opencode_proxy_failed", "OpenCode prompt failed");
        }
        return {
          httpStatus: 200,
          payload: {
            status: "submitted",
            workspaceId: "ws_1",
            conversationId: "conv-existing",
            opencodeSessionId: "sess-existing",
            runId: "run-existing-retry",
            clientMessageId: input.request.clientMessageId,
            draftDisposition: "clear",
          },
        };
      },
    });

    const first = await submit();
    expect(first.httpStatus).toBe(200);
    expect(first.payload).toMatchObject({
      status: "failed",
      code: "opencode_proxy_failed",
      draftDisposition: "restore",
    });

    const retry = await submit();
    expect(retry.httpStatus).toBe(200);
    expect(retry.payload).toMatchObject({
      status: "submitted",
      conversationId: "conv-existing",
      opencodeSessionId: "sess-existing",
      runId: "run-existing-retry",
      clientMessageId: "msg-existing-submit-retry-failed",
      draftDisposition: "clear",
    });
    expect(submitRunCalls).toBe(2);
    expect(createConversationCalls).toBe(0);
  });

  test("blocks prompt image attachments when model metadata says image input is unsupported", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-submit-service-attachment-nonvision-"));
    tempDirs.push(workspaceRoot);
    let createConversationCalls = 0;
    let resolveDirectoryCalls = 0;
    const service = createConversationSubmitService({
      attemptStore: createConversationSubmitAttemptStore({
        dbPath: await createTempDbPath("veslo-submit-service-attachment-nonvision-db-"),
      }),
      conversationService: createConversationServiceStub(() => {
        createConversationCalls += 1;
      }),
      documentRuntimeStatus: () => createDocumentRuntimeStatusPayload({ status: "ready" }),
    });

    const result = await service.submit({
      workspace: workspace(workspaceRoot),
      body: {
        clientMessageId: "msg-attachment-nonvision",
        origin: "session:normal",
        target: { conversationId: "conv-existing", directory: workspaceRoot },
        draft: {
          mode: "prompt",
          text: "inspect this screenshot",
          parts: [{ type: "text", text: "inspect this screenshot" }],
          attachments: [{
            name: "shot.png",
            kind: "image",
            mimeType: "image/png",
            dataUrl: "data:image/png;base64,aGVsbG8=",
            fileSessionPath: "sessions/sess-existing/shot.png",
          }],
        },
        options: {
          dryRun: true,
          model: {
            providerID: "openai",
            modelID: "text-only",
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
      resolveDirectory: async () => {
        resolveDirectoryCalls += 1;
        return workspaceRoot;
      },
    });

    expect(result.httpStatus).toBe(200);
    expect(result.payload).toMatchObject({
      status: "blocked",
      code: "attachment_rejected",
      draftDisposition: "restore",
      recoverable: true,
    });
    expect(createConversationCalls).toBe(0);
    expect(resolveDirectoryCalls).toBe(0);
  });

  test("blocks prompt image attachments when model capabilities are unavailable", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-submit-service-attachment-unknown-model-"));
    tempDirs.push(workspaceRoot);
    let resolveDirectoryCalls = 0;
    const service = createConversationSubmitService({
      attemptStore: createConversationSubmitAttemptStore({
        dbPath: await createTempDbPath("veslo-submit-service-attachment-unknown-model-db-"),
      }),
      conversationService: createConversationServiceStub(() => undefined),
      documentRuntimeStatus: () => createDocumentRuntimeStatusPayload({ status: "ready" }),
    });

    const result = await service.submit({
      workspace: workspace(workspaceRoot),
      body: {
        clientMessageId: "msg-attachment-unknown-model",
        origin: "session:normal",
        target: { conversationId: "conv-existing", directory: workspaceRoot },
        draft: {
          mode: "prompt",
          text: "inspect this screenshot",
          parts: [{ type: "text", text: "inspect this screenshot" }],
          attachments: [{
            name: "shot.png",
            kind: "image",
            mimeType: "image/png",
            dataUrl: "data:image/png;base64,aGVsbG8=",
          }],
        },
        options: {
          dryRun: true,
          model: { providerID: "openai", modelID: "unknown" },
        },
      },
      resolveDirectory: async () => {
        resolveDirectoryCalls += 1;
        return workspaceRoot;
      },
    });

    expect(result.httpStatus).toBe(200);
    expect(result.payload).toMatchObject({
      status: "blocked",
      code: "model_capabilities_unavailable",
      draftDisposition: "restore",
      recoverable: true,
    });
    expect(resolveDirectoryCalls).toBe(0);
  });

  test("constructs prompt parts and path injection for staged file attachments", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-submit-service-attachment-parts-"));
    tempDirs.push(workspaceRoot);
    let createConversationCalls = 0;
    const service = createConversationSubmitService({
      attemptStore: createConversationSubmitAttemptStore({
        dbPath: await createTempDbPath("veslo-submit-service-attachment-parts-db-"),
      }),
      conversationService: createConversationServiceStub(() => {
        createConversationCalls += 1;
      }),
      documentRuntimeStatus: () => createDocumentRuntimeStatusPayload({ status: "ready" }),
    });

    const result = await service.submit({
      workspace: workspace(workspaceRoot),
      body: {
        clientMessageId: "msg-attachment-parts",
        origin: "session:normal",
        target: { conversationId: "conv-existing", directory: workspaceRoot },
        draft: {
          mode: "prompt",
          text: "review the brief",
          parts: [{ type: "text", text: "review the brief" }],
          attachments: [{
            name: "brief.txt",
            kind: "file",
            mimeType: "text/plain",
            dataUrl: "data:text/plain;base64,YnJpZWY=",
            fileSessionPath: "sessions/sess-existing/brief.txt",
          }],
        },
        options: {
          dryRun: true,
          model: { providerID: "openai", modelID: "gpt-4.1" },
        },
      },
      resolveDirectory: async () => workspaceRoot,
    });

    expect(result.httpStatus).toBe(200);
    expect(result.payload).toMatchObject({
      status: "dry_run",
      resolvedRunInput: {
        kind: "prompt_async",
        text: "review the brief\nsessions/sess-existing/brief.txt",
        parts: [
          { type: "text", text: "review the brief\nsessions/sess-existing/brief.txt" },
          {
            type: "file",
            url: "data:text/plain;base64,YnJpZWY=",
            filename: "brief.txt",
            mime: "text/plain",
          },
        ],
      },
    });
    expect(createConversationCalls).toBe(0);
  });

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
        draft: {
          mode: "prompt",
          text: "Create then fail",
          parts: [{ type: "text", text: "Create then fail" }],
        },
        options: {},
      },
      resolveDirectory: async () => workspaceRoot,
      submitResolvedRun: async () => {
        throw new ApiError(502, "opencode_proxy_failed", "OpenCode prompt failed");
      },
    });

    expect(result.httpStatus).toBe(200);
    expect(result.payload.status).toBe("failed");
    expect(result.payload.status === "failed" ? result.payload.code : null).toBe("opencode_proxy_failed");
    expect(result.payload.draftDisposition).toBe("restore");
    expect("materializedSession" in result.payload ? result.payload.materializedSession : null).toMatchObject({
      id: "sess_1",
      conversationId: "conv_1",
      opencodeSessionId: "sess_1",
    });
    expect("workspaceId" in result.payload ? result.payload.workspaceId : null).toBe("ws_1");
    expect("conversationId" in result.payload ? result.payload.conversationId : null).toBe("conv_1");
    expect("opencodeSessionId" in result.payload ? result.payload.opencodeSessionId : null).toBe("sess_1");
    expect("clientMessageId" in result.payload ? result.payload.clientMessageId : null).toBe(
      "msg-materialized-run-failed",
    );
    expect("pendingClientSessionId" in result.payload ? result.payload.pendingClientSessionId : null).toBe(
      "pending-materialized",
    );
    expect(createConversationCalls).toBe(1);
  });

  test("retries a first-session failed submit using the already materialized conversation", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-submit-service-materialized-failed-retry-"));
    tempDirs.push(workspaceRoot);
    let createConversationCalls = 0;
    let submitRunCalls = 0;
    const service = createConversationSubmitService({
      attemptStore: createConversationSubmitAttemptStore({
        dbPath: await createTempDbPath("veslo-submit-service-materialized-failed-retry-db-"),
      }),
      conversationService: createConversationServiceStub(() => {
        createConversationCalls += 1;
      }),
      documentRuntimeStatus: () => createDocumentRuntimeStatusPayload({ status: "ready" }),
    });
    const body = {
      clientMessageId: "msg-materialized-run-failed-retry",
      origin: "session:normal",
      target: { directory: workspaceRoot, pendingClientSessionId: "pending-materialized-retry" },
      draft: {
        mode: "prompt",
        text: "Create then retry",
        parts: [{ type: "text", text: "Create then retry" }],
      },
      options: {},
    };
    const submit = () => service.submit({
      workspace: workspace(workspaceRoot),
      body,
      resolveDirectory: async () => workspaceRoot,
      submitResolvedRun: async (input) => {
        submitRunCalls += 1;
        expect(input.request.target?.conversationId).toBe("conv_1");
        expect(input.request.target?.opencodeSessionId).toBe("sess_1");
        if (submitRunCalls === 1) {
          throw new ApiError(502, "opencode_proxy_failed", "OpenCode prompt failed");
        }
        return {
          httpStatus: 200,
          payload: {
            status: "submitted",
            workspaceId: "ws_1",
            conversationId: "conv_1",
            opencodeSessionId: "sess_1",
            runId: "run-materialized-retry",
            clientMessageId: input.request.clientMessageId,
            draftDisposition: "clear",
          },
        };
      },
    });

    const first = await submit();
    expect(first.payload).toMatchObject({
      status: "failed",
      code: "opencode_proxy_failed",
      conversationId: "conv_1",
      opencodeSessionId: "sess_1",
    });

    const retry = await submit();
    expect(retry.payload).toMatchObject({
      status: "submitted",
      conversationId: "conv_1",
      opencodeSessionId: "sess_1",
      runId: "run-materialized-retry",
      clientMessageId: "msg-materialized-run-failed-retry",
      draftDisposition: "clear",
    });
    expect(createConversationCalls).toBe(1);
    expect(submitRunCalls).toBe(2);
  });

  test("first-session blocked submit after materialization returns materialized session metadata", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-submit-service-materialized-blocked-"));
    tempDirs.push(workspaceRoot);
    let createConversationCalls = 0;
    const service = createConversationSubmitService({
      attemptStore: createConversationSubmitAttemptStore({
        dbPath: await createTempDbPath("veslo-submit-service-materialized-blocked-db-"),
      }),
      conversationService: createConversationServiceStub(() => {
        createConversationCalls += 1;
      }),
      documentRuntimeStatus: () => createDocumentRuntimeStatusPayload({ status: "ready" }),
    });

    const result = await service.submit({
      workspace: workspace(workspaceRoot),
      body: {
        clientMessageId: "msg-materialized-run-blocked",
        origin: "session:normal",
        target: { directory: workspaceRoot, pendingClientSessionId: "pending-materialized-blocked" },
        draft: {
          mode: "prompt",
          text: "Create then block",
          parts: [{ type: "text", text: "Create then block" }],
        },
        options: {},
      },
      resolveDirectory: async () => workspaceRoot,
      submitResolvedRun: async () => ({
        httpStatus: 200,
        payload: {
          status: "blocked",
          code: "runtime_busy",
          message: "Runtime is busy",
          draftDisposition: "restore",
          recoverable: true,
        },
      }),
    });

    expect(result.httpStatus).toBe(200);
    expect(result.payload.status).toBe("blocked");
    expect(result.payload.status === "blocked" ? result.payload.code : null).toBe("runtime_busy");
    expect(result.payload.draftDisposition).toBe("restore");
    expect("materializedSession" in result.payload ? result.payload.materializedSession : null).toMatchObject({
      id: "sess_1",
      conversationId: "conv_1",
      opencodeSessionId: "sess_1",
    });
    expect("workspaceId" in result.payload ? result.payload.workspaceId : null).toBe("ws_1");
    expect("conversationId" in result.payload ? result.payload.conversationId : null).toBe("conv_1");
    expect("opencodeSessionId" in result.payload ? result.payload.opencodeSessionId : null).toBe("sess_1");
    expect("clientMessageId" in result.payload ? result.payload.clientMessageId : null).toBe(
      "msg-materialized-run-blocked",
    );
    expect("pendingClientSessionId" in result.payload ? result.payload.pendingClientSessionId : null).toBe(
      "pending-materialized-blocked",
    );
    expect(createConversationCalls).toBe(1);
  });

  test("blocks remote workspace submit before local resolution or materialization", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-submit-service-remote-"));
    tempDirs.push(workspaceRoot);
    let createConversationCalls = 0;
    let resolveDirectoryCalls = 0;
    let skillResolveCalls = 0;
    const service = createConversationSubmitService({
      attemptStore: createConversationSubmitAttemptStore({
        dbPath: await createTempDbPath("veslo-submit-service-remote-db-"),
      }),
      conversationService: createConversationServiceStub(() => {
        createConversationCalls += 1;
      }),
      documentRuntimeStatus: () => createDocumentRuntimeStatusPayload({ status: "ready" }),
      resolveSkillCommand: async () => {
        skillResolveCalls += 1;
        return "veslo-docx";
      },
    });

    const result = await service.submit({
      workspace: remoteWorkspace(workspaceRoot),
      body: {
        clientMessageId: "msg-remote-submit",
        origin: "session:normal",
        target: { directory: workspaceRoot },
        draft: {
          mode: "prompt",
          text: "remote submit",
          parts: [{ type: "text", text: "remote submit" }],
        },
      },
      resolveDirectory: async () => {
        resolveDirectoryCalls += 1;
        return workspaceRoot;
      },
    });

    expect(result.httpStatus).toBe(200);
    expect(result.payload).toMatchObject({
      status: "blocked",
      code: "remote_submit_unavailable",
      draftDisposition: "restore",
      recoverable: true,
    });
    expect(createConversationCalls).toBe(0);
    expect(resolveDirectoryCalls).toBe(0);
    expect(skillResolveCalls).toBe(0);
  });
});
