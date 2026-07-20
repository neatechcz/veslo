import assert from "node:assert/strict";
import test from "node:test";
import { createRoot, createSignal } from "solid-js";

import { createComposerTargetController } from "../../context/composer-target-controller.js";
import {
  GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID,
  resolveComposerStorageKey,
  resolvePendingDraftKey,
} from "../../lib/pending-session-drafts.js";
import type { PendingSessionDraftPutInput, PendingSessionDraftSummary } from "../../lib/tauri.js";
import type { ComposerDraft } from "../../types.js";
import {
  deleteSessionComposerDraft,
  setSessionComposerDraft,
  type ComposerDraftStateByStorageKey,
} from "../../pages/session-composer-drafts.js";

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
      let composerDrafts: ComposerDraftStateByStorageKey = {};
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
        pendingSessionDraftsList: async () => (persisted.current ? [persisted.current] : []),
        pendingSessionDraftsPut: async (input) => {
          persisted.current = summaryFromPut(input);
          return persisted.current;
        },
        pendingSessionDraftsDelete: async () => true,
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
        composerDraftCommands: {
          writeDraft: (storageKey, value) => {
            composerDrafts = setSessionComposerDraft(composerDrafts, { storageKey }, value);
          },
          deleteDraft: (storageKey) => {
            composerDrafts = deleteSessionComposerDraft(composerDrafts, { storageKey });
          },
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
      assert.equal(persisted.current.id, GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID);
      assert.equal(persisted.current.workspaceId, "workspace-1");
      assert.equal(persisted.current.directory, "C:/work/project");
      assert.equal(activePendingDraftKey(), targetKey);
      assert.equal(activePendingDraftMeta()?.id, persisted.current.id);
      assert.equal(composerDrafts[globalComposerStorageKey]?.draft.text, "ship this");
      assert.equal(composerDrafts[targetKey], undefined);
      assert.deepEqual(activatedWorkspaces, []);
      assert.deepEqual(views, ["session"]);
    } finally {
      dispose();
    }
  });
});

test("composer target switch cleans previous scratch workspace after global draft retarget succeeds", async () => {
  await createRoot(async (dispose) => {
    try {
      const chatKey = resolvePendingDraftKey({ kind: "new-private" });
      const globalComposerStorageKey = resolveComposerStorageKey({ pendingDraftKey: chatKey });
      const targetKey = resolvePendingDraftKey({
        kind: "directory",
        workspaceId: "workspace-1",
        directory: "C:/work/project",
      });
      const previousSummary: PendingSessionDraftSummary = {
        id: GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID,
        kind: "new-private",
        workspaceId: "scratch-old",
        directory: null,
        privateWorkspaceId: "scratch-old",
        createdAt: 10,
        updatedAt: 20,
        composer: {
          mode: "prompt",
          parts: [{ type: "text", text: "current private draft" }],
          attachments: [],
          text: "current private draft",
          resolvedText: "current private draft",
        },
      };
      const [activePendingDraftKey, setActivePendingDraftKey] = createSignal<string | null>(chatKey);
      const [activePendingDraftMeta, setActivePendingDraftMeta] = createSignal<PendingSessionDraftSummary | null>(
        previousSummary,
      );
      const persisted: { current: PendingSessionDraftSummary | null } = { current: previousSummary };
      const events: string[] = [];
      const forgottenWorkspaces: Array<{ workspaceId: string; deleteLocalData?: boolean }> = [];
      let composerDrafts: ComposerDraftStateByStorageKey = {};

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
        composerDraft: () => draft("move me"),
        pendingSessionDraftsList: async () => (persisted.current ? [persisted.current] : []),
        pendingSessionDraftsPut: async (input) => {
          events.push(`put:${input.kind}`);
          persisted.current = summaryFromPut(input);
          return persisted.current;
        },
        pendingSessionDraftsDelete: async (draftId) => {
          throw new Error(`global pending draft should not be deleted: ${draftId}`);
        },
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
          createScratchWorkspace: async () => ({ id: "scratch-new" }),
          forgetWorkspace: async (workspaceId, options) => {
            events.push(`forget:${workspaceId}`);
            forgottenWorkspaces.push({ workspaceId, deleteLocalData: options?.deleteLocalData });
            return true;
          },
          activateWorkspace: async () => true,
          pickWorkspaceFolder: async () => null,
          ensureWorkspaceForFolder: async () => null,
        },
        publishRegisteredWorkspaceToSidebar: () => undefined,
        composerDraftCommands: {
          writeDraft: (storageKey, value) => {
            composerDrafts = setSessionComposerDraft(composerDrafts, { storageKey }, value);
          },
          deleteDraft: (storageKey) => {
            composerDrafts = deleteSessionComposerDraft(composerDrafts, { storageKey });
          },
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

      const result = await controller.switchComposerTarget(targetKey);

      assert.deepEqual(result, { status: "switched" });
      assert.equal(persisted.current?.id, GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID);
      assert.equal(persisted.current?.kind, "directory");
      assert.equal(persisted.current?.workspaceId, "workspace-1");
      assert.equal(persisted.current?.directory, "C:/work/project");
      assert.equal(activePendingDraftKey(), targetKey);
      assert.equal(activePendingDraftMeta()?.kind, "directory");
      assert.equal(composerDrafts[globalComposerStorageKey]?.draft.text, "move me");
      assert.deepEqual(forgottenWorkspaces, [{ workspaceId: "scratch-old", deleteLocalData: true }]);
      assert.deepEqual(events, ["put:directory", "forget:scratch-old"]);
    } finally {
      dispose();
    }
  });
});

