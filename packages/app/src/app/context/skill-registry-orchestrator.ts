import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";

import type { DenAuthState } from "../lib/den-auth";
import {
  createSkillRegistryEventsListener,
  SkillRegistryEventsAuthError,
  type SkillRegistryEvent,
  type SkillRegistryEventsListener,
  type SkillRegistryEventsListenerOptions,
} from "../lib/skill-registry-events";
import { VesloServerError } from "../lib/veslo-server";
import type {
  VesloServerClient,
  VesloServerStatus,
  VesloSkillRegistryAuthContext,
} from "../lib/veslo-server";
import { buildDenContextHeaders } from "../lib/veslo-server/transport";
import type { ReloadReason, ReloadTrigger } from "../types";
import type { WorkspaceBusyMap } from "./workspace-debug";

export type PendingSkillRegistryReplay = {
  eventId: string;
};

type SkillRegistryMaterializationResult = {
  synced?: boolean;
  reloadRequired?: boolean;
};

export type SkillRegistryOrchestratorListenerFactory = (
  options: SkillRegistryEventsListenerOptions,
) => SkillRegistryEventsListener;

export type SkillRegistryOrchestratorDeps = {
  vesloServerClient: Accessor<VesloServerClient | null>;
  vesloServerStatus: Accessor<VesloServerStatus>;
  activeWorkspaceId: Accessor<string>;
  workspaceBusy: Accessor<WorkspaceBusyMap>;
  denAuthRevision: Accessor<unknown>;
  readDenAuth: () => DenAuthState | null;
  refreshSkills: (options?: { force?: boolean }) => Promise<void>;
  invalidateSkillRegistryInventory: () => Promise<void>;
  markReloadRequired: (reason: ReloadReason, trigger?: ReloadTrigger) => void;
  reportError: (error: unknown, scope: string) => void;
  ensureLocalVesloServerRunning?: (options?: { requireRuntimeChainReady?: boolean }) => Promise<boolean>;
  createListener?: SkillRegistryOrchestratorListenerFactory;
};

