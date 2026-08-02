import assert from "node:assert/strict";
import test from "node:test";
import { createRoot } from "solid-js";

import { createPendingSessionDraftController } from "../../context/pending-session-draft-controller.js";
import { resolveComposerStorageKey, resolvePendingDraftKey } from "../../lib/pending-session-drafts.js";
import type { PendingSessionDraft, PendingSessionDraftSummary } from "../../lib/tauri.js";
import type { ComposerDraft } from "../../types.js";
import {
  setSessionComposerDraft,
  type ComposerDraftStateByStorageKey,
} from "../../pages/session-composer-drafts.js";

const GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID = "pending-global-unpublished";

const draft = (text: string): ComposerDraft => ({
  mode: "prompt",
  parts: text ? [{ type: "text", text }] : [],
  attachments: [],
  text,
  resolvedText: text,
});

const draftWithAttachment = (text: string): ComposerDraft => ({
  ...draft(text),
  attachments: [
    {
      id: "att-1",
      name: "diagram.png",
      mimeType: "image/png",
      size: 42,
      kind: "image",
      dataUrl: "data:image/png;base64,AA==",
    },
  ],
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

test("pending draft controller ignores old private drafts and opens the global draft record", async () => {
  await createRoot(async (dispose) => {
    try {
      const oldPrivateDraft: PendingSessionDraft = {
        id: "pending-new-private-scratch-old",
        kind: "new-private",
        workspaceId: "scratch-old",
        privateWorkspaceId: "scratch-old",
        directory: null,
        createdAt: 5,
        updatedAt: 10,
        composer: draft("old private draft"),
      };
      const globalDraft: PendingSessionDraft = {
        id: GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID,
        kind: "new-private",
        workspaceId: "scratch-global",
        privateWorkspaceId: "scratch-global",
        directory: null,
        createdAt: 20,
        updatedAt: 30,
        composer: draft("global draft"),
      };
      const activatedWorkspaces: string[] = [];
      let composerDrafts: ComposerDraftStateByStorageKey = {};

      const controller = createPendingSessionDraftController({
        isTauriRuntime: () => true,
        createSessionAndOpen: async () => {
          throw new Error("web fallback should not create a real session on desktop");
        },
        createEmptyComposerDraft: () => draft(""),
        pendingSessionDraftsList: async () => [
          summaryFromDraft(oldPrivateDraft),
          summaryFromDraft(globalDraft),
        ],
        pendingSessionDraftsGet: async (id) => {
          assert.equal(id, GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID);
          return { draft: globalDraft, attachmentFailures: [] };
        },
        pendingSessionDraftsPut: async () => {
          throw new Error("existing global draft should be opened, not recreated");
        },
        pendingSessionDraftsDelete: async () => {
          throw new Error("old private draft should be ignored, not deleted");
        },
        workspace: {
          activeWorkspaceId: () => "scratch-global",
          activeWorkspaceDisplay: () => ({ id: "scratch-global", directory: "C:/scratch-global", path: "C:/scratch-global" }),
          workspaces: () => [{ id: "scratch-global", directory: "C:/scratch-global", path: "C:/scratch-global" }],
          activateWorkspace: async (workspaceId) => {
            activatedWorkspaces.push(workspaceId);
            return true;
          },
          createScratchWorkspace: async () => {
            throw new Error("existing global draft should not create another scratch workspace");
          },
          forgetWorkspace: async () => true,
          pickWorkspaceFolder: async () => null,
          ensureWorkspaceForFolder: async () => null,
        },
        publishRegisteredWorkspaceToSidebar: () => undefined,
        composerDraftCommands: {
          writeDraft: (storageKey, value) => {
            composerDrafts = setSessionComposerDraft(composerDrafts, { storageKey }, value);
          },
        },
        clearDisplayedSession: () => undefined,
        setView: () => undefined,
        setError: () => undefined,
        reportError: (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
        safeStringify: (value) => String(value),
        addOpencodeCacheHint: (message) => message,
      });

      const opened = await controller.openNewSessionWithDirectory();

      const pendingKey = resolvePendingDraftKey({ kind: "new-private" });
      const composerStorageKey = resolveComposerStorageKey({ pendingDraftKey: pendingKey });
      assert.equal(opened, true);
      assert.deepEqual(activatedWorkspaces, ["scratch-global"]);
      assert.equal(controller.activePendingDraftKey(), pendingKey);
      assert.equal(controller.activePendingDraftMeta()?.id, GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID);
      assert.equal(composerDrafts[composerStorageKey]?.draft.text, "global draft");
    } finally {
      dispose();
    }
  });
});

test("cross-workspace new conversation detaches the old session before activation and pending-draft storage settle", async () => {
  await createRoot(async (dispose) => {
    try {
      let releaseList: ((value: PendingSessionDraftSummary[]) => void) | null = null;
      let clearDisplayedSessionCalls = 0;
      let activeWorkspaceId = "workspace-a";
      const activatedWorkspaces: string[] = [];
      const views: string[] = [];
      const controller = createPendingSessionDraftController({
        isTauriRuntime: () => true,
        createSessionAndOpen: async () => {
          throw new Error("desktop flow must create a pending draft before a real session");
        },
        createEmptyComposerDraft: () => draft(""),
        pendingSessionDraftsList: async () => await new Promise((resolve) => {
          releaseList = resolve;
        }),
        pendingSessionDraftsGet: async () => null,
        pendingSessionDraftsPut: async (input) => summaryFromDraft({ ...input, id: input.id }),
        pendingSessionDraftsDelete: async () => true,
        workspace: {
          activeWorkspaceId: () => activeWorkspaceId,
          activeWorkspaceDisplay: () => ({ id: activeWorkspaceId, directory: `C:/${activeWorkspaceId}`, path: `C:/${activeWorkspaceId}` }),
          workspaces: () => [
            { id: "workspace-a", directory: "C:/workspace-a", path: "C:/workspace-a" },
            { id: "workspace-b", directory: "C:/workspace-b", path: "C:/workspace-b" },
          ],
          activateWorkspace: async (workspaceId) => {
            activatedWorkspaces.push(workspaceId);
            activeWorkspaceId = workspaceId;
            return true;
          },
          createScratchWorkspace: async () => null,
          forgetWorkspace: async () => true,
          pickWorkspaceFolder: async () => null,
          ensureWorkspaceForFolder: async () => null,
        },
        publishRegisteredWorkspaceToSidebar: () => undefined,
        composerDraftCommands: { writeDraft: () => undefined },
        clearDisplayedSession: () => {
          clearDisplayedSessionCalls += 1;
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

      const opened = controller.openPendingDirectoryDraftInWorkspace("workspace-b");
      assert.equal(clearDisplayedSessionCalls, 1, "the previous conversation must be detached before async activation");
      assert.deepEqual(views, ["session"], "the old session route must be cleared before async activation");
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.ok(releaseList, "pending-draft storage should begin after the synchronous detach");
      (releaseList as (value: PendingSessionDraftSummary[]) => void)([]);
      assert.equal(await opened, true);
      assert.deepEqual(activatedWorkspaces, ["workspace-b"]);
    } finally {
      dispose();
    }
  });
});

test("pending draft controller creates the global draft record when only old private drafts exist", async () => {
  await createRoot(async (dispose) => {
    try {
      const oldPrivateDraft: PendingSessionDraft = {
        id: "pending-new-private-scratch-old",
        kind: "new-private",
        workspaceId: "scratch-old",
        privateWorkspaceId: "scratch-old",
        directory: null,
        createdAt: 5,
        updatedAt: 10,
        composer: draft("old private draft"),
      };
      const persistedDrafts: PendingSessionDraft[] = [];

      const controller = createPendingSessionDraftController({
        isTauriRuntime: () => true,
        createSessionAndOpen: async () => {
          throw new Error("web fallback should not create a real session on desktop");
        },
        createEmptyComposerDraft: () => draft(""),
        pendingSessionDraftsList: async () => [summaryFromDraft(oldPrivateDraft)],
        pendingSessionDraftsGet: async () => ({ draft: oldPrivateDraft, attachmentFailures: [] }),
        pendingSessionDraftsPut: async (input) => {
          persistedDrafts.push(input);
          return summaryFromDraft(input);
        },
        pendingSessionDraftsDelete: async () => {
          throw new Error("old private draft should be ignored, not deleted");
        },
        workspace: {
          activeWorkspaceId: () => "scratch-global",
          activeWorkspaceDisplay: () => ({ id: "scratch-global", directory: "C:/scratch-global", path: "C:/scratch-global" }),
          workspaces: () => [{ id: "scratch-global", directory: "C:/scratch-global", path: "C:/scratch-global" }],
          activateWorkspace: async () => true,
          createScratchWorkspace: async () => ({ id: "scratch-global" }),
          forgetWorkspace: async () => true,
          pickWorkspaceFolder: async () => null,
          ensureWorkspaceForFolder: async () => null,
        },
        publishRegisteredWorkspaceToSidebar: () => undefined,
        composerDraftCommands: { writeDraft: () => undefined },
        clearDisplayedSession: () => undefined,
        setView: () => undefined,
        setError: () => undefined,
        reportError: (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
        safeStringify: (value) => String(value),
        addOpencodeCacheHint: (message) => message,
      });

      const opened = await controller.openNewSessionWithDirectory();
      const [persistedDraft] = persistedDrafts;

      assert.equal(opened, true);
      assert.ok(persistedDraft);
      assert.equal(persistedDraft.id, "pending-global-unpublished");
      assert.equal(controller.activePendingDraftMeta()?.id, GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID);
    } finally {
      dispose();
    }
  });
});

test("pending draft controller updates one global draft record for directory targets", async () => {
  await createRoot(async (dispose) => {
    try {
      const persistedDrafts: PendingSessionDraft[] = [];

      const controller = createPendingSessionDraftController({
        isTauriRuntime: () => true,
        createSessionAndOpen: async () => {
          throw new Error("web fallback should not create a real session on desktop");
        },
        createEmptyComposerDraft: () => draft(""),
        pendingSessionDraftsList: async () => persistedDrafts.map(summaryFromDraft),
        pendingSessionDraftsGet: async () => null,
        pendingSessionDraftsPut: async (input) => {
          persistedDrafts.push(input);
          return summaryFromDraft(input);
        },
        pendingSessionDraftsDelete: async () => {
          throw new Error("directory target switch should update the global draft, not delete old drafts");
        },
        workspace: {
          activeWorkspaceId: () => "workspace-b",
          activeWorkspaceDisplay: () => ({ id: "workspace-b", directory: "/repo/b", path: "/repo/b" }),
          workspaces: () => [{ id: "workspace-b", directory: "/repo/b", path: "/repo/b" }],
          activateWorkspace: async () => true,
          createScratchWorkspace: async () => ({ id: "scratch-global" }),
          forgetWorkspace: async () => true,
          pickWorkspaceFolder: async () => null,
          ensureWorkspaceForFolder: async () => null,
        },
        publishRegisteredWorkspaceToSidebar: () => undefined,
        composerDraftCommands: { writeDraft: () => undefined },
        clearDisplayedSession: () => undefined,
        setView: () => undefined,
        setError: () => undefined,
        reportError: (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
        safeStringify: (value) => String(value),
        addOpencodeCacheHint: (message) => message,
      });

      await controller.openDirectoryPendingDraft({ workspaceId: "workspace-a", directory: "/repo/a" });
      await controller.openDirectoryPendingDraft({ workspaceId: "workspace-b", directory: "/repo/b" });

      assert.equal(persistedDrafts.length, 2);
      assert.equal(persistedDrafts[0]?.id, "pending-global-unpublished");
      assert.equal(persistedDrafts[0]?.workspaceId, "workspace-a");
      assert.equal(persistedDrafts[0]?.directory, "/repo/a");
      assert.equal(persistedDrafts[1]?.id, "pending-global-unpublished");
      assert.equal(persistedDrafts[1]?.workspaceId, "workspace-b");
      assert.equal(persistedDrafts[1]?.directory, "/repo/b");
    } finally {
      dispose();
    }
  });
});

test("pending draft controller preserves global draft text when switching between directory targets", async () => {
  await createRoot(async (dispose) => {
    try {
      let storedDraft: PendingSessionDraft = {
        id: GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID,
        kind: "directory",
        workspaceId: "workspace-a",
        directory: "/repo/a",
        privateWorkspaceId: null,
        createdAt: 10,
        updatedAt: 20,
        composer: draft("keep this directory text"),
      };
      let composerDrafts: ComposerDraftStateByStorageKey = {};

      const controller = createPendingSessionDraftController({
        isTauriRuntime: () => true,
        createSessionAndOpen: async () => {
          throw new Error("web fallback should not create a real session on desktop");
        },
        createEmptyComposerDraft: () => {
          throw new Error("existing global draft should preserve composer instead of creating empty draft");
        },
        pendingSessionDraftsList: async () => [summaryFromDraft(storedDraft)],
        pendingSessionDraftsGet: async (id) => {
          assert.equal(id, GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID);
          return { draft: storedDraft, attachmentFailures: [] };
        },
        pendingSessionDraftsPut: async (input) => {
          storedDraft = input;
          return summaryFromDraft(input);
        },
        pendingSessionDraftsDelete: async () => {
          throw new Error("target switch should update the global draft, not delete it");
        },
        workspace: {
          activeWorkspaceId: () => "workspace-b",
          activeWorkspaceDisplay: () => ({ id: "workspace-b", directory: "/repo/b", path: "/repo/b" }),
          workspaces: () => [{ id: "workspace-b", directory: "/repo/b", path: "/repo/b" }],
          activateWorkspace: async () => true,
          createScratchWorkspace: async () => {
            throw new Error("directory target switch should not create a scratch workspace");
          },
          forgetWorkspace: async () => true,
          pickWorkspaceFolder: async () => null,
          ensureWorkspaceForFolder: async () => null,
        },
        publishRegisteredWorkspaceToSidebar: () => undefined,
        composerDraftCommands: {
          writeDraft: (storageKey, value) => {
            composerDrafts = setSessionComposerDraft(composerDrafts, { storageKey }, value);
          },
        },
        clearDisplayedSession: () => undefined,
        setView: () => undefined,
        setError: () => undefined,
        reportError: (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
        safeStringify: (value) => String(value),
        addOpencodeCacheHint: (message) => message,
      });

      const openedKey = await controller.openDirectoryPendingDraft({ workspaceId: "workspace-b", directory: "/repo/b" });
      const composerStorageKey = resolveComposerStorageKey({ pendingDraftKey: openedKey });

      assert.equal(storedDraft.id, GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID);
      assert.equal(storedDraft.kind, "directory");
      assert.equal(storedDraft.workspaceId, "workspace-b");
      assert.equal(storedDraft.directory, "/repo/b");
      assert.equal(storedDraft.composer.text, "keep this directory text");
      assert.equal(composerDrafts[composerStorageKey]?.draft.text, "keep this directory text");
    } finally {
      dispose();
    }
  });
});

test("pending draft controller preserves attachments when switching directory draft to private chat", async () => {
  await createRoot(async (dispose) => {
    try {
      let storedDraft: PendingSessionDraft = {
        id: GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID,
        kind: "directory",
        workspaceId: "workspace-a",
        directory: "/repo/a",
        privateWorkspaceId: null,
        createdAt: 10,
        updatedAt: 20,
        composer: draftWithAttachment("keep this attachment"),
      };
      let composerDrafts: ComposerDraftStateByStorageKey = {};

      const controller = createPendingSessionDraftController({
        isTauriRuntime: () => true,
        createSessionAndOpen: async () => {
          throw new Error("web fallback should not create a real session on desktop");
        },
        createEmptyComposerDraft: () => {
          throw new Error("existing global draft should preserve composer instead of creating empty draft");
        },
        pendingSessionDraftsList: async () => [summaryFromDraft(storedDraft)],
        pendingSessionDraftsGet: async (id) => {
          assert.equal(id, GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID);
          return { draft: storedDraft, attachmentFailures: [] };
        },
        pendingSessionDraftsPut: async (input) => {
          storedDraft = input;
          return summaryFromDraft(input);
        },
        pendingSessionDraftsDelete: async () => {
          throw new Error("target switch should update the global draft, not delete it");
        },
        workspace: {
          activeWorkspaceId: () => "scratch-new",
          activeWorkspaceDisplay: () => ({ id: "scratch-new", directory: "C:/scratch-new", path: "C:/scratch-new" }),
          workspaces: () => [{ id: "scratch-new", directory: "C:/scratch-new", path: "C:/scratch-new" }],
          activateWorkspace: async (workspaceId) => {
            assert.equal(workspaceId, "scratch-new");
            return true;
          },
          createScratchWorkspace: async () => ({ id: "scratch-new" }),
          forgetWorkspace: async () => true,
          pickWorkspaceFolder: async () => null,
          ensureWorkspaceForFolder: async () => null,
        },
        publishRegisteredWorkspaceToSidebar: () => undefined,
        composerDraftCommands: {
          writeDraft: (storageKey, value) => {
            composerDrafts = setSessionComposerDraft(composerDrafts, { storageKey }, value);
          },
        },
        clearDisplayedSession: () => undefined,
        setView: () => undefined,
        setError: () => undefined,
        reportError: (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
        safeStringify: (value) => String(value),
        addOpencodeCacheHint: (message) => message,
      });

      const opened = await controller.openNewSessionWithDirectory();
      const pendingKey = resolvePendingDraftKey({ kind: "new-private" });
      const composerStorageKey = resolveComposerStorageKey({ pendingDraftKey: pendingKey });

      assert.equal(opened, true);
      assert.equal(storedDraft.kind, "new-private");
      assert.equal(storedDraft.privateWorkspaceId, "scratch-new");
      assert.equal(storedDraft.composer.text, "keep this attachment");
      assert.equal(storedDraft.composer.attachments[0]?.dataUrl, "data:image/png;base64,AA==");
      assert.equal(composerDrafts[composerStorageKey]?.draft.attachments[0]?.name, "diagram.png");
    } finally {
      dispose();
    }
  });
});

test("pending draft controller preserves text and cleans scratch after switching private draft to directory", async () => {
  await createRoot(async (dispose) => {
    try {
      let storedDraft: PendingSessionDraft = {
        id: GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID,
        kind: "new-private",
        workspaceId: "scratch-old",
        directory: null,
        privateWorkspaceId: "scratch-old",
        createdAt: 10,
        updatedAt: 20,
        composer: draft("private body"),
      };
      const forgottenWorkspaces: string[] = [];
      let composerDrafts: ComposerDraftStateByStorageKey = {};

      const controller = createPendingSessionDraftController({
        isTauriRuntime: () => true,
        createSessionAndOpen: async () => {
          throw new Error("web fallback should not create a real session on desktop");
        },
        createEmptyComposerDraft: () => {
          throw new Error("existing global draft should preserve composer instead of creating empty draft");
        },
        pendingSessionDraftsList: async () => [summaryFromDraft(storedDraft)],
        pendingSessionDraftsGet: async (id) => {
          assert.equal(id, GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID);
          return { draft: storedDraft, attachmentFailures: [] };
        },
        pendingSessionDraftsPut: async (input) => {
          storedDraft = input;
          return summaryFromDraft(input);
        },
        pendingSessionDraftsDelete: async () => {
          throw new Error("target switch should update the global draft, not delete it");
        },
        workspace: {
          activeWorkspaceId: () => "workspace-b",
          activeWorkspaceDisplay: () => ({ id: "workspace-b", directory: "/repo/b", path: "/repo/b" }),
          workspaces: () => [{ id: "workspace-b", directory: "/repo/b", path: "/repo/b" }],
          activateWorkspace: async () => true,
          createScratchWorkspace: async () => {
            throw new Error("private to directory switch should not create another scratch workspace");
          },
          forgetWorkspace: async (workspaceId, options) => {
            assert.deepEqual(options, { deleteLocalData: true });
            forgottenWorkspaces.push(workspaceId);
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
        },
        clearDisplayedSession: () => undefined,
        setView: () => undefined,
        setError: () => undefined,
        reportError: (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
        safeStringify: (value) => String(value),
        addOpencodeCacheHint: (message) => message,
      });

      const openedKey = await controller.openDirectoryPendingDraft({ workspaceId: "workspace-b", directory: "/repo/b" });
      const composerStorageKey = resolveComposerStorageKey({ pendingDraftKey: openedKey });

      assert.equal(storedDraft.kind, "directory");
      assert.equal(storedDraft.workspaceId, "workspace-b");
      assert.equal(storedDraft.directory, "/repo/b");
      assert.equal(storedDraft.privateWorkspaceId, null);
      assert.equal(storedDraft.composer.text, "private body");
      assert.deepEqual(forgottenWorkspaces, ["scratch-old"]);
      assert.equal(composerDrafts[composerStorageKey]?.draft.text, "private body");
    } finally {
      dispose();
    }
  });
});

test("pending draft controller reopens an existing global private draft without creating another scratch workspace", async () => {
  await createRoot(async (dispose) => {
    try {
      const existingDraft: PendingSessionDraft = {
        id: GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID,
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
      const openEvents: string[] = [];
      let composerDrafts: ComposerDraftStateByStorageKey = {};

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
        composerDraftCommands: {
          writeDraft: (storageKey, value) => {
            composerDrafts = setSessionComposerDraft(composerDrafts, { storageKey }, value);
            openEvents.push("restore-composer");
          },
        },
        clearDisplayedSession: () => {
          openEvents.push("clear-displayed-session");
        },
        setView: (view) => {
          views.push(view);
          openEvents.push(`view:${view}`);
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
      const composerStorageKey = resolveComposerStorageKey({ pendingDraftKey: pendingKey });
      assert.equal(opened, true);
      assert.deepEqual(activatedWorkspaces, ["scratch-1"]);
      assert.equal(controller.activePendingDraftKey(), pendingKey);
      assert.equal(controller.activePendingDraftMeta()?.id, GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID);
      assert.equal(composerDrafts[composerStorageKey]?.draft.text, "remember this");
      assert.deepEqual(views, ["session"]);
      assert.deepEqual(openEvents, ["restore-composer", "clear-displayed-session", "view:session"]);
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
        composerDraftCommands: { writeDraft: () => undefined },
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