test("composer target switch ignores obsolete pending summaries before loading or marking targets", async () => {
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
      const obsoleteDirectorySummary: PendingSessionDraftSummary = {
        id: "pending-directory-obsolete",
        kind: "directory",
        workspaceId: "workspace-1",
        directory: "C:/work/project",
        privateWorkspaceId: null,
        createdAt: 10,
        updatedAt: 20,
        composer: {
          mode: "prompt",
          parts: [{ type: "text", text: "obsolete workspace draft" }],
          attachments: [],
          text: "obsolete workspace draft",
          resolvedText: "obsolete workspace draft",
        },
      };
      const obsoletePrivateSummary: PendingSessionDraftSummary = {
        id: "pending-new-private-scratch-obsolete",
        kind: "new-private",
        workspaceId: "scratch-obsolete",
        directory: null,
        privateWorkspaceId: "scratch-obsolete",
        createdAt: 10,
        updatedAt: 20,
        composer: {
          mode: "prompt",
          parts: [{ type: "text", text: "obsolete private draft" }],
          attachments: [],
          text: "obsolete private draft",
          resolvedText: "obsolete private draft",
        },
      };
      const persisted: { current: PendingSessionDraftSummary | null } = { current: null };
      let composerDrafts: ComposerDraftStateByStorageKey = {};

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
        pendingSessionDraftsList: async () => [
          obsoleteDirectorySummary,
          obsoletePrivateSummary,
          ...(persisted.current ? [persisted.current] : []),
        ],
        pendingSessionDraftsPut: async (input) => {
          persisted.current = summaryFromPut(input);
          return persisted.current;
        },
        pendingSessionDraftsDelete: async () => true,
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
        composerDraftCommands: {
          writeDraft: (storageKey, value) => {
            composerDrafts = setSessionComposerDraft(composerDrafts, { storageKey }, value);
          },
          deleteDraft: (storageKey) => {
            composerDrafts = deleteSessionComposerDraft(composerDrafts, { storageKey });
          },
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

      assert.equal(controller.composerTargetOptions().find((option) => option.id === chatKey)?.draftStatus, null);
      assert.equal(controller.composerTargetOptions().find((option) => option.id === targetKey)?.draftStatus, null);

      const result = await controller.switchComposerTarget(targetKey);

      assert.deepEqual(result, { status: "switched" });
      assert.equal(persisted.current?.id, GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID);
      assert.equal(persisted.current?.workspaceId, "workspace-1");
      assert.equal(persisted.current?.directory, "C:/work/project");
      assert.equal(activePendingDraftKey(), targetKey);
      assert.equal(composerDrafts[globalComposerStorageKey]?.draft.text, "current draft");
    } finally {
      dispose();
    }
  });
});