function createTokenFingerprint(token: string): string {
  if (!token) return "none";
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${token.length}:${hash.toString(16).padStart(8, "0")}`;
}

export function createSkillRegistryEventsKey(input: {
  baseUrl: string;
  orgId: string;
  token: string;
  denApiBase?: string;
  denToken?: string;
  denUserId?: string;
  workspaceId: string;
  status: VesloServerStatus;
}): string {
  return JSON.stringify({
    baseUrl: input.baseUrl,
    orgId: input.orgId,
    token: createTokenFingerprint(input.token),
    denApiBase: input.denApiBase ?? "",
    denToken: createTokenFingerprint(input.denToken ?? ""),
    denUserId: input.denUserId ?? "",
    workspaceId: input.workspaceId,
    status: input.status,
  });
}

export function createSkillRegistryOrchestrator(deps: SkillRegistryOrchestratorDeps) {
  const createListener: SkillRegistryOrchestratorListenerFactory =
    deps.createListener ?? ((options) => createSkillRegistryEventsListener(options));

  const [pendingSkillRegistryWorkspaceReplays, setPendingSkillRegistryWorkspaceReplays] = createSignal<
    Record<string, PendingSkillRegistryReplay>
  >({});
  const [pendingGlobalSkillRegistryReplay, setPendingGlobalSkillRegistryReplay] =
    createSignal<PendingSkillRegistryReplay | null>(null);
  const skillRegistryWorkspaceReplayInFlight = new Set<string>();
  let skillRegistryGlobalReplayInFlight = false;
  let skillRegistryEventsKey = "";
  let skillRegistryEventsListener: SkillRegistryEventsListener | null = null;
  let skillRegistryEventsUnauthorizedRetryKey = "";

  const materializationAuthContext = (): VesloSkillRegistryAuthContext => {
    deps.denAuthRevision();
    const auth = deps.readDenAuth();
    return {
      denApiBase: auth?.denApiBase?.trim() || undefined,
      denToken: auth?.token?.trim() || undefined,
      denOrgId: auth?.orgId?.trim() || undefined,
      denUserId: auth?.user?.id?.trim() || undefined,
    };
  };

  const retryWithRefreshedLocalHostToken = async <T>(
    client: VesloServerClient,
    request: (candidate: VesloServerClient) => Promise<T>,
  ): Promise<T> => {
    try {
      return await request(client);
    } catch (error) {
      if (!isInvalidHostTokenError(error) || !deps.ensureLocalVesloServerRunning) {
        throw error;
      }

      const refreshed = await deps.ensureLocalVesloServerRunning({
        requireRuntimeChainReady: false,
      });
      const refreshedClient = deps.vesloServerClient();
      if (!refreshed || !refreshedClient) throw error;
      return request(refreshedClient);
    }
  };

  const refreshAfterSkillRegistryMaterialization = async (result: SkillRegistryMaterializationResult) => {
    if (!shouldRefreshAfterSkillRegistryMaterialization(result)) return;
    await deps.refreshSkills({ force: true });
    await deps.invalidateSkillRegistryInventory();
  };

  const queuePendingSkillRegistryWorkspaceReplay = (workspaceId: string, eventId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    setPendingSkillRegistryWorkspaceReplays((current) => ({
      ...current,
      [id]: { eventId },
    }));
  };

  const clearPendingSkillRegistryWorkspaceReplay = (workspaceId: string, eventId: string) => {
    setPendingSkillRegistryWorkspaceReplays((current) => {
      if (current[workspaceId]?.eventId !== eventId) return current;
      const next = { ...current };
      delete next[workspaceId];
      return next;
    });
  };

  const replayPendingSkillRegistryWorkspaceUpdate = (
    client: VesloServerClient,
    workspaceId: string,
    pending: PendingSkillRegistryReplay,
  ) => {
    if (skillRegistryWorkspaceReplayInFlight.has(workspaceId)) return;
    skillRegistryWorkspaceReplayInFlight.add(workspaceId);
    void (async () => {
      try {
        const result = await retryWithRefreshedLocalHostToken(
          client,
          (candidate) => candidate.syncWorkspaceSkillMaterialization(
            workspaceId,
            materializationAuthContext(),
          ),
        );
        await refreshAfterSkillRegistryMaterialization(result);
        clearPendingSkillRegistryWorkspaceReplay(workspaceId, pending.eventId);
      } catch (error) {
        deps.reportError(error, "skills.registry.workspace.replay");
      } finally {
        skillRegistryWorkspaceReplayInFlight.delete(workspaceId);
      }
    })();
  };

  const replayPendingGlobalSkillRegistryUpdate = (client: VesloServerClient, pending: PendingSkillRegistryReplay) => {
    if (skillRegistryGlobalReplayInFlight) return;
    skillRegistryGlobalReplayInFlight = true;
    void (async () => {
      try {
        const result = await retryWithRefreshedLocalHostToken(
          client,
          (candidate) => candidate.syncGlobalSkillMaterialization(materializationAuthContext()),
        );
        await refreshAfterSkillRegistryMaterialization(result);
        setPendingGlobalSkillRegistryReplay((current) =>
          current?.eventId === pending.eventId ? null : current,
        );
      } catch (error) {
        deps.reportError(error, "skills.registry.global.replay");
      } finally {
        skillRegistryGlobalReplayInFlight = false;
      }
    })();
  };

  const syncPendingSkillRegistryReplays = () => {
    const client = deps.vesloServerClient();
    const status = deps.vesloServerStatus();
    const busyWorkspaces = deps.workspaceBusy();
    const workspaceReplays = pendingSkillRegistryWorkspaceReplays();
    const globalReplay = pendingGlobalSkillRegistryReplay();
    materializationAuthContext();
    if (!client || status !== "connected") return;

    for (const [workspaceId, pending] of Object.entries(workspaceReplays)) {
      if (hasWorkspaceBusySessions(busyWorkspaces, workspaceId)) continue;
      replayPendingSkillRegistryWorkspaceUpdate(client, workspaceId, pending);
    }

    const hasActiveRun = hasAnyWorkspaceBusySessions(deps.workspaceBusy());
    if (globalReplay && !hasActiveRun) {
      replayPendingGlobalSkillRegistryUpdate(client, globalReplay);
    }
  };

  const stopSkillRegistryEventsListener = () => {
    skillRegistryEventsListener?.stop();
    skillRegistryEventsListener = null;
  };

  const handleSkillRegistryEventsUnauthorized = async (error: SkillRegistryEventsAuthError) => {
    const failedKey = skillRegistryEventsKey;
    stopSkillRegistryEventsListener();
    deps.reportError(error, "skills.registry.events.auth");
    try {
      await deps.ensureLocalVesloServerRunning?.({ requireRuntimeChainReady: false });
      if (failedKey && skillRegistryEventsKey !== failedKey) {
        skillRegistryEventsUnauthorizedRetryKey = "";
        return;
      }
      if (failedKey && skillRegistryEventsUnauthorizedRetryKey !== failedKey) {
        skillRegistryEventsUnauthorizedRetryKey = failedKey;
        skillRegistryEventsKey = "";
      }
      syncSkillRegistryEventListener();
    } catch (reacquireError) {
      deps.reportError(reacquireError, "skills.registry.events.auth.reacquire");
    }
  };

  const syncSkillRegistryEventListener = () => {
    deps.denAuthRevision();
    const client = deps.vesloServerClient();
    const authContext = materializationAuthContext();
    const orgId = authContext.denOrgId?.trim() ?? "";
    const baseUrl = client?.baseUrl?.trim() ?? "";
    const workspaceId = deps.activeWorkspaceId().trim();
    const token = client?.token?.trim() ?? "";
    const status = deps.vesloServerStatus();
    const nextKey = createSkillRegistryEventsKey({
      baseUrl,
      orgId,
      token,
      denApiBase: authContext.denApiBase?.trim() ?? "",
      denToken: authContext.denToken?.trim() ?? "",
      denUserId: authContext.denUserId?.trim() ?? "",
      workspaceId,
      status,
    });
    if (nextKey === skillRegistryEventsKey) return;
    skillRegistryEventsKey = nextKey;
    if (nextKey !== skillRegistryEventsUnauthorizedRetryKey) {
      skillRegistryEventsUnauthorizedRetryKey = "";
    }
    stopSkillRegistryEventsListener();

    if (!client || status !== "connected") return;

    const listener = createListener({
      registryBaseUrl: client.baseUrl,
      token: client.token,
      extraHeaders: buildDenContextHeaders(authContext),
      orgId,
      workspaceId: workspaceId || undefined,
      getActiveWorkspaceId: () => deps.activeWorkspaceId(),
      onInventoryInvalidated: () =>
        deps.invalidateSkillRegistryInventory().catch(e => deps.reportError(e, "skills.registry.invalidate")),
      onWorkspaceUpdatePending: async (update) => {
        const trigger = skillRegistryReloadTriggerForEvent(update.event);
        if (hasWorkspaceBusySessions(deps.workspaceBusy(), update.workspaceId)) {
          await retryWithRefreshedLocalHostToken(
            client,
            (candidate) => candidate.syncWorkspaceSkillMaterialization(update.workspaceId, {
              ...materializationAuthContext(),
              activeRun: true,
            }),
          );
          deps.markReloadRequired("skills", trigger);
          queuePendingSkillRegistryWorkspaceReplay(update.workspaceId, update.event.id);
          return;
        }
        const result = await retryWithRefreshedLocalHostToken(
          client,
          (candidate) => candidate.syncWorkspaceSkillMaterialization(
            update.workspaceId,
            materializationAuthContext(),
          ),
        );
        await refreshAfterSkillRegistryMaterialization(result);
      },
      onIdleWorkspaceUpdate: async (update) => {
        const result = await retryWithRefreshedLocalHostToken(
          client,
          (candidate) => candidate.syncWorkspaceSkillMaterialization(
            update.workspaceId,
            materializationAuthContext(),
          ),
        );
        await refreshAfterSkillRegistryMaterialization(result);
      },
      onGlobalUpdate: async (update) => {
        const hasActiveRun = hasAnyWorkspaceBusySessions(deps.workspaceBusy());
        if (hasActiveRun) {
          await retryWithRefreshedLocalHostToken(
            client,
            (candidate) => candidate.syncGlobalSkillMaterialization({
              ...materializationAuthContext(),
              activeRun: true,
            }),
          );
          deps.markReloadRequired("skills", skillRegistryReloadTriggerForEvent(update.event));
          setPendingGlobalSkillRegistryReplay({ eventId: update.event.id });
          return;
        }
        const result = await retryWithRefreshedLocalHostToken(
          client,
          (candidate) => candidate.syncGlobalSkillMaterialization(materializationAuthContext()),
        );
        await refreshAfterSkillRegistryMaterialization(result);
      },
      onUnauthorized: handleSkillRegistryEventsUnauthorized,
      onError: (error) => deps.reportError(error, "skills.registry.events"),
    });

    skillRegistryEventsListener = listener;
    listener.start();
  };

  syncSkillRegistryEventListener();

  createEffect(() => {
    syncPendingSkillRegistryReplays();
  });

  createEffect(() => {
    syncSkillRegistryEventListener();
  });

  onCleanup(stopSkillRegistryEventsListener);

  return {
    materializationAuthContext,
    pendingSkillRegistryWorkspaceReplays,
    pendingGlobalSkillRegistryReplay,
    syncPendingSkillRegistryReplays,
  };
}

function skillRegistryReloadTriggerForEvent(event: Pick<SkillRegistryEvent, "skillId" | "installationId">): ReloadTrigger {
  return {
    type: "skill",
    action: "updated",
    name: event.skillId ?? event.installationId ?? undefined,
  };
}

function shouldRefreshAfterSkillRegistryMaterialization(result: SkillRegistryMaterializationResult) {
  return result.synced === true || result.reloadRequired === true;
}

function hasWorkspaceBusySessions(
  busyByWorkspace: WorkspaceBusyMap,
  workspaceId: string | null | undefined,
) {
  return Object.keys(busyByWorkspace[workspaceId?.trim() ?? ""] ?? {}).length > 0;
}

function hasAnyWorkspaceBusySessions(busyByWorkspace: WorkspaceBusyMap) {
  return Object.values(busyByWorkspace).some((sessions) => Object.keys(sessions).length > 0);
}

function isInvalidHostTokenError(error: unknown) {
  return error instanceof VesloServerError &&
    error.status === 401 &&
    /invalid host token/i.test(error.message);
}
