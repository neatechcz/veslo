import { createEffect, createSignal, untrack, type Accessor } from "solid-js";

import {
  openPendingDraftFromDirectorySelection,
  openPendingDraftWithWorkspaceActivation,
} from "../pages/session-navigation";
import { setSessionComposerDraft } from "../pages/session-composer-drafts";
import {
  GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID,
  isGlobalUnpublishedPendingDraftSummary,
  isPendingDraftKey,
  resolvePendingDraftKey,
} from "../lib/pending-session-drafts";
import {
  findStoredPendingDraftSummary,
  resolvePendingDraftStartupHydration,
} from "../controllers/pending-draft-startup-controller";
import type {
  PendingSessionDraftGetResult,
  PendingSessionDraftPutInput,
  PendingSessionDraftSummary,
} from "../lib/tauri";
import type { ComposerDraft, View } from "../types";
import { normalizeDirectoryPath } from "../utils/paths";
import type { WorkspaceActivationOptions } from "./workspace-types";

type PendingDraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type PendingDraftWorkspaceDisplay = {
  id?: string | null;
  directory?: string | null;
  path?: string | null;
};

type PendingDraftWorkspace = {
  activeWorkspaceId: () => string;
  activeWorkspaceDisplay: () => PendingDraftWorkspaceDisplay;
  workspaces: () => PendingDraftWorkspaceDisplay[];
  activateWorkspace: (
    workspaceId: string,
    options: WorkspaceActivationOptions,
  ) => Promise<boolean> | boolean | void;
  createScratchWorkspace: () => Promise<{ id: string } | null> | { id: string } | null;
  forgetWorkspace: (
    workspaceId: string,
    options?: { deleteLocalData?: boolean },
  ) => Promise<boolean> | boolean;
  pickWorkspaceFolder: () => Promise<string | null> | string | null;
  ensureWorkspaceForFolder: (
    folder: string,
  ) => Promise<{ id: string } | null> | { id: string } | null;
};

type SetComposerDraftBySessionId = (
  updater: (current: Record<string, ComposerDraft>) => Record<string, ComposerDraft>,
) => void;

export type PendingSessionDraftControllerDeps = {
  isTauriRuntime: () => boolean;
  storage?: PendingDraftStorage | null;
  createSessionAndOpen: () => Promise<string | undefined> | string | undefined | void;
  createEmptyComposerDraft: () => ComposerDraft;
  pendingSessionDraftsList: () => Promise<PendingSessionDraftSummary[]>;
  pendingSessionDraftsGet: (draftId: string) => Promise<PendingSessionDraftGetResult | null>;
  pendingSessionDraftsPut: (draft: PendingSessionDraftPutInput) => Promise<PendingSessionDraftSummary>;
  pendingSessionDraftsDelete: (draftId: string) => Promise<boolean>;
  workspace: PendingDraftWorkspace;
  publishRegisteredWorkspaceToSidebar: (workspaceId: string) => Promise<void> | void;
  setComposerDraftBySessionId: SetComposerDraftBySessionId;
  clearDisplayedSession?: () => void;
  setView: (view: View) => void;
  setError: (message: string | null) => void;
  reportError: (error: unknown, scope: string) => void;
  onOpenNewSessionFailure?: (input: {
    scope: "new-private" | "directory";
    error: unknown;
    workspaceId?: string | null;
    directory?: string | null;
  }) => void;
  safeStringify: (value: unknown) => string;
  addOpencodeCacheHint: (message: string) => string;
};

export type ActivePendingDraftPersistenceInput = {
  selectedSessionId: Accessor<string | null>;
  composerDraft: Accessor<ComposerDraft>;
};

const ACTIVE_PENDING_DRAFT_KEY = "veslo.active-pending-draft.v1";
const CONSUMED_PENDING_DRAFT_IDS_KEY = "veslo.consumed-pending-draft-ids.v1";

const resolveStorage = (storage?: PendingDraftStorage | null): PendingDraftStorage | null => {
  if (storage) return storage;
  if (typeof window === "undefined") return null;
  return window.localStorage;
};