test("composer target switch writes the global draft id for private chat targets", async () => {
  await createRoot(async (dispose) => {
    try {
      const workspaceKey = resolvePendingDraftKey({
        kind: "directory",
        workspaceId: "workspace-1",
        directory: "C:/work/project",
      });
      const obsoletePrivateSummary: PendingSessionDraftSummary = {
        id: "pending-new-private-scratch-obsolete",
        kind: "new-private",
        workspaceId: "scratch-obsolete",
        directory: null,
        privateWorkspaceId: "scratch-obsolete",
        createdAt: 10,
        updatedAt: 20,
        composer: {
          mode: "prompt",
          parts: [{ type: "text", text: "obsolete private draft" }],
          attachments: [],
          text: "obsolete private draft",
          resolvedText: "obsolete private draft",
        },
      };
      const [activePendingDraftKey, setActivePendingDraftKey] = createSignal<string | null>(workspaceKey);
      const [activePendingDraftMeta, setActivePendingDraftMeta] = createSignal<PendingSessionDraftSummary | null>(
        obsoletePrivateSummary,
      );
      const chatKey = resolvePendingDraftKey({ kind: "new-private" });
      const globalComposerStorageKey = resolveComposerStorageKey({ pendingDraftKey: chatKey });
      const persisted: { current: PendingSessionDraftSummary | null } = { current: null };
      const activatedWorkspaces: string[] = [];
      let composerDrafts: ComposerDraftStateByStorageKey = {};

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
        currentComposerStorageKey: () => workspaceKey,
        composerDraft: () => draft("private draft"),
        pendingSessionDraftsList: async () => [
          obsoletePrivateSummary,
          ...(persisted.current ? [persisted.current] : []),
        ],
        pendingSessionDraftsPut: async (input) => {
          persisted.current = summaryFromPut(input);
          return persisted.current;
        },
        pendingSessionDraftsDelete: async (draftId) => {
          throw new Error(`obsolete pending draft should not be deleted: ${draftId}`);
        },
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
          createScratchWorkspace: async () => ({ id: "scratch-global" }),
          forgetWorkspace: async () => true,
          activateWorkspace: async (workspaceId) => {
            activatedWorkspaces.push(workspaceId);
            return true;
          },
          pickWorkspaceFolder: async () => null,
          ensureWorkspaceForFolder: async () => null,
        },
        publishRegisteredWorkspaceToSidebar: () => undefined,
        composerDraftCommands: {
          writeDraft: (storageKey, value) => {
            composerDrafts = setSessionComposerDraft(composerDrafts, { storageKey }, value);
          },
          deleteDraft: (storageKey) => {
            composerDrafts = deleteSessionComposerDraft(composerDrafts, { storageKey });
          },
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

      assert.equal(controller.composerTargetOptions().find((option) => option.id === chatKey)?.draftStatus, null);

      const result = await controller.switchComposerTarget(chatKey);

      assert.deepEqual(result, { status: "switched" });
      assert.equal(persisted.current?.id, GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID);
      assert.equal(persisted.current?.kind, "new-private");
      assert.equal(persisted.current?.workspaceId, "scratch-global");
      assert.equal(persisted.current?.privateWorkspaceId, "scratch-global");
      assert.equal(persisted.current?.directory, null);
      assert.equal(activePendingDraftKey(), chatKey);
      assert.equal(activePendingDraftMeta()?.id, GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID);
      assert.equal(composerDrafts[globalComposerStorageKey]?.draft.text, "private draft");
      assert.deepEqual(activatedWorkspaces, ["scratch-global"]);
    } finally {
      dispose();
    }
  });
});

test("composer target switch refreshes stale pending draft summaries before moving the current draft", async () => {
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
      const destinationSummary: PendingSessionDraftSummary = {
        id: GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID,
        kind: "directory",
        workspaceId: "workspace-1",
        directory: "C:/work/project",
        privateWorkspaceId: null,
        createdAt: 10,
        updatedAt: 20,
        composer: {
          mode: "prompt",
          parts: [{ type: "text", text: "destination draft" }],
          attachments: [],
          text: "destination draft",
          resolvedText: "destination draft",
        },
      };
      let persistedSummaries: PendingSessionDraftSummary[] = [];
      const persistedInputs: PendingSessionDraftPutInput[] = [];
      let composerDrafts: ComposerDraftStateByStorageKey = {};

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
        pendingSessionDraftsList: async () => persistedSummaries,
        pendingSessionDraftsPut: async (input) => {
          persistedInputs.push(input);
          const summary = summaryFromPut(input);
          persistedSummaries = [summary];
          return summary;
        },
        pendingSessionDraftsDelete: async () => true,
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
        composerDraftCommands: {
          writeDraft: (storageKey, value) => {
            composerDrafts = setSessionComposerDraft(composerDrafts, { storageKey }, value);
          },
          deleteDraft: (storageKey) => {
            composerDrafts = deleteSessionComposerDraft(composerDrafts, { storageKey });
          },
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

      assert.deepEqual(result, { status: "switched" });
      assert.equal(persistedInputs.length, 1);
      assert.equal(persistedInputs[0]?.id, GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID);
      assert.equal(persistedInputs[0]?.workspaceId, "workspace-1");
      assert.equal(persistedInputs[0]?.directory, "C:/work/project");
      assert.equal(persistedInputs[0]?.composer.text, "current draft");
      assert.equal(activePendingDraftKey(), targetKey);
      assert.equal(activePendingDraftMeta()?.id, GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID);
      assert.equal(activePendingDraftMeta()?.composer.text, "current draft");
      assert.equal(composerDrafts[globalComposerStorageKey]?.draft.text, "current draft");
      assert.equal(composerDrafts[targetKey], undefined);
    } finally {
      dispose();
    }
  });
});
