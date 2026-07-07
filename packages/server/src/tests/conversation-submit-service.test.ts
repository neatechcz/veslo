import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { createConversationSubmitAttemptStore } from "../conversation-submit-attempt-store.js";
import {
  createConversationSubmitService,
} from "../conversation-submit-service.js";
import type { ConversationService } from "../conversation-service.js";
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
  onCreate: () => void,
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
  createConversation: async () => {
    onCreate();
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

  test("blocks implicit document-runtime skill matches before session materialization", async () => {
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
      status: "blocked",
      code: "document_runtime_blocked",
      draftDisposition: "restore",
      recoverable: true,
    });
    expect(skillResolveCalls).toBe(1);
    expect(createConversationCalls).toBe(0);
    expect(resolveDirectoryCalls).toBe(0);
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
    expect(result.payload.code).toBe("opencode_proxy_failed");
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
    expect(result.payload.code).toBe("runtime_busy");
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