export function createPendingSessionDraftController(deps: PendingSessionDraftControllerDeps) {
  const [activePendingDraftKey, setActivePendingDraftKey] = createSignal<string | null>(null);
  const [activePendingDraftMeta, setActivePendingDraftMeta] = createSignal<PendingSessionDraftSummary | null>(null);
  const [activePendingDraftStorageReady, setActivePendingDraftStorageReady] = createSignal(false);

  const readActivePendingDraftKey = () => {
    const storage = resolveStorage(deps.storage);
    if (!storage) return null;
    try {
      const stored = storage.getItem(ACTIVE_PENDING_DRAFT_KEY)?.trim() ?? "";
      return isPendingDraftKey(stored) ? stored : null;
    } catch {
      return null;
    }
  };

  const writeActivePendingDraftKey = (value: string | null) => {
    const storage = resolveStorage(deps.storage);
    if (!storage) return;
    try {
      const nextValue = value?.trim() ?? "";
      if (!nextValue) {
        storage.removeItem(ACTIVE_PENDING_DRAFT_KEY);
        return;
      }
      storage.setItem(ACTIVE_PENDING_DRAFT_KEY, nextValue);
    } catch {
      // ignore
    }
  };

  const readConsumedPendingDraftIds = () => {
    const storage = resolveStorage(deps.storage);
    if (!storage) return new Set<string>();
    try {
      const raw = storage.getItem(CONSUMED_PENDING_DRAFT_IDS_KEY);
      if (!raw) return new Set<string>();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set<string>();
      return new Set(
        parsed
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter(Boolean),
      );
    } catch {
      return new Set<string>();
    }
  };

  const writeConsumedPendingDraftIds = (values: Set<string>) => {
    const storage = resolveStorage(deps.storage);
    if (!storage) return;
    try {
      if (values.size === 0) {
        storage.removeItem(CONSUMED_PENDING_DRAFT_IDS_KEY);
        return;
      }
      storage.setItem(CONSUMED_PENDING_DRAFT_IDS_KEY, JSON.stringify(Array.from(values)));
    } catch {
      // ignore
    }
  };

  const isConsumedPendingDraftId = (value: string | null | undefined) => {
    const trimmed = (value ?? "").trim();
    if (!trimmed) return false;
    return readConsumedPendingDraftIds().has(trimmed);
  };

  const markPendingDraftConsumed = (value: string | null | undefined) => {
    const trimmed = (value ?? "").trim();
    if (!trimmed) return;
    const next = readConsumedPendingDraftIds();
    next.add(trimmed);
    writeConsumedPendingDraftIds(next);
  };

  const clearConsumedPendingDraftId = (value: string | null | undefined) => {
    const trimmed = (value ?? "").trim();
    if (!trimmed) return;
    const next = readConsumedPendingDraftIds();
    if (!next.delete(trimmed)) return;
    writeConsumedPendingDraftIds(next);
  };

  const listGlobalPendingDraftSummaries = async () =>
    (await deps.pendingSessionDraftsList()).filter(
      (draft) => isGlobalUnpublishedPendingDraftSummary(draft) && !isConsumedPendingDraftId(draft.id),
    );

  const formatPendingDraftAttachmentRestoreError = (
    attachmentFailures: { attachmentId: string; name: string; message: string }[],
  ) => {
    if (!attachmentFailures.length) return null;
    if (attachmentFailures.length === 1) {
      return "One pending draft attachment could not be restored and was removed.";
    }
    return `${attachmentFailures.length} pending draft attachments could not be restored and were removed.`;
  };

  const clearActivePendingDraftState = () => {
    setActivePendingDraftKey(null);
    setActivePendingDraftMeta(null);
    writeActivePendingDraftKey(null);
  };

  const restorePendingDraftComposer = (storageKey: string, draft: ComposerDraft) => {
    deps.setComposerDraftBySessionId((current) => setSessionComposerDraft(current, { storageKey }, draft));
  };

  const openPendingDraftSession = (
    storageKey: string,
    summary: PendingSessionDraftSummary,
    draft: ComposerDraft,
  ) => {
    setActivePendingDraftKey(storageKey);
    setActivePendingDraftMeta(summary);
    restorePendingDraftComposer(storageKey, draft);
    deps.clearDisplayedSession?.();
    deps.setView("session");
  };

  const putRetargetedGlobalPendingDraft = async (input: {
    summary: PendingSessionDraftSummary;
    composer: ComposerDraft;
    kind: PendingSessionDraftSummary["kind"];
    workspaceId: string;
    directory: string | null;
    privateWorkspaceId: string | null;
  }) =>
    await deps.pendingSessionDraftsPut({
      id: GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID,
      kind: input.kind,
      workspaceId: input.workspaceId,
      directory: input.directory,
      privateWorkspaceId: input.privateWorkspaceId,
      createdAt: input.summary.createdAt,
      updatedAt: Date.now(),
      composer: input.composer,
    });

  const reportPendingDraftRestoreFailures = (
    attachmentFailures: { attachmentId: string; name: string; message: string }[],
  ) => {
    const restoreError = formatPendingDraftAttachmentRestoreError(attachmentFailures);
    if (restoreError) {
      deps.setError(restoreError);
    }
  };

  const cleanupPreviousPrivateWorkspace = async (
    previousPrivateWorkspaceId: string | null | undefined,
    nextWorkspaceId: string,
  ) => {
    const trimmedPrevious = previousPrivateWorkspaceId?.trim() ?? "";
    if (!trimmedPrevious || trimmedPrevious === nextWorkspaceId.trim()) return;

    try {
      const cleanupSucceeded = await deps.workspace.forgetWorkspace(trimmedPrevious, { deleteLocalData: true });
      if (!cleanupSucceeded) {
        throw new Error(`Failed to clean up previous private chat workspace ${trimmedPrevious}.`);
      }
    } catch (error) {
      deps.reportError(error, "pendingDrafts.cleanupPrivateWorkspace");
      deps.setError("Private chat workspace cleanup failed. Draft was preserved.");
    }
  };

  const createActivePendingDraftPersistenceEffect = (input: ActivePendingDraftPersistenceInput) => {
    createEffect(() => {
      if (!activePendingDraftStorageReady()) return;
      writeActivePendingDraftKey(activePendingDraftKey());
    });

    let pendingDraftPersistenceQueue: Promise<void> = Promise.resolve();
    let pendingDraftPersistenceGeneration = 0;

    createEffect(() => {
      if (!deps.isTauriRuntime()) return;
      if (!activePendingDraftStorageReady()) return;
      const pendingDraftKey = activePendingDraftKey();
      const pendingDraftMetaValue = activePendingDraftMeta();
      if (!pendingDraftKey || !pendingDraftMetaValue) return;
      if (input.selectedSessionId()) return;

      const persistedDraft = input.composerDraft();
      const pendingDraftId = pendingDraftMetaValue.id.trim();
      if (!pendingDraftId) return;
      const generation = ++pendingDraftPersistenceGeneration;

      pendingDraftPersistenceQueue = pendingDraftPersistenceQueue
        .then(() => untrack(() => (async () => {
          if (pendingDraftPersistenceGeneration !== generation) return;
          const activePendingDraftKeyValue = activePendingDraftKey();
          const activePendingDraftId = activePendingDraftMeta()?.id.trim() || "";
          if (input.selectedSessionId()) return;
          if (activePendingDraftKeyValue !== pendingDraftKey) return;
          if (activePendingDraftId !== pendingDraftId) return;
          await deps.pendingSessionDraftsPut({
            id: pendingDraftId,
            kind: pendingDraftMetaValue.kind,
            workspaceId: pendingDraftMetaValue.workspaceId,
            directory: pendingDraftMetaValue.directory ?? null,
            privateWorkspaceId: pendingDraftMetaValue.privateWorkspaceId ?? null,
            createdAt: pendingDraftMetaValue.createdAt,
            updatedAt: Date.now(),
            composer: persistedDraft,
          });
        })()))
        .catch((error) => {
          deps.reportError(error, "pendingDrafts.persist");
        });
    });
  };

  const hydrateActivePendingDraft = async () => {
    if (!deps.isTauriRuntime()) return;
    const storedPendingDraftKey = readActivePendingDraftKey();
    if (!storedPendingDraftKey) return;

    try {
      const pendingDrafts = await listGlobalPendingDraftSummaries();
      const matchingPendingDraft = findStoredPendingDraftSummary({
        storedPendingDraftKey,
        pendingDrafts,
      });
      const loadedPendingDraft = matchingPendingDraft
        ? await deps.pendingSessionDraftsGet(matchingPendingDraft.id)
        : null;
      const restoreError = loadedPendingDraft
        ? formatPendingDraftAttachmentRestoreError(loadedPendingDraft.attachmentFailures)
        : null;
      const hydrationDecision = resolvePendingDraftStartupHydration({
        storedPendingDraftKey,
        matchingPendingDraft,
        loadedPendingDraft,
        restoreError,
      });

      switch (hydrationDecision.type) {
        case "skip":
          break;
        case "clear":
          clearActivePendingDraftState();
          break;
        case "hydrate":
          if (hydrationDecision.restoreError) {
            deps.setError(hydrationDecision.restoreError);
          }
          setActivePendingDraftKey(hydrationDecision.storageKey);
          setActivePendingDraftMeta(hydrationDecision.summary);
          restorePendingDraftComposer(hydrationDecision.storageKey, hydrationDecision.loadedDraft.draft.composer);
          break;
      }
    } catch (error) {
      deps.reportError(error, "pendingDrafts.hydrate");
      clearActivePendingDraftState();
    }
  };

  const openNewSessionWithDirectory = async () => {
    if (!deps.isTauriRuntime()) {
      await deps.createSessionAndOpen();
      return true;
    }

    try {
      const newPrivatePendingDraftKey = resolvePendingDraftKey({ kind: "new-private" });
      const pendingDrafts = await listGlobalPendingDraftSummaries();
      const existingPendingDraft = pendingDrafts.find((draft) => draft.kind === "new-private") ?? null;

      if (existingPendingDraft) {
        const pendingDraft = await deps.pendingSessionDraftsGet(existingPendingDraft.id);
        if (pendingDraft) {
          reportPendingDraftRestoreFailures(pendingDraft.attachmentFailures);
          const pendingWorkspaceId = (existingPendingDraft.privateWorkspaceId ?? existingPendingDraft.workspaceId).trim();
          if (!pendingWorkspaceId) {
            await deps.pendingSessionDraftsDelete(existingPendingDraft.id);
            markPendingDraftConsumed(existingPendingDraft.id);
          } else {
            const activatedPendingWorkspace = await deps.workspace.activateWorkspace(pendingWorkspaceId, {
              origin: "app:new-private-existing-pending-draft",
            });
            if (!activatedPendingWorkspace) {
              await deps.pendingSessionDraftsDelete(existingPendingDraft.id);
              markPendingDraftConsumed(existingPendingDraft.id);
            } else {
              openPendingDraftSession(newPrivatePendingDraftKey, existingPendingDraft, pendingDraft.draft.composer);
              return true;
            }
          }
        } else {
          await deps.pendingSessionDraftsDelete(existingPendingDraft.id);
          markPendingDraftConsumed(existingPendingDraft.id);
        }
      }

      const existingGlobalDirectoryDraft = pendingDrafts.find((draft) => draft.kind === "directory") ?? null;
      if (existingGlobalDirectoryDraft) {
        const loadedGlobalDraft = await deps.pendingSessionDraftsGet(existingGlobalDirectoryDraft.id);
        if (loadedGlobalDraft) {
          reportPendingDraftRestoreFailures(loadedGlobalDraft.attachmentFailures);

          const scratch = await deps.workspace.createScratchWorkspace();
          if (!scratch?.id) {
            deps.setError("Failed to create a private chat workspace.");
            return false;
          }

          const cleanupFreshScratchWorkspace = async () => {
            const cleanupSucceeded = await deps.workspace.forgetWorkspace(scratch.id, { deleteLocalData: true });
            if (!cleanupSucceeded) {
              throw new Error(`Failed to clean up failed scratch workspace ${scratch.id}.`);
            }
          };

          try {
            const activatedScratchWorkspace = await deps.workspace.activateWorkspace(scratch.id, {
              origin: "app:new-private-scratch-workspace",
            });
            if (!activatedScratchWorkspace) {
              await cleanupFreshScratchWorkspace();
              deps.setError("Failed to activate the private chat workspace.");
              return false;
            }

            const pendingDraft = await putRetargetedGlobalPendingDraft({
              summary: existingGlobalDirectoryDraft,
              composer: loadedGlobalDraft.draft.composer,
              kind: "new-private",
              workspaceId: scratch.id,
              directory: null,
              privateWorkspaceId: scratch.id,
            });
            openPendingDraftSession(newPrivatePendingDraftKey, pendingDraft, loadedGlobalDraft.draft.composer);
            return true;
          } catch (error) {
            await cleanupFreshScratchWorkspace();
            throw error;
          }
        }
      }

      const scratch = await deps.workspace.createScratchWorkspace();
      if (!scratch?.id) {
        deps.setError("Failed to create a private chat workspace.");
        return false;
      }

      const cleanupFreshScratchWorkspace = async () => {
        const cleanupSucceeded = await deps.workspace.forgetWorkspace(scratch.id, { deleteLocalData: true });
        if (!cleanupSucceeded) {
          throw new Error(`Failed to clean up failed scratch workspace ${scratch.id}.`);
        }
      };
      const emptyPendingDraft = deps.createEmptyComposerDraft();
      const now = Date.now();

      try {
        const activatedScratchWorkspace = await deps.workspace.activateWorkspace(scratch.id, {
          origin: "app:new-private-scratch-workspace",
        });
        if (!activatedScratchWorkspace) {
          await cleanupFreshScratchWorkspace();
          deps.setError("Failed to activate the private chat workspace.");
          return false;
        }
        const pendingDraft = await deps.pendingSessionDraftsPut({
          id: GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID,
          kind: "new-private",
          workspaceId: scratch.id,
          directory: null,
          privateWorkspaceId: scratch.id,
          createdAt: now,
          updatedAt: now,
          composer: emptyPendingDraft,
        });
        openPendingDraftSession(newPrivatePendingDraftKey, pendingDraft, emptyPendingDraft);
        return true;
      } catch (error) {
        await cleanupFreshScratchWorkspace();
        throw error;
      }
    } catch (error) {
      deps.reportError(error, "pendingDrafts.newPrivate");
      deps.onOpenNewSessionFailure?.({
        scope: "new-private",
        error,
        workspaceId: deps.workspace.activeWorkspaceId(),
      });
      const message = error instanceof Error ? error.message : deps.safeStringify(error);
      deps.setError(deps.addOpencodeCacheHint(message));
      return false;
    }
  };

  const openDirectoryPendingDraft = async (input: { workspaceId: string; directory: string }) => {
    if (!deps.isTauriRuntime()) {
      const createdSessionId = await deps.createSessionAndOpen();
      return createdSessionId?.trim() ?? "";
    }

    const workspaceId = input.workspaceId.trim();
    const directory = normalizeDirectoryPath(input.directory);
    if (!workspaceId || !directory) return "";

    try {
      const pendingDraftKey = resolvePendingDraftKey({
        kind: "directory",
        workspaceId,
        directory,
      });
      const pendingDrafts = await listGlobalPendingDraftSummaries();
      const existingPendingDraft =
        pendingDrafts.find(
          (draft) =>
            resolvePendingDraftKey({
              kind: draft.kind,
              workspaceId: draft.workspaceId,
              directory: draft.directory ?? null,
              privateWorkspaceId: draft.privateWorkspaceId ?? null,
            }) === pendingDraftKey,
        ) ?? null;

      if (existingPendingDraft) {
        const loadedPendingDraft = await deps.pendingSessionDraftsGet(existingPendingDraft.id);
        if (loadedPendingDraft) {
          reportPendingDraftRestoreFailures(loadedPendingDraft.attachmentFailures);
          openPendingDraftSession(pendingDraftKey, existingPendingDraft, loadedPendingDraft.draft.composer);
          return pendingDraftKey;
        }
      }

      const existingGlobalPendingDraft = pendingDrafts[0] ?? null;
      if (existingGlobalPendingDraft) {
        const loadedGlobalDraft = await deps.pendingSessionDraftsGet(existingGlobalPendingDraft.id);
        if (loadedGlobalDraft) {
          reportPendingDraftRestoreFailures(loadedGlobalDraft.attachmentFailures);

          const previousPrivateWorkspaceId =
            existingGlobalPendingDraft.kind === "new-private"
              ? existingGlobalPendingDraft.privateWorkspaceId ?? existingGlobalPendingDraft.workspaceId
              : null;
          const pendingDraft = await putRetargetedGlobalPendingDraft({
            summary: existingGlobalPendingDraft,
            composer: loadedGlobalDraft.draft.composer,
            kind: "directory",
            workspaceId,
            directory,
            privateWorkspaceId: null,
          });
          openPendingDraftSession(pendingDraftKey, pendingDraft, loadedGlobalDraft.draft.composer);
          await cleanupPreviousPrivateWorkspace(previousPrivateWorkspaceId, workspaceId);
          return pendingDraftKey;
        }
      }

      const emptyPendingDraft = deps.createEmptyComposerDraft();
      const now = Date.now();
      const pendingDraft = await deps.pendingSessionDraftsPut({
        id: GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID,
        kind: "directory",
        workspaceId,
        directory,
        privateWorkspaceId: null,
        createdAt: now,
        updatedAt: now,
        composer: emptyPendingDraft,
      });
      openPendingDraftSession(pendingDraftKey, pendingDraft, emptyPendingDraft);
      return pendingDraftKey;
    } catch (error) {
      deps.reportError(error, "pendingDrafts.directory");
      deps.onOpenNewSessionFailure?.({
        scope: "directory",
        error,
        workspaceId,
        directory,
      });
      const message = error instanceof Error ? error.message : deps.safeStringify(error);
      deps.setError(deps.addOpencodeCacheHint(message));
      return "";
    }
  };

  const openPendingDirectoryDraftInWorkspace = async (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return false;

    return await openPendingDraftWithWorkspaceActivation({
      activeWorkspaceId: deps.workspace.activeWorkspaceId(),
      getActiveWorkspaceId: () => deps.workspace.activeWorkspaceId(),
      workspaceId: id,
      activateWorkspace: (nextWorkspaceId) =>
        deps.workspace.activateWorkspace(nextWorkspaceId, {
          origin: "app:open-pending-directory-draft-workspace",
          promoteToFront: true,
        }),
      openPendingDraft: () => {
        const activeWorkspaceId = deps.workspace.activeWorkspaceId().trim();
        if (activeWorkspaceId !== id) return "";
        const targetWorkspace = deps.workspace.workspaces().find((workspace) => workspace.id?.trim() === id) ?? null;
        const directory = targetWorkspace?.directory?.trim() || targetWorkspace?.path?.trim() || "";
        if (!directory) return "";
        return openDirectoryPendingDraft({ workspaceId: id, directory });
      },
    });
  };

  const openDirectorySessionFromPicker = async () => {
    return await openPendingDraftFromDirectorySelection({
      activeWorkspaceId: deps.workspace.activeWorkspaceId(),
      getActiveWorkspaceId: () => deps.workspace.activeWorkspaceId(),
      pickDirectory: () => deps.workspace.pickWorkspaceFolder(),
      ensureWorkspaceForFolder: deps.workspace.ensureWorkspaceForFolder,
      onWorkspaceRegistered: ({ workspaceId }) => deps.publishRegisteredWorkspaceToSidebar(workspaceId),
      activateWorkspace: (workspaceId) =>
        deps.workspace.activateWorkspace(workspaceId, {
          origin: "app:open-directory-session-from-picker",
          promoteToFront: true,
        }),
      openPendingDraft: ({ workspaceId, directory }) => openDirectoryPendingDraft({ workspaceId, directory }),
    });
  };

  return {
    activePendingDraftKey,
    setActivePendingDraftKey,
    activePendingDraftMeta,
    setActivePendingDraftMeta,
    activePendingDraftStorageReady,
    markActivePendingDraftStorageReady: () => setActivePendingDraftStorageReady(true),
    readActivePendingDraftKey,
    isConsumedPendingDraftId,
    markPendingDraftConsumed,
    clearConsumedPendingDraftId,
    clearActivePendingDraftState,
    formatPendingDraftAttachmentRestoreError,
    createActivePendingDraftPersistenceEffect,
    hydrateActivePendingDraft,
    openNewSessionWithDirectory,
    openDirectoryPendingDraft,
    openPendingDirectoryDraftInWorkspace,
    openDirectorySessionFromPicker,
  };
}
