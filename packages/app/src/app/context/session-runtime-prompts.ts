import { createSignal } from "solid-js";

import { finishPerf, perfNow, recordPerfLog, runtimePerfAuditEnabled } from "../lib/perf-log";
import { unwrap } from "../lib/opencode";
import { truncateErrorField } from "../lib/session-error";
import type { PendingPermission, PendingQuestion } from "../types";
import { safeStringify } from "../utils";
import type { RoutingClient, WorkspaceRouting } from "./workspace-routing";

type RuntimePromptStoreState = {
  pendingPermissions: PendingPermission[];
  pendingQuestions: PendingQuestion[];
};

export type SessionRuntimePromptsDeps = {
  store: RuntimePromptStoreState;
  setStore: (...args: any[]) => void;
  routing: WorkspaceRouting;
  selectedSessionId: () => string | null;
  isWorkspaceRuntimeReady: (workspaceId?: string | null) => boolean;
  hasAnyRefreshableRuntime: () => boolean;
  activeSendTraceId?: () => string | null;
  sessionDebug: (label: string, payload?: unknown) => void;
  sessionWarn: (label: string, payload?: unknown) => void;
  setError: (message: string | null) => void;
  addError: (error: unknown, fallback?: string) => void;
};

export function shouldReleaseStaleWorkspaceRoute(wsId: string, activeWs: string, message: string) {
  if (!wsId || wsId === activeWs) return false;
  return /engine_not_running|Workspace client is stale|Failed to fetch|Request timed out|ECONN|upstream status (?:401|404|502|503)|status (?:401|404|502|503)|Invalid bearer token|unauthorized/i.test(
    message,
  );
}

function isWorkspaceFolderAccessPermission(permission: PendingPermission): boolean {
  if ((permission.permission ?? "").trim() !== "folder_access") return false;
  const metadata = permission.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const requestedPath = (metadata as { requestedPath?: unknown }).requestedPath;
  return typeof requestedPath === "string" && requestedPath.trim().length > 0;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return safeStringify(error);
}

function isRequestNotFoundError(error: unknown): boolean {
  return /(?:Permission|Question)NotFoundError|not found|status\s*404|HTTP\s*404/i.test(errorText(error));
}

async function replyPermissionWithV2Fallback(
  client: RoutingClient,
  permission: PendingPermission | undefined,
  requestID: string,
  reply: "once" | "always" | "reject",
) {
  try {
    unwrap(await client.permission.reply({ requestID, reply }));
    return;
  } catch (error) {
    const sessionID = permission?.sessionID;
    const permissionApi = (client as any).v2?.session?.permission;
    if (!sessionID || !isRequestNotFoundError(error) || typeof permissionApi?.reply !== "function") {
      throw error;
    }
    unwrap(await permissionApi.reply({ sessionID, requestID, reply }));
  }
}

async function replyQuestionWithV2Fallback(
  client: RoutingClient,
  question: PendingQuestion | undefined,
  requestID: string,
  answers: string[][],
) {
  try {
    unwrap(await client.question.reply({ requestID, answers }));
    return;
  } catch (error) {
    const sessionID = question?.sessionID;
    const questionApi = (client as any).v2?.session?.question;
    if (!sessionID || !isRequestNotFoundError(error) || typeof questionApi?.reply !== "function") {
      throw error;
    }
    unwrap(await questionApi.reply({ sessionID, requestID, questionV2Reply: { answers } }));
  }
}

async function rejectQuestionWithV2Fallback(
  client: RoutingClient,
  question: PendingQuestion | undefined,
  requestID: string,
) {
  try {
    unwrap(await client.question.reject({ requestID }));
    return;
  } catch (error) {
    const sessionID = question?.sessionID;
    const questionApi = (client as any).v2?.session?.question;
    if (!sessionID || !isRequestNotFoundError(error) || typeof questionApi?.reject !== "function") {
      throw error;
    }
    unwrap(await questionApi.reject({ sessionID, requestID }));
  }
}

