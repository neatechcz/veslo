import { createEffect, createMemo, createSignal, type Accessor } from "solid-js";

import {
  deleteSessionComposerDraft,
  setSessionComposerDraft,
} from "../pages/session-composer-drafts";
import { resolveComposerTargetConflict } from "../lib/composer-target-draft-conflict";
import { resolvePendingDraftKey } from "../lib/pending-session-drafts";
import type {
  PendingSessionDraftGetResult,
  PendingSessionDraftPutInput,
  PendingSessionDraftSummary,
} from "../lib/tauri";
import type {
  ComposerDraft,
  ComposerTargetOption,
  ComposerTargetSwitchResolution,
  ComposerTargetSwitchResult,
  View,
  WorkspaceDisplay,
} from "../types";
import { normalizeDirectoryPath } from "../utils/paths";
import type { WorkspaceActivationOptions } from "./workspace-types";

type SetComposerDraftBySessionId = (
  updater: (current: Record<string, ComposerDraft>) => Record<string, ComposerDraft>,
) => void;

type ComposerTargetWorkspace = {
  id: string;
  directory?: string | null;
  path?: string | null;
  displayName?: string | null;
  vesloWorkspaceName?: string | null;
  vesloHostUrl?: string | null;
  baseUrl?: string | null;
  name?: string | null;
};

type ComposerTargetWorkspaceStore = {
  workspaces: () => ComposerTargetWorkspace[];
  activeWorkspaceId: () => string;
  activeWorkspaceDisplay: () => WorkspaceDisplay;
  activeWorkspaceRoot: () => string;
  isPrivateWorkspacePath: (folder: string | null | undefined) => boolean;
  createScratchWorkspace: () => Promise<{ id: string } | null> | { id: string } | null;
  forgetWorkspace: (
    workspaceId: string,
    options?: { deleteLocalData?: boolean },
  ) => Promise<boolean> | boolean;
  activateWorkspace: (
    workspaceId: string,
    options: WorkspaceActivationOptions,
  ) => Promise<boolean> | boolean | void;
  pickWorkspaceFolder: () => Promise<string | null> | string | null;
  ensureWorkspaceForFolder: (
    folder: string,
  ) => Promise<{ id: string } | null> | { id: string } | null;
};

export type ComposerTargetControllerDeps = {
  isTauriRuntime: () => boolean;
  labels: {
    chat: () => string;
    chooseWorkspace: () => string;
    chooseWorkspaceDescription: () => string;
    targetUnavailable: () => string;
  };
  activePendingDraftKey: Accessor<string | null>;
  setActivePendingDraftKey: (value: string | null) => void;
  activePendingDraftMeta: Accessor<PendingSessionDraftSummary | null>;
  setActivePendingDraftMeta: (value: PendingSessionDraftSummary | null) => void;
  currentComposerStorageKey: Accessor<string>;
  composerDraft: Accessor<ComposerDraft>;
  createEmptyComposerDraft: () => ComposerDraft;
  pendingSessionDraftsList: () => Promise<PendingSessionDraftSummary[]>;
  pendingSessionDraftsGet: (draftId: string) => Promise<PendingSessionDraftGetResult | null>;
  pendingSessionDraftsPut: (draft: PendingSessionDraftPutInput) => Promise<PendingSessionDraftSummary>;
  pendingSessionDraftsDelete: (draftId: string) => Promise<boolean>;
  formatPendingDraftAttachmentRestoreError: (
    attachmentFailures: { attachmentId: string; name: string; message: string }[],
  ) => string | null;
  isConsumedPendingDraftId: (draftId: string | null | undefined) => boolean;
  markPendingDraftConsumed: (draftId: string | null | undefined) => void;
  clearConsumedPendingDraftId: (draftId: string | null | undefined) => void;
  workspace: ComposerTargetWorkspaceStore;
  publishRegisteredWorkspaceToSidebar: (workspaceId: string) => Promise<void> | void;
  setComposerDraftBySessionId: SetComposerDraftBySessionId;
  setView: (view: View) => void;
  setError: (message: string | null) => void;
  reportError: (error: unknown, scope: string) => void;
  safeStringify: (value: unknown) => string;
  addOpencodeCacheHint: (message: string) => string;
};

