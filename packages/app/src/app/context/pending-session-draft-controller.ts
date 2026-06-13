import { createEffect, createSignal, type Accessor } from "solid-js";

import {
  openPendingDraftFromDirectorySelection,
  openPendingDraftWithWorkspaceActivation,
} from "../pages/session-navigation";
import { setSessionComposerDraft } from "../pages/session-composer-drafts";
import {
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
import type { WorkspaceActivationOptions } from "./workspace";

type PendingDraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type PendingDraftWorkspaceDisplay = {
  id?: string | null;
  directory?: string | null;
  path?: string | null;
};

type PendingDraftWorkspace = {
  activeWorkspaceId: () => string;
  activeWorkspaceDisplay: () => PendingDraftWorkspaceDisplay;
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
  setView: (view: View) => void;
  setError: (message: string | null) => void;
  reportError: (error: unknown, scope: string) => void;
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
        .then(async () => {
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
        })
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
      const pendingDrafts = (await deps.pendingSessionDraftsList()).filter((draft) => !isConsumedPendingDraftId(draft.id));
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
      return;
    }

    try {
      const newPrivatePendingDraftKey = resolvePendingDraftKey({ kind: "new-private" });
      const pendingDrafts = (await deps.pendingSessionDraftsList()).filter((draft) => !isConsumedPendingDraftId(draft.id));
      const existingPendingDraft = pendingDrafts.find((draft) => draft.kind === "new-private") ?? null;

      if (existingPendingDraft) {
        const pendingDraft = await deps.pendingSessionDraftsGet(existingPendingDraft.id);
        if (pendingDraft) {
          const restoreError = formatPendingDraftAttachmentRestoreError(pendingDraft.attachmentFailures);
          if (restoreError) {
            deps.setError(restoreError);
          }
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
              setActivePendingDraftKey(newPrivatePendingDraftKey);
              setActivePendingDraftMeta(existingPendingDraft);
              restorePendingDraftComposer(newPrivatePendingDraftKey, pendingDraft.draft.composer);
              deps.setView("session");
              return;
            }
          }
        } else {
          await deps.pendingSessionDraftsDelete(existingPendingDraft.id);
          markPendingDraftConsumed(existingPendingDraft.id);
        }
      }

      const scratch = await deps.workspace.createScratchWorkspace();
      if (!scratch?.id) return;

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
          return;
        }
        const pendingDraft = await deps.pendingSessionDraftsPut({
          id: `pending-new-private-${scratch.id}`,
          kind: "new-private",
          workspaceId: scratch.id,
          directory: null,
          privateWorkspaceId: scratch.id,
          createdAt: now,
          updatedAt: now,
          composer: emptyPendingDraft,
        });
        setActivePendingDraftKey(newPrivatePendingDraftKey);
        setActivePendingDraftMeta(pendingDraft);
        restorePendingDraftComposer(newPrivatePendingDraftKey, emptyPendingDraft);
        deps.setView("session");
        return;
      } catch (error) {
        await cleanupFreshScratchWorkspace();
        throw error;
      }
    } catch (error) {
      deps.reportError(error, "pendingDrafts.newPrivate");
      const message = error instanceof Error ? error.message : deps.safeStringify(error);
      deps.setError(deps.addOpencodeCacheHint(message));
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
      const pendingDrafts = (await deps.pendingSessionDraftsList()).filter((draft) => !isConsumedPendingDraftId(draft.id));
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
          const restoreError = formatPendingDraftAttachmentRestoreError(loadedPendingDraft.attachmentFailures);
          if (restoreError) {
            deps.setError(restoreError);
          }
          setActivePendingDraftKey(pendingDraftKey);
          setActivePendingDraftMeta(existingPendingDraft);
          restorePendingDraftComposer(pendingDraftKey, loadedPendingDraft.draft.composer);
          deps.setView("session");
          return pendingDraftKey;
        }
      }

      const emptyPendingDraft = deps.createEmptyComposerDraft();
      const now = Date.now();
      const pendingDraftIdSuffix =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${now}-${Math.random().toString(16).slice(2)}`;
      const pendingDraft = await deps.pendingSessionDraftsPut({
        id: `pending-directory-${pendingDraftIdSuffix}`,
        kind: "directory",
        workspaceId,
        directory,
        privateWorkspaceId: null,
        createdAt: now,
        updatedAt: now,
        composer: emptyPendingDraft,
      });
      setActivePendingDraftKey(pendingDraftKey);
      setActivePendingDraftMeta(pendingDraft);
      restorePendingDraftComposer(pendingDraftKey, emptyPendingDraft);
      deps.setView("session");
      return pendingDraftKey;
    } catch (error) {
      deps.reportError(error, "pendingDrafts.directory");
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
        const activeWorkspace = deps.workspace.activeWorkspaceDisplay();
        const directory = activeWorkspace.directory?.trim() || activeWorkspace.path?.trim() || "";
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