export function createSessionRuntimePrompts(deps: SessionRuntimePromptsDeps) {
  const [permissionReplyBusy, setPermissionReplyBusy] = createSignal(false);
  const [questionReplyBusy, setQuestionReplyBusy] = createSignal(false);
  const [pendingPermissionsByWs, setPendingPermissionsByWs] = createSignal<
    Record<string, PendingPermission[]>
  >({});
  const [pendingQuestionsByWs, setPendingQuestionsByWs] = createSignal<Record<string, PendingQuestion[]>>({});

  let pendingPermissionsRefreshInFlight: Promise<void> | null = null;
  let pendingQuestionsRefreshInFlight: Promise<void> | null = null;

  const activeSendTraceId = () => deps.activeSendTraceId?.() ?? null;

  const pendingPermissions = () => deps.store.pendingPermissions;
  const pendingQuestions = () => deps.store.pendingQuestions;

  const allPendingPermissions = () => {
    const byWs = pendingPermissionsByWs();
    const result: PendingPermission[] = [];
    for (const list of Object.values(byWs)) result.push(...list);
    return result;
  };

  const pendingPermissionCountByWs = () => {
    const byWs = pendingPermissionsByWs();
    const counts: Record<string, number> = {};
    for (const [wsId, list] of Object.entries(byWs)) counts[wsId] = list.length;
    return counts;
  };

  const allPendingQuestions = () => {
    const byWs = pendingQuestionsByWs();
    const result: PendingQuestion[] = [];
    for (const list of Object.values(byWs)) result.push(...list);
    return result;
  };

  async function refreshPendingPermissions() {
    if (!deps.hasAnyRefreshableRuntime()) {
      recordPerfLog(runtimePerfAuditEnabled(), "session.permissions", "skip-engine-not-ready", {
        activeWorkspaceId: deps.routing.activeWorkspaceId() || null,
        activeSendTraceId: activeSendTraceId(),
      });
      deps.sessionDebug("permissions:skip-engine-not-ready", {
        activeWorkspaceId: deps.routing.activeWorkspaceId() || null,
      });
      return;
    }
    if (pendingPermissionsRefreshInFlight) {
      recordPerfLog(runtimePerfAuditEnabled(), "session.permissions", "skip-in-flight", {
        activeWorkspaceId: deps.routing.activeWorkspaceId() || null,
        activeSendTraceId: activeSendTraceId(),
      });
      deps.sessionDebug("permissions:skip-in-flight", {
        activeWorkspaceId: deps.routing.activeWorkspaceId() || null,
      });
      return;
    }

    const run = (async () => {
      const startedAt = perfNow();
      const activeWs = deps.routing.activeWorkspaceId();
      const nextByWs: Record<string, PendingPermission[]> = {};
      const now = Date.now();
      const prevByWs = pendingPermissionsByWs();
      const clientsToProbe: Array<{ wsId: string; client: RoutingClient }> = [];
      deps.routing.forEach((wsId, client) => {
        if (!deps.isWorkspaceRuntimeReady(wsId)) return;
        clientsToProbe.push({ wsId, client });
      });

      if (clientsToProbe.length === 0) {
        const c = deps.routing.active();
        if (!c) {
          finishPerf(runtimePerfAuditEnabled(), "session.permissions", "refresh", startedAt, {
            activeWorkspaceId: activeWs || null,
            activeSendTraceId: activeSendTraceId(),
            clientCount: 0,
            source: "none",
            permissionCount: 0,
            errorCount: 0,
          });
          return;
        }
        const list = unwrap(await c.permission.list()) as Array<PendingPermission>;
        const byId = new Map(deps.store.pendingPermissions.map((p) => [p.id, p] as const));
        const next = list.map((perm) => ({
          ...perm,
          workspaceId: activeWs || undefined,
          receivedAt: byId.get(perm.id)?.receivedAt ?? now,
        }));
        deps.setStore("pendingPermissions", next);
        if (activeWs) setPendingPermissionsByWs({ [activeWs]: next });
        finishPerf(runtimePerfAuditEnabled(), "session.permissions", "refresh", startedAt, {
          activeWorkspaceId: activeWs || null,
          activeSendTraceId: activeSendTraceId(),
          clientCount: 1,
          source: "active-fallback",
          permissionCount: next.length,
          errorCount: 0,
        });
        return;
      }

      let errorCount = 0;
      let releasedRouteCount = 0;
      await Promise.all(
        clientsToProbe.map(async ({ wsId, client }) => {
          try {
            const list = unwrap(await client.permission.list()) as Array<PendingPermission>;
            const prev = prevByWs[wsId] ?? [];
            const byId = new Map(prev.map((p) => [p.id, p] as const));
            nextByWs[wsId] = list.map((perm) => ({
              ...perm,
              workspaceId: wsId,
              receivedAt: byId.get(perm.id)?.receivedAt ?? now,
            }));
          } catch (error) {
            const message = error instanceof Error ? error.message : safeStringify(error);
            if (shouldReleaseStaleWorkspaceRoute(wsId, activeWs, message)) {
              releasedRouteCount += 1;
              deps.routing.release(wsId);
              deps.sessionWarn("permissions:released-stale-route", {
                workspaceId: wsId,
                error: truncateErrorField(message),
              });
              return;
            }
            errorCount += 1;
            nextByWs[wsId] = prevByWs[wsId] ?? [];
          }
        }),
      );
      setPendingPermissionsByWs(nextByWs);
      const activeList = activeWs ? nextByWs[activeWs] ?? [] : [];
      deps.setStore("pendingPermissions", activeList);
      finishPerf(runtimePerfAuditEnabled(), "session.permissions", "refresh", startedAt, {
        activeWorkspaceId: activeWs || null,
        activeSendTraceId: activeSendTraceId(),
        clientCount: clientsToProbe.length,
        source: "workspace-routing",
        permissionCount: Object.values(nextByWs).reduce((sum, list) => sum + list.length, 0),
        errorCount,
        releasedRouteCount,
      });
    })();

    pendingPermissionsRefreshInFlight = run;
    try {
      await run;
    } finally {
      if (pendingPermissionsRefreshInFlight === run) {
        pendingPermissionsRefreshInFlight = null;
      }
    }
  }

  async function refreshPendingQuestions() {
    if (pendingQuestionsRefreshInFlight) return pendingQuestionsRefreshInFlight;

    const run = (async () => {
      const activeWs = deps.routing.activeWorkspaceId();
      const clientsToProbe: Array<{ wsId: string; client: RoutingClient }> = [];
      deps.routing.forEach((wsId, client) => {
        if (!deps.isWorkspaceRuntimeReady(wsId)) return;
        clientsToProbe.push({ wsId, client });
      });
      const now = Date.now();
      const prevByWs = pendingQuestionsByWs();

      if (clientsToProbe.length === 0) {
        const c = deps.routing.active();
        if (!c) return;
        const list = unwrap(await c.question.list()) as Array<PendingQuestion>;
        const byId = new Map(deps.store.pendingQuestions.map((q) => [q.id, q] as const));
        const next = list.map((q) => ({
          ...q,
          workspaceId: activeWs || undefined,
          receivedAt: byId.get(q.id)?.receivedAt ?? now,
        }));
        deps.setStore("pendingQuestions", next);
        if (activeWs) setPendingQuestionsByWs({ [activeWs]: next });
        return;
      }

      const nextByWs: Record<string, PendingQuestion[]> = {};
      await Promise.all(
        clientsToProbe.map(async ({ wsId, client }) => {
          try {
            const list = unwrap(await client.question.list()) as Array<PendingQuestion>;
            const prev = prevByWs[wsId] ?? [];
            const byId = new Map(prev.map((q) => [q.id, q] as const));
            nextByWs[wsId] = list.map((q) => ({
              ...q,
              workspaceId: wsId,
              receivedAt: byId.get(q.id)?.receivedAt ?? now,
            }));
          } catch (error) {
            const message = error instanceof Error ? error.message : safeStringify(error);
            if (shouldReleaseStaleWorkspaceRoute(wsId, activeWs, message)) {
              deps.routing.release(wsId);
              deps.sessionWarn("questions:released-stale-route", {
                workspaceId: wsId,
                error: truncateErrorField(message),
              });
              return;
            }
            nextByWs[wsId] = prevByWs[wsId] ?? [];
          }
        }),
      );
      setPendingQuestionsByWs(nextByWs);
      const activeList = activeWs ? nextByWs[activeWs] ?? [] : [];
      deps.setStore("pendingQuestions", activeList);
    })();

    pendingQuestionsRefreshInFlight = run;
    try {
      await run;
    } finally {
      if (pendingQuestionsRefreshInFlight === run) {
        pendingQuestionsRefreshInFlight = null;
      }
    }
  }

  async function respondPermission(requestID: string, reply: "once" | "always" | "reject") {
    const perm =
      allPendingPermissions().find((p) => p.id === requestID) ??
      deps.store.pendingPermissions.find((p) => p.id === requestID);
    const c = perm?.workspaceId ? deps.routing.client(perm.workspaceId) : deps.routing.active();
    if (!c || permissionReplyBusy()) return;

    setPermissionReplyBusy(true);
    deps.setError(null);

    try {
      await replyPermissionWithV2Fallback(c, perm, requestID, reply);
      await refreshPendingPermissions();
    } catch (e) {
      deps.addError(e);
    } finally {
      setPermissionReplyBusy(false);
    }
  }

  async function respondQuestion(requestID: string, answers: string[][]) {
    const question =
      allPendingQuestions().find((q) => q.id === requestID) ??
      deps.store.pendingQuestions.find((q) => q.id === requestID);
    const c = question?.workspaceId ? deps.routing.client(question.workspaceId) : deps.routing.active();
    if (!c || questionReplyBusy()) return;

    setQuestionReplyBusy(true);
    deps.setError(null);

    try {
      await replyQuestionWithV2Fallback(c, question, requestID, answers);
      await refreshPendingQuestions();
    } catch (e) {
      deps.addError(e);
    } finally {
      setQuestionReplyBusy(false);
    }
  }

  async function rejectQuestion(requestID: string) {
    const question =
      allPendingQuestions().find((q) => q.id === requestID) ??
      deps.store.pendingQuestions.find((q) => q.id === requestID);
    const c = question?.workspaceId ? deps.routing.client(question.workspaceId) : deps.routing.active();
    if (!c || questionReplyBusy()) return;

    setQuestionReplyBusy(true);
    deps.setError(null);

    try {
      await rejectQuestionWithV2Fallback(c, question, requestID);
      await refreshPendingQuestions();
    } catch (e) {
      deps.addError(e);
    } finally {
      setQuestionReplyBusy(false);
    }
  }

  const activePermission = () => {
    const id = deps.selectedSessionId();
    if (id) {
      const scoped = deps.store.pendingPermissions.find((perm) => perm.sessionID === id) ?? null;
      if (scoped) return scoped;
      const scopedFromAnyWorkspace = allPendingPermissions().find((perm) => perm.sessionID === id) ?? null;
      if (scopedFromAnyWorkspace) return scopedFromAnyWorkspace;
    } else {
      const activeWsId = deps.routing.activeWorkspaceId();
      const seen = new Set<string>();
      const candidates = [...allPendingPermissions(), ...deps.store.pendingPermissions].filter((perm) => {
        if (seen.has(perm.id)) return false;
        seen.add(perm.id);
        return true;
      });
      return candidates.find((perm) =>
        perm.workspaceId === activeWsId && isWorkspaceFolderAccessPermission(perm)
      ) ?? null;
    }

    const all = allPendingPermissions();
    if (all.length > 0) {
      const activeWsId = deps.routing.activeWorkspaceId();
      const fromActive = all.find((p) => p.workspaceId === activeWsId);
      return fromActive ?? all[0];
    }
    return deps.store.pendingPermissions[0] ?? null;
  };

  const activeQuestion = () => {
    const id = deps.selectedSessionId();
    if (id) {
      const scoped = deps.store.pendingQuestions.find((q) => q.sessionID === id) ?? null;
      if (scoped) return scoped;
      const scopedFromAnyWorkspace = allPendingQuestions().find((q) => q.sessionID === id) ?? null;
      if (scopedFromAnyWorkspace) return scopedFromAnyWorkspace;
    } else {
      return null;
    }
    const all = allPendingQuestions();
    if (all.length > 0) {
      const activeWsId = deps.routing.activeWorkspaceId();
      const fromActive = all.find((q) => q.workspaceId === activeWsId);
      return fromActive ?? all[0];
    }
    return deps.store.pendingQuestions[0] ?? null;
  };

  const setPendingPermissions = (next: PendingPermission[]) => {
    deps.setStore("pendingPermissions", next);
  };

  const setPendingQuestions = (next: PendingQuestion[]) => {
    deps.setStore("pendingQuestions", next);
  };

  return {
    pendingPermissions,
    pendingQuestions,
    pendingPermissionsByWs,
    pendingQuestionsByWs,
    allPendingPermissions,
    allPendingQuestions,
    pendingPermissionCountByWs,
    permissionReplyBusy,
    questionReplyBusy,
    activePermission,
    activeQuestion,
    refreshPendingPermissions,
    refreshPendingQuestions,
    respondPermission,
    respondQuestion,
    rejectQuestion,
    setPendingPermissions,
    setPendingQuestions,
  };
}