const createPendingDirectoryDraftId = (now: number) =>
  `pending-directory-${
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${now}-${Math.random().toString(16).slice(2)}`
  }`;

const composerTargetWorkspaceLabel = (workspace: ComposerTargetWorkspace) =>
  workspace.displayName?.trim() ||
  workspace.vesloWorkspaceName?.trim() ||
  workspace.name?.trim() ||
  workspace.vesloHostUrl?.trim() ||
  workspace.baseUrl?.trim() ||
  workspace.path?.trim() ||
  workspace.directory?.trim() ||
  workspace.id;

export function createComposerTargetController(deps: ComposerTargetControllerDeps) {
  const [pendingDraftSummaries, setPendingDraftSummaries] = createSignal<PendingSessionDraftSummary[]>([]);

  const refreshPendingDraftSummaries = async () => {
    if (!deps.isTauriRuntime()) {
      setPendingDraftSummaries([]);
      return [];
    }

    try {
      const summaries = (await deps.pendingSessionDraftsList()).filter(
        (draft) => !deps.isConsumedPendingDraftId(draft.id),
      );
      setPendingDraftSummaries(summaries);
      return summaries;
    } catch (error) {
      deps.reportError(error, "pendingDrafts.targets.list");
      return pendingDraftSummaries();
    }
  };

  createEffect(() => {
    deps.activePendingDraftKey();
    void refreshPendingDraftSummaries();
  });

  const findComposerTargetOption = (targetId: string): ComposerTargetOption | null => {
    const id = targetId.trim();
    if (!id) return null;
    return composerTargetOptions().find((target) => target.id === id) ?? null;
  };

  const findPendingDraftSummaryForTarget = (target: ComposerTargetOption): PendingSessionDraftSummary | null => {
    for (const draft of pendingDraftSummaries()) {
      try {
        const draftKey = resolvePendingDraftKey({
          kind: draft.kind,
          workspaceId: draft.workspaceId,
          directory: draft.directory ?? null,
          privateWorkspaceId: draft.privateWorkspaceId ?? null,
        });
        if (draftKey === target.id) return draft;
      } catch {
        // Ignore malformed draft summaries.
      }
    }
    return null;
  };

  const loadPendingDraftComposer = async (summary: PendingSessionDraftSummary): Promise<ComposerDraft | null> => {
    if (!deps.isTauriRuntime()) return null;

    try {
      const loaded = await deps.pendingSessionDraftsGet(summary.id);
      if (!loaded) return null;

      const restoreError = deps.formatPendingDraftAttachmentRestoreError(loaded.attachmentFailures);
      if (restoreError) {
        deps.setError(restoreError);
      }

      return loaded.draft.composer;
    } catch (error) {
      deps.reportError(error, "pendingDrafts.switch.load");
      const message = error instanceof Error ? error.message : deps.safeStringify(error);
      deps.setError(deps.addOpencodeCacheHint(message));
      return null;
    }
  };

  const putPendingDraftForTarget = async (
    target: ComposerTargetOption,
    draft: ComposerDraft,
  ): Promise<PendingSessionDraftSummary | null> => {
    if (!deps.isTauriRuntime()) return null;

    const now = Date.now();
    const existingSummary = findPendingDraftSummaryForTarget(target);

    if (target.kind === "workspace") {
      const workspaceId = target.workspaceId?.trim() ?? "";
      const directory = normalizeDirectoryPath(target.directory ?? "");
      if (!workspaceId || !directory) return null;

      try {
        const summary = await deps.pendingSessionDraftsPut(existingSummary
          ? {
              id: existingSummary.id,
              kind: existingSummary.kind,
              workspaceId: existingSummary.workspaceId,
              directory: existingSummary.directory ?? null,
              privateWorkspaceId: existingSummary.privateWorkspaceId ?? null,
              createdAt: existingSummary.createdAt,
              updatedAt: now,
              composer: draft,
            }
          : {
              id: createPendingDirectoryDraftId(now),
              kind: "directory",
              workspaceId,
              directory,
              privateWorkspaceId: null,
              createdAt: now,
              updatedAt: now,
              composer: draft,
            });
        await refreshPendingDraftSummaries();
        return summary;
      } catch (error) {
        deps.reportError(error, "pendingDrafts.switch.putDirectory");
        const message = error instanceof Error ? error.message : deps.safeStringify(error);
        deps.setError(deps.addOpencodeCacheHint(message));
        return null;
      }
    }

    if (target.kind === "chat") {
      if (existingSummary) {
        const privateWorkspaceId = (existingSummary.privateWorkspaceId ?? existingSummary.workspaceId).trim();
        if (!privateWorkspaceId) return null;

        try {
          const summary = await deps.pendingSessionDraftsPut({
            id: existingSummary.id,
            kind: existingSummary.kind,
            workspaceId: existingSummary.workspaceId,
            directory: existingSummary.directory ?? null,
            privateWorkspaceId,
            createdAt: existingSummary.createdAt,
            updatedAt: now,
            composer: draft,
          });
          await refreshPendingDraftSummaries();
          return summary;
        } catch (error) {
          deps.reportError(error, "pendingDrafts.switch.putPrivate");
          const message = error instanceof Error ? error.message : deps.safeStringify(error);
          deps.setError(deps.addOpencodeCacheHint(message));
          return null;
        }
      }

      const scratch = await deps.workspace.createScratchWorkspace();
      if (!scratch?.id) return null;

      const cleanupFreshScratchWorkspace = async () => {
        try {
          const cleanupSucceeded = await deps.workspace.forgetWorkspace(scratch.id, { deleteLocalData: true });
          if (!cleanupSucceeded) {
            deps.reportError(
              new Error(`Failed to clean up failed scratch workspace ${scratch.id}.`),
              "pendingDrafts.switch.cleanupPrivate",
            );
          }
        } catch (error) {
          deps.reportError(error, "pendingDrafts.switch.cleanupPrivate");
        }
      };

      try {
        const activatedScratchWorkspace = await deps.workspace.activateWorkspace(scratch.id, {
          origin: "composer-target:create-private",
        });
        if (!activatedScratchWorkspace) {
          await cleanupFreshScratchWorkspace();
          return null;
        }

        const summary = await deps.pendingSessionDraftsPut({
          id: `pending-new-private-${scratch.id}`,
          kind: "new-private",
          workspaceId: scratch.id,
          directory: null,
          privateWorkspaceId: scratch.id,
          createdAt: now,
          updatedAt: now,
          composer: draft,
        });
        await refreshPendingDraftSummaries();
        return summary;
      } catch (error) {
        await cleanupFreshScratchWorkspace();
        deps.reportError(error, "pendingDrafts.switch.createPrivate");
        const message = error instanceof Error ? error.message : deps.safeStringify(error);
        deps.setError(deps.addOpencodeCacheHint(message));
        return null;
      }
    }

    return null;
  };

  const consumeMovedPendingDraft = async (input: {
    previousStorageKey: string | null;
    previousSummary: PendingSessionDraftSummary | null;
    nextStorageKey: string;
    nextSummary: PendingSessionDraftSummary;
  }) => {
    const previousStorageKey = input.previousStorageKey?.trim() ?? "";
    const nextStorageKey = input.nextStorageKey.trim();
    if (!previousStorageKey || !nextStorageKey || previousStorageKey === nextStorageKey) return;

    const previousDraftId = input.previousSummary?.id.trim() ?? "";
    const nextDraftId = input.nextSummary.id.trim();
    deps.setComposerDraftBySessionId((current) =>
      deleteSessionComposerDraft(current, { storageKey: previousStorageKey }),
    );

    if (!previousDraftId || previousDraftId === nextDraftId || !deps.isTauriRuntime()) return;

    try {
      const deleted = await deps.pendingSessionDraftsDelete(previousDraftId);
      if (!deleted) {
        deps.markPendingDraftConsumed(previousDraftId);
        console.warn("[pendingDrafts.switch.move] failed to delete moved pending draft", { previousDraftId });
      } else {
        deps.clearConsumedPendingDraftId(previousDraftId);
      }
    } catch (error) {
      deps.markPendingDraftConsumed(previousDraftId);
      deps.reportError(error, "pendingDrafts.switch.move");
    }

    try {
      await refreshPendingDraftSummaries();
    } catch (error) {
      deps.reportError(error, "pendingDrafts.switch.move.refresh");
    }
  };

  const activateTargetWorkspace = async (
    target: ComposerTargetOption,
    summary?: PendingSessionDraftSummary | null,
  ): Promise<boolean> => {
    if (target.kind === "workspace") {
      const workspaceId = target.workspaceId?.trim() ?? "";
      if (!workspaceId) return false;
      if (workspaceId === deps.workspace.activeWorkspaceId().trim()) return true;
      return Boolean(await deps.workspace.activateWorkspace(workspaceId, {
        origin: "composer-target:workspace",
        promoteToFront: true,
      }));
    }

    if (target.kind === "chat") {
      if (!summary) return true;
      const workspaceId = (summary.privateWorkspaceId ?? summary.workspaceId).trim();
      if (!workspaceId) return false;
      if (workspaceId === deps.workspace.activeWorkspaceId().trim()) return true;
      return Boolean(await deps.workspace.activateWorkspace(workspaceId, {
        origin: "composer-target:chat",
        promoteToFront: true,
      }));
    }

    return false;
  };

  const selectComposerWorkspaceTargetFromPicker = async (): Promise<ComposerTargetOption | "cancelled" | null> => {
    if (!deps.isTauriRuntime()) return null;

    const selectedDirectory = await deps.workspace.pickWorkspaceFolder();
    if (selectedDirectory == null || selectedDirectory.trim() === "") return "cancelled";

    const directory = normalizeDirectoryPath(selectedDirectory);
    if (!directory) return "cancelled";

    const workspace = await deps.workspace.ensureWorkspaceForFolder(selectedDirectory);
    const workspaceId = workspace?.id?.trim() ?? "";
    if (!workspaceId) return null;

    await deps.publishRegisteredWorkspaceToSidebar(workspaceId);

    const targetId = resolvePendingDraftKey({ kind: "directory", workspaceId, directory });
    const existingTarget = findComposerTargetOption(targetId);
    if (existingTarget) return existingTarget;

    const targetWorkspace = deps.workspace.workspaces().find((entry) => entry.id === workspaceId) ?? workspace;
    const target: ComposerTargetOption = {
      id: targetId,
      kind: "workspace",
      workspaceId,
      directory,
      label: targetWorkspace ? composerTargetWorkspaceLabel(targetWorkspace) : directory,
      description: directory,
      draftStatus: null,
    };
    return {
      ...target,
      draftStatus: findPendingDraftSummaryForTarget(target) ? "draft" : null,
    };
  };

  const switchComposerTargetNow = async (
    targetId: string,
    resolution?: ComposerTargetSwitchResolution,
  ): Promise<ComposerTargetSwitchResult> => {
    let target = findComposerTargetOption(targetId);
    if (!target) return { status: "blocked", message: deps.labels.targetUnavailable() };

    if (target.kind === "choose-workspace") {
      const pickedTarget = await selectComposerWorkspaceTargetFromPicker();
      if (pickedTarget === "cancelled") return { status: "cancelled" };
      if (!pickedTarget) return { status: "blocked", message: deps.labels.targetUnavailable() };
      target = pickedTarget;
    }

    if (target.id === deps.activePendingDraftKey()) return { status: "switched" };
    if (!deps.isTauriRuntime()) return { status: "blocked", message: deps.labels.targetUnavailable() };

    const currentDraft = deps.composerDraft();
    const destinationSummary = findPendingDraftSummaryForTarget(target);
    const destinationDraft = destinationSummary ? await loadPendingDraftComposer(destinationSummary) : null;
    if (destinationSummary && !destinationDraft) {
      return { status: "blocked", message: deps.labels.targetUnavailable() };
    }
    const decision = resolveComposerTargetConflict({ current: currentDraft, destination: destinationDraft });

    if (decision.kind === "conflict" && !resolution) {
      return {
        status: "conflict",
        conflict: {
          targetId: target.id,
          targetLabel: target.label,
          currentPreview: decision.currentPreview,
          destinationPreview: decision.destinationPreview,
        },
      };
    }

    const shouldUseCurrent = resolution === "use-current" || decision.kind === "use-current";
    const shouldLoadExisting = resolution === "load-existing" || decision.kind === "load-destination";

    if (shouldUseCurrent) {
      const previousPendingDraftKey = deps.currentComposerStorageKey();
      const previousPendingDraftMeta = deps.activePendingDraftMeta();
      const activated = await activateTargetWorkspace(target, destinationSummary);
      if (!activated) return { status: "blocked", message: deps.labels.targetUnavailable() };
      const summary = await putPendingDraftForTarget(target, currentDraft);
      if (!summary) return { status: "blocked", message: deps.labels.targetUnavailable() };
      deps.setComposerDraftBySessionId((current) =>
        setSessionComposerDraft(current, { storageKey: target.id }, currentDraft),
      );
      deps.setActivePendingDraftKey(target.id);
      deps.setActivePendingDraftMeta(summary);
      deps.setView("session");
      await consumeMovedPendingDraft({
        previousStorageKey: previousPendingDraftKey,
        previousSummary: previousPendingDraftMeta,
        nextStorageKey: target.id,
        nextSummary: summary,
      });
      return { status: "switched" };
    }

    if (shouldLoadExisting && destinationSummary && destinationDraft) {
      const activated = await activateTargetWorkspace(target, destinationSummary);
      if (!activated) return { status: "blocked", message: deps.labels.targetUnavailable() };
      deps.setComposerDraftBySessionId((current) =>
        setSessionComposerDraft(current, { storageKey: target.id }, destinationDraft),
      );
      deps.setActivePendingDraftKey(target.id);
      deps.setActivePendingDraftMeta(destinationSummary);
      deps.setView("session");
      return { status: "switched" };
    }

    const emptyDraft = deps.createEmptyComposerDraft();
    const activated = await activateTargetWorkspace(target, destinationSummary);
    if (!activated) return { status: "blocked", message: deps.labels.targetUnavailable() };
    const summary = await putPendingDraftForTarget(target, emptyDraft);
    if (!summary) return { status: "blocked", message: deps.labels.targetUnavailable() };
    deps.setComposerDraftBySessionId((current) =>
      setSessionComposerDraft(current, { storageKey: target.id }, emptyDraft),
    );
    deps.setActivePendingDraftKey(target.id);
    deps.setActivePendingDraftMeta(summary);
    deps.setView("session");
    return { status: "switched" };
  };

  let composerTargetSwitchQueue: Promise<void> = Promise.resolve();
  const switchComposerTarget = async (
    targetId: string,
    resolution?: ComposerTargetSwitchResolution,
  ): Promise<ComposerTargetSwitchResult> => {
    const queuedSwitch = composerTargetSwitchQueue
      .catch(() => undefined)
      .then(() => switchComposerTargetNow(targetId, resolution));
    composerTargetSwitchQueue = queuedSwitch.then(() => undefined, () => undefined);
    return await queuedSwitch;
  };

  const composerTargetOptions = createMemo<ComposerTargetOption[]>(() => {
    const summaries = pendingDraftSummaries();
    const hasDraft = (key: string) =>
      summaries.some((draft) => {
        try {
          return resolvePendingDraftKey({
            kind: draft.kind,
            workspaceId: draft.workspaceId,
            directory: draft.directory ?? null,
            privateWorkspaceId: draft.privateWorkspaceId ?? null,
          }) === key;
        } catch {
          return false;
        }
      });

    const chatId = resolvePendingDraftKey({ kind: "new-private" });
    const options: ComposerTargetOption[] = [{
      id: chatId,
      kind: "chat",
      label: deps.labels.chat(),
      description: "",
      draftStatus: hasDraft(chatId) ? "draft" : null,
    }];

    for (const workspace of deps.workspace.workspaces()) {
      const directory = normalizeDirectoryPath(workspace.directory?.trim() || workspace.path?.trim() || "");
      if (!workspace.id || !directory) continue;
      if (deps.workspace.isPrivateWorkspacePath(directory)) continue;
      const id = resolvePendingDraftKey({ kind: "directory", workspaceId: workspace.id, directory });
      options.push({
        id,
        kind: "workspace",
        workspaceId: workspace.id,
        directory,
        label: composerTargetWorkspaceLabel(workspace),
        description: directory,
        draftStatus: hasDraft(id) ? "draft" : null,
      });
    }

    options.push({
      id: "__choose-workspace__",
      kind: "choose-workspace",
      label: deps.labels.chooseWorkspace(),
      description: deps.labels.chooseWorkspaceDescription(),
    });

    return options;
  });

  const activeWorkspaceComposerTargetId = createMemo(() => {
    const chatId = resolvePendingDraftKey({ kind: "new-private" });
    const workspaceId = deps.workspace.activeWorkspaceId().trim();
    const active = deps.workspace.activeWorkspaceDisplay();
    const directory = normalizeDirectoryPath(
      active.directory?.trim() ||
      active.path?.trim() ||
      deps.workspace.activeWorkspaceRoot().trim() ||
      "",
    );

    if (!workspaceId || !directory || deps.workspace.isPrivateWorkspacePath(directory)) {
      return chatId;
    }

    return resolvePendingDraftKey({ kind: "directory", workspaceId, directory });
  });

  const activeComposerTargetId = createMemo(() =>
    deps.activePendingDraftKey() ?? activeWorkspaceComposerTargetId(),
  );

  return {
    composerTargetOptions,
    activeComposerTargetId,
    refreshPendingDraftSummaries,
    switchComposerTarget,
  };
}
