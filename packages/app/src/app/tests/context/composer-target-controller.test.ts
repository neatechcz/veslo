import assert from "node:assert/strict";
import test from "node:test";
import { createRoot, createSignal } from "solid-js";

import { createComposerTargetController } from "../../context/composer-target-controller.js";
import { resolveComposerStorageKey, resolvePendingDraftKey } from "../../lib/pending-session-drafts.js";
import type { PendingSessionDraft, PendingSessionDraftPutInput, PendingSessionDraftSummary } from "../../lib/tauri.js";
import type { ComposerDraft } from "../../types.js";

const draft = (text: string): ComposerDraft => ({
  mode: "prompt",
  parts: text ? [{ type: "text", text }] : [],
  attachments: [],
  text,
  resolvedText: text,
});

const summaryFromPut = (input: PendingSessionDraftPutInput): PendingSessionDraftSummary => ({
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

test("composer target controller builds workspace options and moves current draft into the selected target", async () => {
  await createRoot(async (dispose) => {
    try {
      const [activePendingDraftKey, setActivePendingDraftKey] = createSignal<string | null>(null);
      const [activePendingDraftMeta, setActivePendingDraftMeta] = createSignal<PendingSessionDraftSummary | null>(null);
      const chatKey = resolvePendingDraftKey({ kind: "new-private" });
      const globalComposerStorageKey = resolveComposerStorageKey({ pendingDraftKey: chatKey });
      const targetKey = resolvePendingDraftKey({
        kind: "directory",
        workspaceId: "workspace-1",
        directory: "C:/work/project",
      });
      let composerDrafts: Record<string, ComposerDraft> = {};
      const persisted: { current: PendingSessionDraftSummary | null } = { current: null };
      const activatedWorkspaces: string[] = [];
      const views: string[] = [];

      const controller = createComposerTargetController({
        isTauriRuntime: () => true,
        labels: {
          chat: () => "Chat only",
          chooseWorkspace: () => "Choose workspace",
          chooseWorkspaceDescription: () => "Choose another workspace",
          targetUnavailable: () => "Target unavailable",
        },
        activePendingDraftKey,
        setActivePendingDraftKey,
        activePendingDraftMeta,
        setActivePendingDraftMeta,
        currentComposerStorageKey: () => globalComposerStorageKey,
        composerDraft: () => draft("ship this"),
        createEmptyComposerDraft: () => draft(""),
        pendingSessionDraftsList: async () => (persisted.current ? [persisted.current] : []),
        pendingSessionDraftsGet: async () => null,
        pendingSessionDraftsPut: async (input) => {
          persisted.current = summaryFromPut(input);
          return persisted.current;
        },
        pendingSessionDraftsDelete: async () => true,
        formatPendingDraftAttachmentRestoreError: () => null,
        isConsumedPendingDraftId: () => false,
        markPendingDraftConsumed: () => undefined,
        clearConsumedPendingDraftId: () => undefined,
        workspace: {
          workspaces: () => [
            {
              id: "workspace-1",
              directory: "C:/work/project",
              path: "C:/work/project",
              name: "Project",
            },
          ],
          activeWorkspaceId: () => "workspace-1",
          activeWorkspaceDisplay: () => ({
            id: "workspace-1",
            directory: "C:/work/project",
            path: "C:/work/project",
            name: "Project",
          } as any),
          activeWorkspaceRoot: () => "C:/work/project",
          isPrivateWorkspacePath: () => false,
          createScratchWorkspace: async () => ({ id: "scratch-1" }),
          forgetWorkspace: async () => true,
          activateWorkspace: async (workspaceId) => {
            activatedWorkspaces.push(workspaceId);
            return true;
          },
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

      await controller.refreshPendingDraftSummaries();
      assert.equal(controller.composerTargetOptions().some((option) => option.id === targetKey), true);

      const result = await controller.switchComposerTarget(targetKey);

      assert.deepEqual(result, { status: "switched" });
      assert.ok(persisted.current);
      assert.equal(activePendingDraftKey(), targetKey);
      assert.equal(activePendingDraftMeta()?.id, persisted.current.id);
      assert.equal(composerDrafts[globalComposerStorageKey]?.text, "ship this");
      assert.equal(composerDrafts[targetKey], undefined);
      assert.deepEqual(activatedWorkspaces, []);
      assert.deepEqual(views, ["session"]);
    } finally {
      dispose();
    }
  });
});

test("composer target switch refreshes stale pending draft summaries before conflict resolution", async () => {
  await createRoot(async (dispose) => {
    try {
      const [activePendingDraftKey, setActivePendingDraftKey] = createSignal<string | null>(null);
      const [activePendingDraftMeta, setActivePendingDraftMeta] = createSignal<PendingSessionDraftSummary | null>(null);
      const chatKey = resolvePendingDraftKey({ kind: "new-private" });
      const globalComposerStorageKey = resolveComposerStorageKey({ pendingDraftKey: chatKey });
      const targetKey = resolvePendingDraftKey({
        kind: "directory",
        workspaceId: "workspace-1",
        directory: "C:/work/project",
      });
      const destinationDraft: PendingSessionDraft = {
        id: "draft-existing",
        kind: "directory",
        workspaceId: "workspace-1",
        directory: "C:/work/project",
        privateWorkspaceId: null,
        createdAt: 10,
        updatedAt: 20,
        composer: draft("destination draft"),
      };
      const destinationSummary: PendingSessionDraftSummary = {
        ...destinationDraft,
        composer: {
          mode: destinationDraft.composer.mode,
          parts: destinationDraft.composer.parts,
          attachments: [],
          text: destinationDraft.composer.text,
          resolvedText: destinationDraft.composer.resolvedText,
        },
      };
      let persistedSummaries: PendingSessionDraftSummary[] = [];
      let composerDrafts: Record<string, ComposerDraft> = {};

      const controller = createComposerTargetController({
        isTauriRuntime: () => true,
        labels: {
          chat: () => "Chat only",
          chooseWorkspace: () => "Choose workspace",
          chooseWorkspaceDescription: () => "Choose another workspace",
          targetUnavailable: () => "Target unavailable",
        },
        activePendingDraftKey,
        setActivePendingDraftKey,
        activePendingDraftMeta,
        setActivePendingDraftMeta,
        pendingDraftsReady: () => true,
        currentComposerStorageKey: () => globalComposerStorageKey,
        composerDraft: () => draft("current draft"),
        createEmptyComposerDraft: () => draft(""),
        pendingSessionDraftsList: async () => persistedSummaries,
        pendingSessionDraftsGet: async (draftId) => {
          assert.equal(draftId, "draft-existing");
          return { draft: destinationDraft, attachmentFailures: [] };
        },
        pendingSessionDraftsPut: async () => {
          throw new Error("conflict path should not persist over the destination draft");
        },
        pendingSessionDraftsDelete: async () => true,
        formatPendingDraftAttachmentRestoreError: () => null,
        isConsumedPendingDraftId: () => false,
        markPendingDraftConsumed: () => undefined,
        clearConsumedPendingDraftId: () => undefined,
        workspace: {
          workspaces: () => [
            {
              id: "workspace-1",
              directory: "C:/work/project",
              path: "C:/work/project",
              name: "Project",
            },
          ],
          activeWorkspaceId: () => "workspace-1",
          activeWorkspaceDisplay: () => ({
            id: "workspace-1",
            directory: "C:/work/project",
            path: "C:/work/project",
            name: "Project",
          } as any),
          activeWorkspaceRoot: () => "C:/work/project",
          isPrivateWorkspacePath: () => false,
          createScratchWorkspace: async () => ({ id: "scratch-1" }),
          forgetWorkspace: async () => true,
          activateWorkspace: async () => true,
          pickWorkspaceFolder: async () => null,
          ensureWorkspaceForFolder: async () => null,
        },
        publishRegisteredWorkspaceToSidebar: () => undefined,
        setComposerDraftBySessionId: (updater) => {
          composerDrafts = updater(composerDrafts);
        },
        setView: () => undefined,
        setError: () => undefined,
        reportError: (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
        safeStringify: (value) => String(value),
        addOpencodeCacheHint: (message) => message,
      });

      await controller.refreshPendingDraftSummaries();
      persistedSummaries = [destinationSummary];

      const result = await controller.switchComposerTarget(targetKey);

      assert.equal(result.status, "conflict");
      assert.equal(activePendingDraftKey(), null);
      assert.equal(composerDrafts[targetKey], undefined);
    } finally {
      dispose();
    }
  });
});
