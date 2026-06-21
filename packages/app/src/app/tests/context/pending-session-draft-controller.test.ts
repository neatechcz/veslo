import assert from "node:assert/strict";
import test from "node:test";
import { createRoot } from "solid-js";

import { createPendingSessionDraftController } from "../../context/pending-session-draft-controller.js";
import { resolvePendingDraftKey } from "../../lib/pending-session-drafts.js";
import type { PendingSessionDraft, PendingSessionDraftSummary } from "../../lib/tauri.js";
import type { ComposerDraft } from "../../types.js";

const draft = (text: string): ComposerDraft => ({
  mode: "prompt",
  parts: text ? [{ type: "text", text }] : [],
  attachments: [],
  text,
  resolvedText: text,
});

const summaryFromDraft = (input: PendingSessionDraft): PendingSessionDraftSummary => ({
  id: input.id,
  kind: input.kind,
  workspaceId: input.workspaceId,
  directory: input.directory ?? null,
  privateWorkspaceId: input.privateWorkspaceId ?? null,
  createdAt: input.createdAt,
  updatedAt: input.updatedAt,
  composer: {
    mode: input.composer.mode,
    parts: input.composer.parts,
    attachments: input.composer.attachments.map(({ dataUrl: _dataUrl, ...attachment }) => attachment),
    text: input.composer.text,
    resolvedText: input.composer.resolvedText,
    command: input.composer.command,
  },
});

test("pending draft controller reopens an existing private draft without creating another scratch workspace", async () => {
  await createRoot(async (dispose) => {
    try {
      const existingDraft: PendingSessionDraft = {
        id: "draft-existing",
        kind: "new-private",
        workspaceId: "scratch-1",
        privateWorkspaceId: "scratch-1",
        directory: null,
        createdAt: 10,
        updatedAt: 20,
        composer: draft("remember this"),
      };
      const existingSummary = summaryFromDraft(existingDraft);
      const activatedWorkspaces: string[] = [];
      const views: string[] = [];
      let composerDrafts: Record<string, ComposerDraft> = {};

      const controller = createPendingSessionDraftController({
        isTauriRuntime: () => true,
        createSessionAndOpen: async () => {
          throw new Error("web fallback should not create a real session on desktop");
        },
        createEmptyComposerDraft: () => draft(""),
        pendingSessionDraftsList: async () => [existingSummary],
        pendingSessionDraftsGet: async (id) => {
          assert.equal(id, existingDraft.id);
          return { draft: existingDraft, attachmentFailures: [] };
        },
        pendingSessionDraftsPut: async () => {
          throw new Error("existing draft reopen should not persist a new draft");
        },
        pendingSessionDraftsDelete: async () => {
          throw new Error("existing draft reopen should not delete the draft");
        },
        workspace: {
          activeWorkspaceId: () => "scratch-1",
          activeWorkspaceDisplay: () => ({ id: "scratch-1", directory: "C:/scratch-1", path: "C:/scratch-1" }),
          workspaces: () => [{ id: "scratch-1", directory: "C:/scratch-1", path: "C:/scratch-1" }],
          activateWorkspace: async (workspaceId) => {
            activatedWorkspaces.push(workspaceId);
            return true;
          },
          createScratchWorkspace: async () => {
            throw new Error("existing draft reopen should not create another scratch workspace");
          },
          forgetWorkspace: async () => true,
          pickWorkspaceFolder: async () => null,
          ensureWorkspaceForFolder: async () => null,
        },
        publishRegisteredWorkspaceToSidebar: () => undefined,
        setComposerDraftBySessionId: (updater) => {
          composerDrafts = updater(composerDrafts);
        },
        setView: (view) => {
          views.push(view);
        },
        setError: () => undefined,
        reportError: (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
        safeStringify: (value) => String(value),
        addOpencodeCacheHint: (message) => message,
      });

      const opened = await controller.openNewSessionWithDirectory();

      const pendingKey = resolvePendingDraftKey({ kind: "new-private" });
      assert.equal(opened, true);
      assert.deepEqual(activatedWorkspaces, ["scratch-1"]);
      assert.equal(controller.activePendingDraftKey(), pendingKey);
      assert.equal(controller.activePendingDraftMeta()?.id, existingDraft.id);
      assert.equal(composerDrafts[pendingKey]?.text, "remember this");
      assert.deepEqual(views, ["session"]);
    } finally {
      dispose();
    }
  });
});

test("pending draft controller reports failure when scratch workspace creation fails", async () => {
  await createRoot(async (dispose) => {
    try {
      const errors: string[] = [];

      const controller = createPendingSessionDraftController({
        isTauriRuntime: () => true,
        createSessionAndOpen: async () => {
          throw new Error("web fallback should not create a real session on desktop");
        },
        createEmptyComposerDraft: () => draft(""),
        pendingSessionDraftsList: async () => [],
        pendingSessionDraftsGet: async () => null,
        pendingSessionDraftsPut: async () => {
          throw new Error("scratch creation failure should not persist a draft");
        },
        pendingSessionDraftsDelete: async () => true,
        workspace: {
          activeWorkspaceId: () => "",
          activeWorkspaceDisplay: () => ({}),
          workspaces: () => [],
          activateWorkspace: async () => {
            throw new Error("scratch creation failure should not activate a workspace");
          },
          createScratchWorkspace: async () => null,
          forgetWorkspace: async () => true,
          pickWorkspaceFolder: async () => null,
          ensureWorkspaceForFolder: async () => null,
        },
        publishRegisteredWorkspaceToSidebar: () => undefined,
        setComposerDraftBySessionId: () => undefined,
        setView: () => undefined,
        setError: (message) => {
          if (message) errors.push(message);
        },
        reportError: (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
        safeStringify: (value) => String(value),
        addOpencodeCacheHint: (message) => message,
      });

      const opened = await controller.openNewSessionWithDirectory();

      assert.equal(opened, false);
      assert.deepEqual(errors, ["Failed to create a private chat workspace."]);
    } finally {
      dispose();
    }
  });
});

