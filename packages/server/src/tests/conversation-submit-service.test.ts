import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { createConversationSubmitAttemptStore } from "../conversation-submit-attempt-store.js";
import {
  createConversationSubmitService,
} from "../conversation-submit-service.js";
import type { ConversationService } from "../conversation-service.js";
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
});
