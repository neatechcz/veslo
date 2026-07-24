import { batch, createEffect, onCleanup, type Setter } from "solid-js";
import { produce, type SetStoreFunction } from "solid-js/store";

import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client";

import { engineSseSubscribe, isEngineSseAvailable } from "../lib/engine-sse";
import { chromeMcpToolTraceDiagnostics } from "../lib/chrome-mcp-error";
import { unwrap, type OpencodeAuth } from "../lib/opencode";
import { perfNow, recordPerfLog } from "../lib/perf-log";
import { recordSendWorkflowTrace } from "../lib/send-workflow-trace";
import { formatSessionError, isLocalVesloServerInvalidBearerError, truncateErrorField } from "../lib/session-error";
import type {
  MessageInfo,
  OpencodeEvent,
  PendingPermission,
  PendingQuestion,
  SessionErrorTurn,
  TodoItem,
} from "../types";
import {
  addOpencodeCacheHint,
  extractSessionId,
  normalizeDirectoryPath,
  normalizeEvent,
  normalizeSessionStatus,
  normalizeTodoItems,
  sessionDirectoryMatchesRoot,
} from "../utils";
import {
  createPlaceholderMessage,
  removeMessageInfo,
  removePartInfo,
  removeSession,
  upsertMessageInfo,
  upsertPartInfo,
  upsertSession,
} from "./session-store-model";
import {
  beginOutageEpisode,
  clearOutageEpisode,
  createReconnectState,
  type ReconnectState,
  type ReconnectNotice,
  shouldRecoverEventStreamRuntime,
  shouldShowReconnected,
  shouldShowReconnecting,
} from "./session-reconnect";
import { shouldRecoverLocalRuntimeFromHealthError } from "./send-runtime-readiness";
import { shouldReleaseStaleWorkspaceRoute } from "./session-runtime-prompts";
import { INITIAL_SESSION_MESSAGE_LIMIT } from "./session-transcript-controller";
import { recordTranscriptStoreWrite } from "./session-transcript-write-diagnostics";
import type { ClientEntry, RoutingClient, WorkspaceRouting } from "./workspace-routing";

type EventStreamStoreState = {
  sessions: Session[];
  sessionStatus: Record<string, string>;
  sessionErrorTurns: Record<string, SessionErrorTurn[]>;
  messages: Record<string, MessageInfo[]>;
  parts: Record<string, Part[]>;
  commandDisplayByMessageID: Record<string, string>;
  todos: Record<string, TodoItem[]>;
  pendingPermissions: PendingPermission[];
  pendingQuestions: PendingQuestion[];
  events: Array<{ type: string; properties?: unknown }>;
};

type SseSubscription = {
  subscriptionId?: string;
  replacedExisting?: boolean;
  activeSubscriptionCount?: number;
  activeConnectionCount?: number;
  stream: AsyncIterable<unknown>;
  close?: () => Promise<void> | void;
  [Symbol.asyncDispose]?: () => Promise<void> | void;
};

export type ReconciledSseStream = {
  workspaceId: string;
  client: RoutingClient;
  baseUrl: string;
  directory: string;
  cleanup: () => void;
};

export type SseTargetDescriptor = {
  wsId: string;
  key: string;
  client: RoutingClient;
  baseUrl: string;
  directory: string;
};

const sameRouteDescriptor = (
  current: ReconciledSseStream,
  next: Pick<SseTargetDescriptor, "client" | "baseUrl" | "directory">,
) =>
  current.client === next.client &&
  current.baseUrl === next.baseUrl &&
  current.directory === next.directory;

const PERMISSION_REFRESH_EVENT_TYPES = new Set([
  "permission.asked",
  "permission.replied",
  "permission.v2.asked",
  "permission.v2.replied",
]);

const QUESTION_REFRESH_EVENT_TYPES = new Set([
  "question.asked",
  "question.replied",
  "question.rejected",
  "question.v2.asked",
  "question.v2.replied",
  "question.v2.rejected",
]);

export function isPermissionRefreshEvent(type: string): boolean {
  return PERMISSION_REFRESH_EVENT_TYPES.has(type);
}

export function isQuestionRefreshEvent(type: string): boolean {
  return QUESTION_REFRESH_EVENT_TYPES.has(type);
}

/** Applies the SSE `id:` state machine, including the protocol's empty-id reset. */
export function nextUpstreamEventCursor(
  current: string | null,
  event: Pick<OpencodeEvent, "eventId" | "eventIdReset">,
) {
  if (event.eventIdReset) return null;
  const next = event.eventId?.trim();
  return next ? next : current;
}

function cleanupReconciledSseStream(
  streams: Map<string, ReconciledSseStream>,
  key: string,
  stream: ReconciledSseStream,
) {
  stream.cleanup();
  if (streams.get(key) === stream) {
    streams.delete(key);
  }
}

export function reconcileSseStreamTargets(
  streams: Map<string, ReconciledSseStream>,
  targets: SseTargetDescriptor[],
  setupStream: (target: SseTargetDescriptor) => () => void,
): boolean {
  let changed = false;
  const seen = new Set<string>();

  for (const target of targets) {
    seen.add(target.key);
    const current = streams.get(target.key);
    if (current && sameRouteDescriptor(current, target)) continue;
    if (current) {
      cleanupReconciledSseStream(streams, target.key, current);
    }
    const cleanup = setupStream(target);
    streams.set(target.key, {
      workspaceId: target.wsId,
      client: target.client,
      baseUrl: target.baseUrl,
      directory: target.directory,
      cleanup,
    });
    changed = true;
  }

  for (const [key, stream] of Array.from(streams.entries())) {
    if (seen.has(key)) continue;
    cleanupReconciledSseStream(streams, key, stream);
    changed = true;
  }

  return changed;
}

export type SessionEventStreamControllerDeps = {
  store: EventStreamStoreState;
  setStore: SetStoreFunction<EventStreamStoreState>;
  routing: WorkspaceRouting;
  client: () => RoutingClient | null;
  activeWorkspaceRoot: () => string;
  selectedSessionId: () => string | null;
  developerMode: () => boolean;
  setError: (message: string | null) => void;
  setSseConnected: (connected: boolean) => void;
  onHotReloadApplied?: () => void;
  onReconnectNotice?: (notice: ReconnectNotice) => void;
  onReconnectState?: (state: ReconnectState) => void;
  onAssistantResponseObserved?: (sessionId: string) => void;
  onTranscriptObserved?: (sessionId: string) => void;
  onSessionLifecycleObservation?: (
    sessionId: string,
    workspaceId: string | null | undefined,
    type: "session.idle" | "session.error",
  ) => boolean;
  deferAssistantTextPartMutation?: (input: {
    sessionId: string;
    workspaceId: string;
    commit: () => void;
  }) => boolean;
  sessionDebugEnabled: () => boolean;
  sessionWarn: (label: string, payload?: unknown) => void;
  recordSessionStatusTrace: (event: string, payload?: Record<string, unknown>) => void;
  readStatusForSession: (sessionID: string | null | undefined, workspaceId?: string | null) => string;
  setSessionStatusForWorkspace: (
    sessionID: string | null | undefined,
    status: string,
    workspaceId?: string | null,
  ) => void;
  notifySessionBusy: (sessionId: string, status: string, workspaceId?: string) => void;
  workspaceSessionIds: Set<string>;
  applySessionDirectoryOverride: <T extends Session>(session: T) => T;
  resolveSessionDirectory: (session: Pick<Session, "id" | "directory">) => string;
  appendSessionErrorTurn: (sessionID: string, text: string, options?: { workspaceId?: string | null }) => void;
  setCommandDisplay: (messageID: string, name: string, args: string) => void;
  recordSyntheticContinueDiagnostic: (part: Part) => void;
  maybeMarkReloadRequired: (part: Part) => void;
  maybeHandleInvalidToolError: (part: Part, workspaceId?: string | null) => void;
  maybeHandleChromeMcpCompletedError: (part: Part, workspaceId?: string | null) => void;
  resolveTranscriptIngestWorkspaceId: (sourceWsId?: string | null) => string;
  resolveSessionIdForMessage: (messageID: string) => string | null;
  recordPendingTranscriptMessageDeletion: (
    workspaceId: string,
    sessionID: string,
    messageID: string,
  ) => void;
  recordPendingTranscriptPartDeletion: (
    workspaceId: string,
    sessionID: string,
    messageID: string,
    partID: string,
  ) => void;
  messageLimitBySession: () => Record<string, number>;
  setMessagesForSession: (sessionID: string, list: Array<{ info: MessageInfo; parts: Part[] }>) => void;
  setMessageLimitBySession: Setter<Record<string, number>>;
  setMessageCompleteBySession: Setter<Record<string, boolean>>;
  refreshPendingPermissions: () => Promise<void>;
  refreshPendingQuestions: () => Promise<void>;
  withTimeout: <T>(promise: Promise<T>, ms: number, label: string) => Promise<T>;
  isWorkspaceRuntimeReady: (workspaceId?: string | null) => boolean;
  isActiveWorkspaceRuntimeReady: () => boolean;
  /**
   * The shared unsandboxed fallback has one process-level skill view.  It must
   * therefore own only the active workspace's event stream; keeping an old
   * workspace stream alive makes its reconnect path switch the shared engine
   * back to that old workspace.
   */
  isSharedEngineSingleViewFallback?: () => boolean;
  recoverWorkspaceRuntimeForEventStream?: (workspaceId: string) => Promise<boolean> | boolean;
};

function engineSseAuthOptions(auth?: OpencodeAuth | null) {
  if (!auth) return {};
  if (auth.mode === "veslo") {
    return { bearerToken: auth.token ?? null };
  }
  return {
    username: auth.username ?? null,
    password: auth.password ?? null,
  };
}

export function createSessionEventStreamController(deps: SessionEventStreamControllerDeps) {
  let lastPartDebugEventAt = 0;
  let suppressedPartDebugEvents = 0;
  const sseConnectedByStream = new Map<string, boolean>();
  // An OpenCode session belongs to exactly one workspace route for the life of
  // this controller.  IDs are process-global in a shared engine, so the
  // historical global Set alone is not enough to keep an event from stream B
  // from mutating session state previously established by stream A.
  const sessionWorkspaceBindings = new Map<string, string>();
  const activeSseStreamsByWorkspace = new Map<
    string,
    { generation: number; cleanup: () => void; startedAt: number }
  >();
  const sseStreamReplacementCountsByWorkspace = new Map<string, number>();
  let nextSseStreamGeneration = 0;
  const chromeMcpTraceSignatureByPart = new Map<string, string>();
  const chromeMcpFirstObservedAtByPart = new Map<string, number>();
  // Opaque SSE ids are only useful when kept across a reconnect. The key is
  // deliberately scoped so a reused upstream id cannot suppress another
  // workspace, session, or part.
  const seenTextDeltaEventIdsByPart = new Map<string, Set<string>>();
  let activeWriterBatch:
    | { textDeltaAccepted: number; textDeltaDuplicate: number; textDeltaUnidentified: number }
    | null = null;

  const sseConnectionKey = (sourceWsId: string) => sourceWsId.trim() || "__active__";
  const sseBridgeConnectionKey = (sourceWsId: string) => `session-workspace:${sseConnectionKey(sourceWsId)}`;
  const textDeltaScopeKey = (sourceWsId: string, sessionID: string, partID: string) =>
    `${sseConnectionKey(sourceWsId)}\u0000${sessionID}\u0000${partID}`;
  const forgetTextDeltaPart = (sourceWsId: string, sessionID: string, partID: string) => {
    seenTextDeltaEventIdsByPart.delete(textDeltaScopeKey(sourceWsId, sessionID, partID));
  };
  const forgetTextDeltaMessage = (sourceWsId: string, sessionID: string, messageID: string) => {
    for (const part of deps.store.parts[messageID] ?? []) {
      forgetTextDeltaPart(sourceWsId, sessionID, part.id);
    }
  };
  const inspectTextDelta = (
    sourceWsId: string,
    sessionID: string,
    partID: string,
    eventId: string | undefined,
  ): "accepted" | "duplicate" | "unidentified" => {
    const normalizedEventId = eventId?.trim();
    if (!normalizedEventId) return "unidentified";
    const key = textDeltaScopeKey(sourceWsId, sessionID, partID);
    const seen = seenTextDeltaEventIdsByPart.get(key) ?? new Set<string>();
    return seen.has(normalizedEventId) ? "duplicate" : "accepted";
  };
  const commitTextDelta = (
    sourceWsId: string,
    sessionID: string,
    partID: string,
    eventId: string | undefined,
  ): "accepted" | "duplicate" | "unidentified" => {
    const normalizedEventId = eventId?.trim();
    if (!normalizedEventId) {
      activeWriterBatch && (activeWriterBatch.textDeltaUnidentified += 1);
      return "unidentified";
    }
    const key = textDeltaScopeKey(sourceWsId, sessionID, partID);
    const seen = seenTextDeltaEventIdsByPart.get(key) ?? new Set<string>();
    if (seen.has(normalizedEventId)) {
      activeWriterBatch && (activeWriterBatch.textDeltaDuplicate += 1);
      return "duplicate";
    }
    seen.add(normalizedEventId);
    seenTextDeltaEventIdsByPart.set(key, seen);
    activeWriterBatch && (activeWriterBatch.textDeltaAccepted += 1);
    return "accepted";
  };
  const routeDescriptor = (entry: ClientEntry | null, client: RoutingClient) => ({
    client: entry?.client ?? client,
    baseUrl: entry?.baseUrl ?? "",
    directory: entry?.directory ?? "",
  });

  const activeEventStreamsSnapshot = () =>
    Object.fromEntries(
      Array.from(activeSseStreamsByWorkspace.entries()).map(([workspaceId, stream]) => [
        workspaceId,
        stream.generation,
      ]),
    );

  const publishSseConnected = () => {
    deps.setSseConnected(Array.from(sseConnectedByStream.values()).some(Boolean));
  };

  const setStreamSseConnected = (streamKey: string, connected: boolean) => {
    sseConnectedByStream.set(streamKey, connected);
    publishSseConnected();
  };

  const forgetStreamSseConnected = (streamKey: string) => {
    sseConnectedByStream.delete(streamKey);
    publishSseConnected();
  };

  const appendDebugEvent = (event: { type: string; properties?: unknown }) => {
    deps.setStore("events", (current: Array<{ type: string; properties?: unknown }>) => {
      const next = [event, ...current];
      return next.slice(0, 150);
    });
  };

  const compactDebugEvent = (event: OpencodeEvent) => {
    if (event.type === "message.part.updated") {
      const record = event.properties as Record<string, unknown> | undefined;
      const part = record?.part as Part | undefined;
      const delta = typeof record?.delta === "string" ? record.delta : "";
      const textLength =
        part?.type === "text" && typeof (part as { text?: unknown }).text === "string"
          ? String((part as { text?: string }).text).length
          : null;
      return {
        type: event.type,
        properties: {
          sessionID: part?.sessionID ?? null,
          messageID: part?.messageID ?? null,
          partID: part?.id ?? null,
          partType: part?.type ?? null,
          deltaLength: delta.length,
          textLength,
        },
      };
    }

    return {
      type: event.type,
      properties: event.properties,
    };
  };

  const isKnownSessionId = (sessionID: string): boolean => {
    if (deps.workspaceSessionIds.has(sessionID)) return true;
    if (deps.store.sessions.some((s) => s.id === sessionID)) {
      deps.workspaceSessionIds.add(sessionID);
      return true;
    }
    return false;
  };

  const hasAuthorizedSessionBinding = (
    record: Record<string, unknown>,
    sessionID: string,
    sourceWsId: string,
  ): boolean => {
    const binding = record.vesloBinding;
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) return false;
    const authorization = binding as Record<string, unknown>;
    return authorization.workspaceId === sourceWsId &&
      authorization.opencodeSessionId === sessionID &&
      typeof authorization.revision === "string" &&
      authorization.revision.trim().length > 0;
  };

  const bindKnownSessionToSource = (
    sessionID: string,
    sourceWsId: string,
    record?: Record<string, unknown>,
  ): boolean => {
    const normalizedSessionID = sessionID.trim();
    const normalizedWorkspaceID = sourceWsId.trim();
    if (!normalizedSessionID) return false;
    if (!normalizedWorkspaceID) return isKnownSessionId(normalizedSessionID);
    const existing = sessionWorkspaceBindings.get(normalizedSessionID);
    if (existing) return existing === normalizedWorkspaceID;
    // The orchestrator stamps every session-scoped event with this envelope.
    // That permits an event stream to recover a background session after a
    // client restart without falling back to the foreground workspace.
    if (record && Object.hasOwn(record, "vesloBinding")) {
      if (!hasAuthorizedSessionBinding(record, normalizedSessionID, normalizedWorkspaceID)) return false;
      sessionWorkspaceBindings.set(normalizedSessionID, normalizedWorkspaceID);
      return true;
    }
    if (!isKnownSessionId(normalizedSessionID)) return false;
    sessionWorkspaceBindings.set(normalizedSessionID, normalizedWorkspaceID);
    return true;
  };

  const bindAuthorizedCreatedSession = (
    record: Record<string, unknown>,
    sessionID: string,
    sourceWsId: string,
  ): boolean => {
    if (!hasAuthorizedSessionBinding(record, sessionID, sourceWsId)) return false;
    const normalizedSessionID = sessionID.trim();
    const normalizedWorkspaceID = sourceWsId.trim();
    const existing = sessionWorkspaceBindings.get(normalizedSessionID);
    if (existing && existing !== normalizedWorkspaceID) return false;
    if (normalizedWorkspaceID) sessionWorkspaceBindings.set(normalizedSessionID, normalizedWorkspaceID);
    return true;
  };

  const applyBackgroundWorkspaceEvent = (event: OpencodeEvent, workspaceId: string) => {
    if (!workspaceId || !event.properties || typeof event.properties !== "object") return;
    const record = event.properties as Record<string, unknown>;
    const sessionID = extractSessionId(record);

    if (event.type === "session.created" && sessionID) {
      // A background workspace is intentionally not allowed to populate the
      // foreground session store.  It can, however, establish the immutable
      // route binding needed for later lifecycle events from that same stream.
      if (!bindAuthorizedCreatedSession(record, sessionID, workspaceId)) {
        deps.sessionWarn("session.created:ignored:unauthorized-background-session", {
          sessionID,
          workspaceId,
        });
      }
      return;
    }

    if (sessionID && !bindKnownSessionToSource(sessionID, workspaceId, record)) {
      deps.sessionWarn(`${event.type}:ignored:workspace-session-mismatch`, {
        sessionID,
        workspaceId,
      });
      return;
    }

    if (event.type === "session.status" && sessionID) {
      const normalized = normalizeSessionStatus(record.status);
      const lifecycleOwnsEvent =
        normalized === "idle" &&
        deps.onSessionLifecycleObservation?.(sessionID, workspaceId, "session.idle") === true;
      deps.recordSessionStatusTrace("background-sse-session-status", {
        sessionId: sessionID,
        status: lifecycleOwnsEvent ? "lifecycle-pending" : normalized,
        sourceWorkspaceId: workspaceId,
        previous: deps.readStatusForSession(sessionID, workspaceId),
        lifecycleOwnsEvent,
      });
      if (lifecycleOwnsEvent) {
        recordSendWorkflowTrace("session-sse", "session-sse:status-idle-deferred-to-lifecycle", {
          sessionId: sessionID,
          workspaceId,
          background: true,
          eventType: event.type,
        });
        return;
      }
      deps.setSessionStatusForWorkspace(sessionID, normalized, workspaceId);
      deps.notifySessionBusy(sessionID, normalized, workspaceId);
      return;
    }

    if ((event.type === "session.idle" || event.type === "session.error") && sessionID) {
      const error = event.type === "session.error" && record.error && typeof record.error === "object"
        ? record.error as Record<string, unknown>
        : null;
      const errorName = typeof error?.name === "string" ? error.name : "UnknownError";
      const lifecycleOwnsEvent =
        (event.type !== "session.error" || errorName !== "MessageAbortedError") &&
        deps.onSessionLifecycleObservation?.(sessionID, workspaceId, event.type) === true;
      deps.recordSessionStatusTrace("background-sse-session-idle", {
        sessionId: sessionID,
        status: lifecycleOwnsEvent ? "lifecycle-pending" : "idle",
        sourceWorkspaceId: workspaceId,
        previous: deps.readStatusForSession(sessionID, workspaceId),
        lifecycleOwnsEvent,
      });
      if (lifecycleOwnsEvent) {
        recordSendWorkflowTrace(
          "session-sse",
          event.type === "session.idle"
            ? "session-sse:idle-deferred-to-lifecycle"
            : "session-sse:error-deferred-to-lifecycle",
          {
            sessionId: sessionID,
            workspaceId,
            background: true,
            eventType: event.type,
            errorName: event.type === "session.error" ? errorName : undefined,
          },
        );
        return;
      }
      deps.setSessionStatusForWorkspace(sessionID, "idle", workspaceId);
      deps.notifySessionBusy(sessionID, "idle", workspaceId);
      return;
    }

    if (event.type === "message.updated") {
      const info = record.info as Message | undefined;
      const targetSessionID = info?.sessionID?.trim() || sessionID;
      if (!targetSessionID) return;
      if ((info as { role?: string } | undefined)?.role === "assistant") {
        deps.onAssistantResponseObserved?.(targetSessionID);
      }
      return;
    }

    if (event.type === "message.part.updated") {
      const part = record.part as Part | undefined;
      const targetSessionID = part?.sessionID?.trim() || sessionID;
      if (!targetSessionID) return;
      return;
    }

    if (event.type === "message.removed" && sessionID) {
      return;
    }

    if (event.type === "message.part.removed" && sessionID) {
      return;
    }

    if (isPermissionRefreshEvent(event.type)) {
      void deps.refreshPendingPermissions();
      return;
    }

    if (isQuestionRefreshEvent(event.type)) {
      void deps.refreshPendingQuestions();
    }
  };

  const applyEvent = async (event: OpencodeEvent, sourceWsId: string = "") => {
    if (sourceWsId) {
      const activeWsId = deps.routing.activeWorkspaceId();
      if (activeWsId && sourceWsId !== activeWsId) {
        applyBackgroundWorkspaceEvent(event, sourceWsId);
        return;
      }
    }

    if (event.type === "server.connected") {
      deps.setSseConnected(true);
    }

    if (deps.developerMode()) {
      const compact = compactDebugEvent(event);
      if (event.type === "message.part.updated") {
        const now = Date.now();
        if (now - lastPartDebugEventAt < 250) {
          suppressedPartDebugEvents += 1;
        } else {
          lastPartDebugEventAt = now;
          if (suppressedPartDebugEvents > 0) {
            compact.properties = {
              ...(compact.properties ?? {}),
              suppressed: suppressedPartDebugEvents,
            };
            suppressedPartDebugEvents = 0;
          }
          appendDebugEvent(compact);
        }
      } else {
        if (suppressedPartDebugEvents > 0) {
          appendDebugEvent({
            type: "message.part.updated.sample",
            properties: { suppressed: suppressedPartDebugEvents },
          });
          suppressedPartDebugEvents = 0;
        }
        appendDebugEvent(compact);
      }
    }

    if (event.type === "session.updated" || event.type === "session.created") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        if (record.info && typeof record.info === "object") {
          const info = deps.applySessionDirectoryOverride(record.info as Session);
          const accepted = event.type === "session.created"
            ? bindAuthorizedCreatedSession(record, info.id, sourceWsId)
            : bindKnownSessionToSource(info.id, sourceWsId, record);
          if (!accepted) {
            deps.sessionWarn(`${event.type}:ignored:unauthorized-session`, {
              sessionID: info.id,
              workspaceId: sourceWsId,
            });
            return;
          }
          const root = normalizeDirectoryPath(deps.activeWorkspaceRoot());
          const sessionDir = deps.resolveSessionDirectory(info);
          if (root && sessionDir && !sessionDirectoryMatchesRoot(sessionDir, root)) {
            deps.sessionWarn("session.updated:ignored:wrong-workspace", {
              sessionID: info.id,
              sessionDir,
              activeRoot: root,
            });
            return;
          }
          deps.workspaceSessionIds.add(info.id);
          if (sourceWsId.trim()) sessionWorkspaceBindings.set(info.id, sourceWsId.trim());
          deps.setStore("sessions", (current: Session[]) => upsertSession(current, info));
        }
      }
    }

    if (event.type === "session.deleted") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const info = record.info as Session | undefined;
        if (info?.id) {
          if (!bindKnownSessionToSource(info.id, sourceWsId, record)) return;
          const removedMessageIDs = (deps.store.messages[info.id] ?? []).map((message) => message.id);
          for (const messageID of removedMessageIDs) {
            forgetTextDeltaMessage(sourceWsId, info.id, messageID);
          }
          deps.setStore("sessions", (current: Session[]) => removeSession(current, info.id));
          if (removedMessageIDs.length > 0) {
            deps.setStore(
              "commandDisplayByMessageID",
              produce((draft: Record<string, string>) => {
                removedMessageIDs.forEach((messageID) => {
                  delete draft[messageID];
                });
              }),
            );
          }
          deps.setStore(
            produce((draft: EventStreamStoreState) => {
              delete draft.sessionErrorTurns[info.id];
            }),
          );
          sessionWorkspaceBindings.delete(info.id);
        }
      }
    }

    if (event.type === "session.status") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const sessionID = extractSessionId(record);
        if (sessionID && bindKnownSessionToSource(sessionID, sourceWsId, record)) {
          const normalized = normalizeSessionStatus(record.status);
          const lifecycleOwnsEvent =
            normalized === "idle" &&
            deps.onSessionLifecycleObservation?.(sessionID, sourceWsId, "session.idle") === true;
          deps.recordSessionStatusTrace("sse-session-status", {
            sessionId: sessionID,
            status: lifecycleOwnsEvent ? "lifecycle-pending" : normalized,
            sourceWorkspaceId: sourceWsId ?? null,
            previous: deps.readStatusForSession(sessionID, sourceWsId),
            lifecycleOwnsEvent,
          });
          if (lifecycleOwnsEvent) {
            recordSendWorkflowTrace("session-sse", "session-sse:status-idle-deferred-to-lifecycle", {
              sessionId: sessionID,
              workspaceId: sourceWsId ?? null,
              background: false,
              eventType: event.type,
            });
            return;
          }
          deps.setSessionStatusForWorkspace(sessionID, normalized, sourceWsId);
          deps.notifySessionBusy(sessionID, normalized, sourceWsId);
          if (sessionID === deps.selectedSessionId() && normalized !== "idle") {
            deps.setError(null);
          }
        }
      }
    }

    if (event.type === "session.idle") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const sessionID = extractSessionId(record);
        if (sessionID && bindKnownSessionToSource(sessionID, sourceWsId, record)) {
          const lifecycleOwnsEvent =
            deps.onSessionLifecycleObservation?.(sessionID, sourceWsId, "session.idle") === true;
          deps.recordSessionStatusTrace("sse-session-idle", {
            sessionId: sessionID,
            status: lifecycleOwnsEvent ? "lifecycle-pending" : "idle",
            sourceWorkspaceId: sourceWsId ?? null,
            previous: deps.readStatusForSession(sessionID, sourceWsId),
            lifecycleOwnsEvent,
          });
          if (lifecycleOwnsEvent) {
            recordSendWorkflowTrace("session-sse", "session-sse:idle-deferred-to-lifecycle", {
              sessionId: sessionID,
              workspaceId: sourceWsId ?? null,
              background: false,
              eventType: "session.idle",
            });
          } else {
            deps.setSessionStatusForWorkspace(sessionID, "idle", sourceWsId);
            deps.notifySessionBusy(sessionID, "idle", sourceWsId);
          }
          const workspaceId = deps.resolveTranscriptIngestWorkspaceId(sourceWsId);
          if (workspaceId) {
          }
        }
      }
    }

    if (event.type === "opencode.hotreload.applied") {
      deps.onHotReloadApplied?.();
    }

    if (event.type === "session.error") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const sessionID = extractSessionId(record);
        const errorObj = record.error as Record<string, unknown> | undefined;
        const errorName = typeof errorObj?.name === "string" ? errorObj.name : "UnknownError";
        const acceptsSession = Boolean(sessionID && bindKnownSessionToSource(sessionID, sourceWsId, record));
        if (sessionID && !acceptsSession) {
          deps.sessionWarn("session.error:ignored:workspace-session-mismatch", {
            sessionID,
            workspaceId: sourceWsId,
          });
          return;
        }
        const lifecycleOwnsEvent = acceptsSession && sessionID && errorName !== "MessageAbortedError"
          ? deps.onSessionLifecycleObservation?.(sessionID, sourceWsId, "session.error") === true
          : false;
        if (sessionID && !lifecycleOwnsEvent) {
          deps.setSessionStatusForWorkspace(sessionID, "idle", sourceWsId);
          deps.notifySessionBusy(sessionID, "idle", sourceWsId);
        } else if (sessionID) {
          recordSendWorkflowTrace("session-sse", "session-sse:error-deferred-to-lifecycle", {
            sessionId: sessionID,
            workspaceId: sourceWsId ?? null,
            background: false,
            eventType: "session.error",
            errorName,
          });
        }
        if (errorObj) {
          if (errorName === "MessageAbortedError") {
            if (!sessionID) {
              deps.setError(null);
            }
            return;
          }
          const formattedError = addOpencodeCacheHint(formatSessionError(errorObj));
          const localInvalidBearer = isLocalVesloServerInvalidBearerError(errorObj);
          if (sessionID) {
            if (!lifecycleOwnsEvent) {
              deps.appendSessionErrorTurn(sessionID, formattedError, { workspaceId: sourceWsId });
            }
          } else {
            deps.setError(formattedError);
          }
          if (localInvalidBearer) {
            const recoveryAvailable = Boolean(sourceWsId && deps.recoverWorkspaceRuntimeForEventStream);
            recordSendWorkflowTrace("session-sse", "session-sse:local-runtime-invalid-bearer", {
              workspaceId: sourceWsId || null,
              sessionID: sessionID || null,
              recoveryAvailable,
              errorName,
              message: truncateErrorField(
                typeof errorObj.message === "string" ? errorObj.message : null,
              ),
            });
            deps.recordSessionStatusTrace("sse-session-error-local-runtime-invalid-bearer", {
              sessionId: sessionID || null,
              sourceWorkspaceId: sourceWsId || null,
              recoveryAvailable,
            });
            if (sourceWsId && deps.recoverWorkspaceRuntimeForEventStream) {
              deps.routing.release(sourceWsId);
              deps.sessionWarn("session.error:recovering-runtime-route", {
                workspaceId: sourceWsId,
                sessionID: sessionID || null,
                error: "local-veslo-server-invalid-bearer",
              });
              recordPerfLog(deps.sessionDebugEnabled(), "session.sse", "session-error-runtime-route-recovery", {
                workspaceId: sourceWsId,
                sessionID: sessionID || null,
                error: "local-veslo-server-invalid-bearer",
              });
              try {
                const recovered = await deps.recoverWorkspaceRuntimeForEventStream(sourceWsId);
                deps.recordSessionStatusTrace("sse-session-error-local-runtime-recovery-result", {
                  sessionId: sessionID || null,
                  sourceWorkspaceId: sourceWsId,
                  recovered: Boolean(recovered),
                });
              } catch (recoveryError) {
                deps.sessionWarn("session.error:runtime-route-recovery-failed", {
                  workspaceId: sourceWsId,
                  sessionID: sessionID || null,
                  error: truncateErrorField(
                    recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
                  ),
                });
              }
            }
          }
          return;
        }

        const fallback = truncateErrorField(record.error, 700) ?? "An unexpected error occurred";
        if (sessionID) {
          if (!lifecycleOwnsEvent) {
            deps.appendSessionErrorTurn(sessionID, addOpencodeCacheHint(fallback), { workspaceId: sourceWsId });
          }
        } else {
          deps.setError(addOpencodeCacheHint(fallback));
        }
      }
    }

    if (event.type === "message.updated") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        if (record.info && typeof record.info === "object") {
          const info = record.info as Message;
          if (!bindKnownSessionToSource(info.sessionID, sourceWsId, record)) return;
          const current = deps.store.messages[info.sessionID] ?? [];
          const next = upsertMessageInfo(current, info as MessageInfo);
          if (next !== current) {
            recordTranscriptStoreWrite("sse.message.updated", "message-info", info.sessionID, info.id);
            deps.setStore("messages", info.sessionID, next);
          }
          deps.onTranscriptObserved?.(info.sessionID);
          if ((info as { role?: string }).role === "assistant") {
            deps.onAssistantResponseObserved?.(info.sessionID);
            recordSendWorkflowTrace("session-sse", "session-sse:assistant-message-updated", {
              workspaceId: sourceWsId || null,
              sessionID: info.sessionID,
              messageID: info.id,
              role: "assistant",
            });
          }
        }
      }
    }

    if (event.type === "message.removed") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const sessionID = extractSessionId(record);
        const messageID = typeof record.messageID === "string" ? record.messageID : null;
        if (sessionID && messageID) {
          forgetTextDeltaMessage(sourceWsId, sessionID, messageID);
          const workspaceId = deps.resolveTranscriptIngestWorkspaceId(sourceWsId);
          if (workspaceId && bindKnownSessionToSource(sessionID, sourceWsId, record)) {
            deps.recordPendingTranscriptMessageDeletion(workspaceId, sessionID, messageID);
          }
          const currentMessages = deps.store.messages[sessionID] ?? [];
          const nextMessages = removeMessageInfo(currentMessages, messageID);
          if (nextMessages.length !== currentMessages.length) {
            recordTranscriptStoreWrite("sse.message.removed", "message-info", sessionID, messageID);
            deps.setStore("messages", sessionID, nextMessages);
          }
          if ((deps.store.parts[messageID] ?? []).length > 0) {
            recordTranscriptStoreWrite("sse.message.removed", "parts", sessionID, messageID);
            deps.setStore("parts", messageID, []);
          }
          deps.setStore(
            "commandDisplayByMessageID",
            produce((draft: Record<string, string>) => {
              delete draft[messageID];
            }),
          );
          deps.onTranscriptObserved?.(sessionID);
          if (workspaceId && bindKnownSessionToSource(sessionID, sourceWsId, record)) {
          }
        }
      }
    }

    if (event.type === "command.executed") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const messageID = typeof record.messageID === "string" ? record.messageID.trim() : "";
        const name = typeof record.name === "string" ? record.name : "";
        const args = typeof record.arguments === "string" ? record.arguments : "";
        deps.setCommandDisplay(messageID, name, args);
      }
    }

    if (event.type === "message.part.updated") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        if (record.part && typeof record.part === "object") {
          const part = record.part as Part;

          if (!bindKnownSessionToSource(part.sessionID, sourceWsId, record)) {
            deps.sessionWarn("message.part.updated:ignored:unknown-session", {
              sessionID: part.sessionID,
              messageID: part.messageID,
              partID: part.id,
            });
            return;
          }

          const delta = typeof record.delta === "string" ? record.delta : null;
          const preparedTextDeltaOutcome =
            delta && part.type === "text"
              ? inspectTextDelta(sourceWsId, part.sessionID, part.id, event.eventId)
              : null;
          const partUpdatedStartedAt = perfNow();
          const parentMessageRole =
            deps.store.messages[part.sessionID]?.find((message) => message.id === part.messageID)
              ?.role ?? null;

          const commitPartMutation = () => {
            const textDeltaOutcome =
              delta && part.type === "text"
                ? commitTextDelta(sourceWsId, part.sessionID, part.id, event.eventId)
                : null;
            if (textDeltaOutcome === "duplicate") return;
            const currentMessages = deps.store.messages[part.sessionID] ?? [];
            const hasMessage = currentMessages.some((message) => message.id === part.messageID);
            const currentParts = deps.store.parts[part.messageID] ?? [];
            const existingPart = currentParts.find((item) => item.id === part.id) as (Part & { text?: string }) | undefined;
            const appendsTextDelta = Boolean(
              delta && part.type === "text" && typeof existingPart?.text === "string",
            );
            const nextParts = appendsTextDelta ? currentParts : upsertPartInfo(currentParts, part);
            const changesParts = appendsTextDelta || nextParts !== currentParts;
            if (!hasMessage) {
              recordTranscriptStoreWrite("sse.part.updated", "message-info", part.sessionID, part.messageID);
            }
            if (changesParts) {
              recordTranscriptStoreWrite("sse.part.updated", "parts", part.sessionID, part.messageID);
              recordTranscriptStoreWrite("sse.part.updated", "part", part.sessionID, part.messageID, part.id);
            }
            deps.setStore(
              produce((draft: EventStreamStoreState) => {
                const list = draft.messages[part.sessionID] ?? [];
                if (!list.find((message) => message.id === part.messageID)) {
                  draft.messages[part.sessionID] = upsertMessageInfo(list, createPlaceholderMessage(part));
                }

                const parts = draft.parts[part.messageID] ?? [];
                const existingIndex = parts.findIndex((item) => item.id === part.id);

                if (delta && part.type === "text" && existingIndex !== -1) {
                  const existing = parts[existingIndex] as Part & { text?: string };
                  if (typeof existing.text === "string") {
                    // A delta is an append. Never infer replay from its text:
                    // two independent \"ha\" chunks must become \"haha\".
                    const next = { ...existing, text: `${existing.text}${delta}` } as Part;
                    parts[existingIndex] = next;
                    draft.parts[part.messageID] = parts;
                    return;
                  }
                }

                draft.parts[part.messageID] = upsertPartInfo(parts, part);
              }),
            );
            deps.onTranscriptObserved?.(part.sessionID);
          };
          const deferred =
            part.type === "text" &&
            parentMessageRole === "assistant" &&
            preparedTextDeltaOutcome !== "duplicate" &&
            deps.deferAssistantTextPartMutation?.({
              sessionId: part.sessionID,
              workspaceId: sourceWsId,
              commit: commitPartMutation,
            }) === true;
          if (!deferred) commitPartMutation();
          const resolvedPart =
            deps.store.parts[part.messageID]?.find((item) => item.id === part.id) ??
            part;
          const chromeDiagnostics = chromeMcpToolTraceDiagnostics(resolvedPart);
          if (chromeDiagnostics) {
            const traceKey = `${part.messageID}:${part.id}`;
            const traceSignature = [
              chromeDiagnostics.status,
              chromeDiagnostics.errorCode ?? "",
              chromeDiagnostics.errorFingerprint ?? "",
              chromeDiagnostics.hasOutput ? "output" : "",
            ].join("\u0000");
            const previousSignature = chromeMcpTraceSignatureByPart.get(traceKey);
            if (previousSignature !== traceSignature) {
              const firstObservedAt = chromeMcpFirstObservedAtByPart.get(traceKey) ?? Date.now();
              chromeMcpFirstObservedAtByPart.set(traceKey, firstObservedAt);
              recordSendWorkflowTrace("session-sse", "session-sse:chrome-mcp-tool-updated", {
                workspaceId: sourceWsId || null,
                sessionID: part.sessionID,
                messageID: part.messageID,
                partID: part.id,
                ...chromeDiagnostics,
                observedDurationMs: Math.max(0, Date.now() - firstObservedAt),
              });
              chromeMcpTraceSignatureByPart.set(traceKey, traceSignature);
            }
            if (chromeDiagnostics.terminal) {
              chromeMcpTraceSignatureByPart.delete(traceKey);
              chromeMcpFirstObservedAtByPart.delete(traceKey);
            }
          }
          const resolvedTextLength =
            resolvedPart.type === "text" && typeof (resolvedPart as { text?: unknown }).text === "string"
              ? String((resolvedPart as { text?: string }).text).length
              : null;
          if (part.type === "text" && parentMessageRole === "assistant") {
            recordSendWorkflowTrace("session-sse", "session-sse:assistant-part-updated", {
              workspaceId: sourceWsId || null,
              sessionID: part.sessionID,
              messageID: part.messageID,
              partID: part.id,
              partType: part.type,
              role: parentMessageRole,
              deltaLength: delta?.length ?? 0,
              deltaDelivery: deferred ? "held" : preparedTextDeltaOutcome,
              hasTransportEventId: Boolean(event.eventId),
              textLength: resolvedTextLength,
              hasText: (resolvedTextLength ?? 0) > 0,
            });
          }
          deps.recordSyntheticContinueDiagnostic(resolvedPart);
          const partUpdatedMs = Math.round((perfNow() - partUpdatedStartedAt) * 100) / 100;
          if (deps.sessionDebugEnabled() && (partUpdatedMs >= 8 || (delta?.length ?? 0) >= 120)) {
            recordPerfLog(true, "session.event", "message.part.updated", {
              sessionID: part.sessionID,
              messageID: part.messageID,
              partID: part.id,
              partType: part.type,
              deltaLength: delta?.length ?? 0,
              textLength: resolvedTextLength,
              ms: partUpdatedMs,
            });
          }
          deps.maybeMarkReloadRequired(part);
          deps.maybeHandleInvalidToolError(part, sourceWsId);
          deps.maybeHandleChromeMcpCompletedError(resolvedPart, sourceWsId);
        }
      }
    }

    if (event.type === "message.part.removed") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const sessionID = extractSessionId(record);
        const messageID = typeof record.messageID === "string" ? record.messageID : null;
        const partID = typeof record.partID === "string" ? record.partID : null;
        if (messageID && partID) {
          if (sessionID) forgetTextDeltaPart(sourceWsId, sessionID, partID);
          const resolvedSessionID = sessionID || deps.resolveSessionIdForMessage(messageID);
          const workspaceId = deps.resolveTranscriptIngestWorkspaceId(sourceWsId);
          if (workspaceId && resolvedSessionID && bindKnownSessionToSource(resolvedSessionID, sourceWsId, record)) {
            deps.recordPendingTranscriptPartDeletion(workspaceId, resolvedSessionID, messageID, partID);
          }
          const currentParts = deps.store.parts[messageID] ?? [];
          const nextParts = removePartInfo(currentParts, partID);
          if (nextParts.length !== currentParts.length) {
            recordTranscriptStoreWrite("sse.part.removed", "parts", resolvedSessionID ?? "", messageID);
            recordTranscriptStoreWrite("sse.part.removed", "part", resolvedSessionID ?? "", messageID, partID);
            deps.setStore("parts", messageID, nextParts);
          }
          if (resolvedSessionID && bindKnownSessionToSource(resolvedSessionID, sourceWsId, record)) {
          }
        }
      }
    }

    if (event.type === "todo.updated") {
      if (event.properties && typeof event.properties === "object") {
        const record = event.properties as Record<string, unknown>;
        const sessionID = extractSessionId(record);
        if (sessionID && bindKnownSessionToSource(sessionID, sourceWsId, record) && Array.isArray(record.todos)) {
          deps.setStore("todos", sessionID, normalizeTodoItems(record.todos));
        }
      }
    }

    if (isPermissionRefreshEvent(event.type)) {
      try {
        await deps.refreshPendingPermissions();
      } catch {
        // ignore
      }
    }

    if (isQuestionRefreshEvent(event.type)) {
      try {
        await deps.refreshPendingQuestions();
      } catch {
        // ignore
      }
    }
  };

  const createSseStream = (
    sourceWsId: string,
    c: RoutingClient,
    generation: number,
  ): (() => void) => {
    const streamConnectionKey = sseConnectionKey(sourceWsId);
    const cancellation = new Set<true>();
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let wasConnected = false;
    let outageEpisode = clearOutageEpisode();
    let currentController: AbortController | null = null;
    const activeSubscriptions = new Set<SseSubscription>();
    let lastUpstreamEventId: string | null = null;

    const emitReconnectState = (
      status: ReconnectState["status"],
      input: Partial<Omit<ReconnectState, "status" | "workspaceId" | "sessionId" | "updatedAt">> = {},
    ) => {
      deps.onReconnectState?.(
        createReconnectState({
          status,
          workspaceId: sourceWsId,
          sessionId: deps.selectedSessionId(),
          attempt: input.attempt,
          delayMs: input.delayMs,
          lastError: input.lastError,
          messagesMayBeDelayed: input.messagesMayBeDelayed,
        }),
      );
    };

    let queue: Array<OpencodeEvent | undefined> = [];
    const coalesced = new Map<string, number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    let queueStartedAt = 0;
    let peakQueueDepth = 0;
    let queueHasPartUpdates = false;
    let coalescedReplaced = 0;

    const keyForEvent = (event: OpencodeEvent) => {
      if (event.type === "session.status" || event.type === "session.idle") {
        const record = event.properties as Record<string, unknown> | undefined;
        const sessionID = record ? (extractSessionId(record) ?? "") : "";
        return sessionID ? `${event.type}:${sessionID}` : undefined;
      }
      if (event.type === "message.part.updated") {
        const record = event.properties as Record<string, unknown> | undefined;
        if (typeof record?.delta === "string") return undefined;
        const part = record?.part as Part | undefined;
        if (part?.messageID && part.id) {
          return `message.part.updated:${part.messageID}:${part.id}`;
        }
      }
      if (event.type === "todo.updated") {
        const record = event.properties as Record<string, unknown> | undefined;
        const sessionID = record ? (extractSessionId(record) ?? "") : "";
        return sessionID ? `todo.updated:${sessionID}` : undefined;
      }
      return undefined;
    };

    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;

      const eventsToApply = queue;
      queue = [];
      coalesced.clear();
      if (eventsToApply.length === 0) return;

      const queueWaitMs = queueStartedAt > 0 ? Date.now() - queueStartedAt : 0;
      queueStartedAt = 0;
      const peakDepth = peakQueueDepth;
      peakQueueDepth = 0;
      queueHasPartUpdates = false;
      const replaced = coalescedReplaced;
      coalescedReplaced = 0;

      last = Date.now();
      const startedAt = perfNow();
      let applied = 0;
      let partUpdates = 0;
      let messageUpdates = 0;
      const writerBatch = { textDeltaAccepted: 0, textDeltaDuplicate: 0, textDeltaUnidentified: 0 };
      activeWriterBatch = writerBatch;
      try {
        batch(() => {
          for (const event of eventsToApply) {
            if (!event) continue;
            if (event.type === "message.part.updated") partUpdates += 1;
            if (event.type === "message.updated") messageUpdates += 1;
            applied += 1;
            void applyEvent(event, sourceWsId);
          }
        });
      } finally {
        activeWriterBatch = null;
      }

      const elapsedMs = Math.round((perfNow() - startedAt) * 100) / 100;
      const dropped = eventsToApply.length - applied;
      if (
        deps.sessionDebugEnabled() &&
        (writerBatch.textDeltaAccepted > 0 || writerBatch.textDeltaDuplicate > 0 || writerBatch.textDeltaUnidentified > 0)
      ) {
        recordPerfLog(true, "session.sse", "writer-batch", {
          textDeltaAccepted: writerBatch.textDeltaAccepted,
          textDeltaDuplicate: writerBatch.textDeltaDuplicate,
          textDeltaUnidentified: writerBatch.textDeltaUnidentified,
        });
      }
      if (
        deps.sessionDebugEnabled() &&
        (elapsedMs >= 10 || queueWaitMs >= 40 || peakDepth >= 25 || applied >= 30 || dropped >= 12)
      ) {
        recordPerfLog(true, "session.sse", "flush", {
          queued: eventsToApply.length,
          applied,
          dropped,
          queueWaitMs,
          peakQueueDepth: peakDepth,
          coalescedReplaced: replaced,
          messageUpdates,
          partUpdates,
          ms: elapsedMs,
        });
      }
    };

    const schedule = () => {
      if (timer) return;
      const elapsed = Date.now() - last;
      const interval = queueHasPartUpdates ? 48 : 16;
      timer = setTimeout(flush, Math.max(0, interval - elapsed));
    };

    const markOutageAndMaybeNotify = () => {
      if (!outageEpisode.active) {
        outageEpisode = beginOutageEpisode(deps.store.sessionStatus, sourceWsId);
        recordPerfLog(deps.sessionDebugEnabled(), "session.sse", "outage-started", {
          runningSessions: outageEpisode.runningSessionIds.length,
        });
      }

      if (shouldShowReconnecting(outageEpisode)) {
        deps.onReconnectNotice?.("reconnecting");
        outageEpisode = { ...outageEpisode, shownReconnecting: true };
      }
    };

    const runReconnectCatchup = async ({ refreshTranscript }: { refreshTranscript: boolean }) => {
      if (!outageEpisode.active) return;
      if (!outageEpisode.hadRunningSessions) {
        outageEpisode = clearOutageEpisode();
        emitReconnectState("live", { messagesMayBeDelayed: false });
        return;
      }

      const sessionIds = outageEpisode.runningSessionIds.slice();
      emitReconnectState("catching-up", { messagesMayBeDelayed: true });
      recordPerfLog(deps.sessionDebugEnabled(), "session.sse", "catchup-start", {
        sessions: sessionIds.length,
        generation,
      });

      const isBackgroundCatchup = Boolean(sourceWsId && sourceWsId !== deps.routing.activeWorkspaceId());
      let criticalFailureCount = 0;
      let lastCriticalFailure: string | null = null;
      for (const sessionID of sessionIds) {
        if (!sessionID) continue;

        try {
          const fetched = unwrap(await c.session.get({ sessionID })) as Record<string, unknown>;
          const normalized = normalizeSessionStatus(fetched?.status);
          deps.setSessionStatusForWorkspace(sessionID, normalized, sourceWsId);
          deps.notifySessionBusy(sessionID, normalized, sourceWsId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          criticalFailureCount += 1;
          lastCriticalFailure = message;
          deps.recordSessionStatusTrace("sse-reconnect-catchup-status-failed", {
            sessionId: sessionID,
            sourceWorkspaceId: sourceWsId || null,
            message,
          });
          continue;
        }

        if (!isBackgroundCatchup && refreshTranscript) {
          try {
            const limit = Math.max(INITIAL_SESSION_MESSAGE_LIMIT, deps.messageLimitBySession()[sessionID] ?? 0);
            const msgs = unwrap(
              await deps.withTimeout(c.session.messages({ sessionID, limit }), 12000, "session.messages"),
            );
            deps.setMessagesForSession(sessionID, msgs);
            deps.setMessageLimitBySession((prev: Record<string, number>) => ({ ...prev, [sessionID]: limit }));
            deps.setMessageCompleteBySession((prev: Record<string, boolean>) => ({
              ...prev,
              [sessionID]: msgs.length < limit,
            }));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            criticalFailureCount += 1;
            lastCriticalFailure = message;
            deps.recordSessionStatusTrace("sse-reconnect-catchup-messages-failed", {
              sessionId: sessionID,
              sourceWorkspaceId: sourceWsId || null,
              message,
            });
          }
        }

        if (isBackgroundCatchup) continue;

        try {
          const list = unwrap(await deps.withTimeout(c.session.todo({ sessionID }), 8000, "session.todo"));
          deps.setStore("todos", sessionID, normalizeTodoItems(list));
        } catch {
          // fail soft per session
        }
      }

      try {
        await deps.withTimeout(deps.refreshPendingPermissions(), 6000, "permission.list");
      } catch {
        // ignore
      }

      try {
        await deps.withTimeout(deps.refreshPendingQuestions(), 6000, "question.list");
      } catch {
        // ignore
      }

      if (criticalFailureCount > 0) {
        recordPerfLog(deps.sessionDebugEnabled(), "session.sse", "catchup-incomplete", {
          sessions: sessionIds.length,
          criticalFailures: criticalFailureCount,
          generation,
        });
        outageEpisode = clearOutageEpisode();
        emitReconnectState("degraded", {
          lastError: truncateErrorField(lastCriticalFailure ?? "Reconnect catch-up incomplete"),
          messagesMayBeDelayed: true,
        });
        return;
      }

      if (refreshTranscript && shouldShowReconnected(outageEpisode)) {
        deps.onReconnectNotice?.("reconnected");
        outageEpisode = { ...outageEpisode, shownReconnected: true };
      }

      recordPerfLog(deps.sessionDebugEnabled(), "session.sse", "catchup-complete", {
        sessions: sessionIds.length,
        generation,
        refreshTranscript,
      });
      outageEpisode = clearOutageEpisode();
      // Keep the no-fence condition in the trace, not as a sticky UI error.
      // `live` lets lifecycle recovery resume its terminal transcript path;
      // no success toast is emitted above unless a fenced refresh succeeded.
      emitReconnectState("live", { messagesMayBeDelayed: !refreshTranscript });
    };

    const connectSse = async (controller: AbortController) => {
      currentController = controller;
      try {
        const entry = sourceWsId ? deps.routing.entry(sourceWsId) : null;
        const useRustSse = Boolean(isEngineSseAvailable() && entry?.baseUrl);
        const bridgeConnectionKey = sseBridgeConnectionKey(sourceWsId);
        recordSendWorkflowTrace(
          "session-sse",
          useRustSse ? "session-sse:rust-proxy" : "session-sse:sdk-fallback",
          {
            workspaceId: sourceWsId || null,
            transport: useRustSse ? "rust-proxy" : "sdk-sse-fallback",
            reason: useRustSse
              ? "engine_sse_available"
              : isEngineSseAvailable()
                ? "missing_route_base_url"
                : "engine_sse_unavailable",
            hasRoute: Boolean(entry),
            hasBaseUrl: Boolean(entry?.baseUrl),
            connectionKey: useRustSse ? bridgeConnectionKey : null,
            directory: entry?.directory ?? null,
            generation,
            activeEventStreamsByWorkspace: activeEventStreamsSnapshot(),
          },
        );
        const sub = await (useRustSse
          ? engineSseSubscribe({
              workspaceId: sourceWsId,
              baseUrl: entry?.baseUrl ?? "",
              directory: entry?.directory ?? null,
              connectionKey: bridgeConnectionKey,
              lastEventId: lastUpstreamEventId,
              ...engineSseAuthOptions(entry?.auth),
              signal: controller.signal,
            })
          : c.event.subscribe(undefined, { signal: controller.signal })) as SseSubscription;
        activeSubscriptions.add(sub);
        if (useRustSse) {
          recordSendWorkflowTrace("session-sse", "session-sse:rust-proxy-subscribed", {
            workspaceId: sourceWsId || null,
            generation,
            subscriptionId: sub.subscriptionId ?? null,
            replacedExisting: sub.replacedExisting === true,
            connectionKey: bridgeConnectionKey,
            activeRustSseSubscriptions: sub.activeSubscriptionCount ?? null,
            activeRustSseConnections: sub.activeConnectionCount ?? null,
            activeEventStreamsByWorkspace: activeEventStreamsSnapshot(),
          });
        }
        if (cancellation.has(true) || controller.signal.aborted) {
          await closeSseSubscription(sub);
          activeSubscriptions.delete(sub);
          return;
        }
        let yielded = Date.now();
        let lastArrivalAt = Date.now();

        const isReconnection = wasConnected;
        wasConnected = true;
        reconnectAttempt = 0;
        recordPerfLog(deps.sessionDebugEnabled(), "session.sse", "connected", { generation });

        if (isReconnection) {
          // Neither the engine API nor its messages endpoint currently exposes
          // an atomic snapshot/cursor fence. Last-Event-ID is forwarded when
          // available, but a catch-up remains eventual unless the upstream
          // explicitly honours that cursor.
          recordPerfLog(deps.sessionDebugEnabled(), "session.sse", "reconnect-no-cursor-fence", {
            hasLastUpstreamEventId: Boolean(lastUpstreamEventId),
            contract: "eventual-reconciliation",
          });
          recordSendWorkflowTrace("session-sse", "session-sse:reconnect-no-cursor-fence", {
            workspaceId: sourceWsId || null,
            generation,
            hasLastUpstreamEventId: Boolean(lastUpstreamEventId),
            contract: "eventual-reconciliation",
          });
          await runReconnectCatchup({ refreshTranscript: false });
        } else {
          emitReconnectState("live", { messagesMayBeDelayed: false });
        }

        try {
          for await (const raw of sub.stream) {
            if (cancellation.has(true)) break;

            const event = normalizeEvent(raw);
            if (!event) continue;
            lastUpstreamEventId = nextUpstreamEventCursor(lastUpstreamEventId, event);
            if (event.type === "server.connected") {
              setStreamSseConnected(streamConnectionKey, true);
            }

            const arrivedAt = Date.now();
            const arrivalGapMs = arrivedAt - lastArrivalAt;
            lastArrivalAt = arrivedAt;
            if (deps.sessionDebugEnabled() && arrivalGapMs >= 220) {
              recordPerfLog(true, "session.sse", "arrival-gap", {
                ms: arrivalGapMs,
                type: event.type,
              });
            }

            const key = keyForEvent(event);
            if (key) {
              const existing = coalesced.get(key);
              if (existing !== undefined) {
                if (queue[existing] !== undefined) {
                  coalescedReplaced += 1;
                }
                queue[existing] = undefined;
              }
              coalesced.set(key, queue.length);
            }

            if (queue.length === 0) {
              queueStartedAt = Date.now();
            }
            if (event.type === "message.part.updated") {
              queueHasPartUpdates = true;
            }
            queue.push(event);
            if (queue.length > peakQueueDepth) {
              peakQueueDepth = queue.length;
            }
            schedule();

            if (Date.now() - yielded < 8) continue;
            yielded = Date.now();
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
        } finally {
          activeSubscriptions.delete(sub);
          await closeSseSubscription(sub);
        }

        if (!cancellation.has(true)) {
          setStreamSseConnected(streamConnectionKey, false);
          recordPerfLog(deps.sessionDebugEnabled(), "session.sse", "stream-ended", { generation });
          scheduleReconnect(controller);
        }
      } catch (e) {
        if (cancellation.has(true)) return;
        if (controller.signal.aborted) return;

        const message = e instanceof Error ? e.message : String(e);
        const activeWs = deps.routing.activeWorkspaceId();
        const textMatchedRuntimeError = shouldRecoverLocalRuntimeFromHealthError(e, String);
        const scopedRuntimeReady = sourceWsId
          ? deps.isWorkspaceRuntimeReady(sourceWsId)
          : deps.isActiveWorkspaceRuntimeReady();
        const shouldRecoverRoute = Boolean(
          sourceWsId &&
            shouldRecoverEventStreamRuntime({
              recoveryAvailable: Boolean(deps.recoverWorkspaceRuntimeForEventStream),
              textMatchedRuntimeError,
              scopedRuntimeReady,
            }),
        );
        if (shouldRecoverRoute) {
          setStreamSseConnected(streamConnectionKey, false);
          deps.routing.release(sourceWsId);
          emitReconnectState("runtime-recovering", {
            lastError: truncateErrorField(message),
            messagesMayBeDelayed: true,
          });
          deps.sessionWarn("sse:recovering-runtime-route", {
            workspaceId: sourceWsId,
            error: truncateErrorField(message),
            scopedRuntimeReady,
          });
          recordPerfLog(deps.sessionDebugEnabled(), "session.sse", "recovering-runtime-route", {
            workspaceId: sourceWsId,
            error: truncateErrorField(message),
            scopedRuntimeReady,
          });
          try {
            const recovered = await deps.recoverWorkspaceRuntimeForEventStream?.(sourceWsId);
            recordPerfLog(deps.sessionDebugEnabled(), "session.sse", "runtime-route-recovery-result", {
              workspaceId: sourceWsId,
              recovered: Boolean(recovered),
            });
            if (!recovered) {
              emitReconnectState("degraded", {
                lastError: truncateErrorField(message),
                messagesMayBeDelayed: true,
              });
            }
          } catch (recoveryError) {
            emitReconnectState("degraded", {
              lastError: truncateErrorField(recoveryError instanceof Error ? recoveryError.message : String(recoveryError)),
              messagesMayBeDelayed: true,
            });
            deps.sessionWarn("sse:runtime-route-recovery-failed", {
              workspaceId: sourceWsId,
              error: truncateErrorField(recoveryError instanceof Error ? recoveryError.message : String(recoveryError)),
            });
          }
          return;
        }
        if (textMatchedRuntimeError && scopedRuntimeReady) {
          recordPerfLog(deps.sessionDebugEnabled(), "session.sse", "runtime-recovery-skipped-runtime-ready", {
            workspaceId: sourceWsId || null,
            error: truncateErrorField(message),
          });
        }

        if (shouldReleaseStaleWorkspaceRoute(sourceWsId, activeWs, message)) {
          setStreamSseConnected(streamConnectionKey, false);
          deps.routing.release(sourceWsId);
          deps.sessionWarn("sse:released-stale-route", {
            workspaceId: sourceWsId,
            error: truncateErrorField(message),
          });
          recordPerfLog(deps.sessionDebugEnabled(), "session.sse", "released-stale-route", {
            workspaceId: sourceWsId,
            error: truncateErrorField(message),
          });
          return;
        }

        setStreamSseConnected(streamConnectionKey, false);
        recordPerfLog(deps.sessionDebugEnabled(), "session.sse", "stream-error", {
          error: message,
          generation,
        });
        scheduleReconnect(controller);
      }
    };

    const scheduleReconnect = (oldController: AbortController) => {
      if (cancellation.has(true)) return;
      if (reconnectTimer) return;
      markOutageAndMaybeNotify();
      oldController.abort();

      reconnectAttempt++;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), 30000);
      emitReconnectState("reconnecting", {
        attempt: reconnectAttempt,
        delayMs: delay,
        messagesMayBeDelayed: true,
      });
      recordPerfLog(deps.sessionDebugEnabled(), "session.sse", "reconnect-scheduled", {
        attempt: reconnectAttempt,
        delayMs: delay,
        generation,
      });

      reconnectTimer = setTimeout(() => {
        if (cancellation.has(true)) return;
        reconnectTimer = undefined;
        const newController = new AbortController();
        void connectSse(newController);
      }, delay);
    };

    const controller = new AbortController();
    void connectSse(controller);

    return () => {
      cancellation.add(true);
      currentController?.abort();
      for (const subscription of Array.from(activeSubscriptions)) {
        activeSubscriptions.delete(subscription);
        void closeSseSubscription(subscription);
      }
      if (reconnectTimer) clearTimeout(reconnectTimer);
      forgetStreamSseConnected(streamConnectionKey);
      flush();
    };
  };

  const setupSseStream = (
    sourceWsId: string,
    c: RoutingClient,
    reason = "start",
  ): (() => void) => {
    const streamConnectionKey = sseConnectionKey(sourceWsId);
    const bridgeConnectionKey = sseBridgeConnectionKey(sourceWsId);
    const streamDescriptor = routeDescriptor(sourceWsId ? deps.routing.entry(sourceWsId) : null, c);
    const previous = activeSseStreamsByWorkspace.get(streamConnectionKey);
    const generation = ++nextSseStreamGeneration;
    if (previous) {
      const replacementCount = (sseStreamReplacementCountsByWorkspace.get(streamConnectionKey) ?? 0) + 1;
      sseStreamReplacementCountsByWorkspace.set(streamConnectionKey, replacementCount);
      recordSendWorkflowTrace("session-sse", "session-sse:replaced-existing", {
        workspaceId: sourceWsId || null,
        previousGeneration: previous.generation,
        generation,
        reason: "replaced-existing",
        requestedReason: reason,
        replacementCount,
        streamConnectionKey,
        bridgeConnectionKey,
        baseUrl: streamDescriptor.baseUrl || null,
        directory: streamDescriptor.directory || null,
        activeEventStreamsByWorkspace: activeEventStreamsSnapshot(),
      });
      previous.cleanup();
    }

    recordSendWorkflowTrace("session-sse", "session-sse:stream-start", {
      workspaceId: sourceWsId || null,
      generation,
      reason,
      streamConnectionKey,
      bridgeConnectionKey,
      baseUrl: streamDescriptor.baseUrl || null,
      directory: streamDescriptor.directory || null,
      activeEventStreamsByWorkspace: activeEventStreamsSnapshot(),
    });

    const startedAt = Date.now();
    const innerCleanup = createSseStream(sourceWsId, c, generation);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      const current = activeSseStreamsByWorkspace.get(streamConnectionKey);
      if (current?.generation === generation) {
        activeSseStreamsByWorkspace.delete(streamConnectionKey);
      }
      recordSendWorkflowTrace("session-sse", "session-sse:stream-cleanup", {
        workspaceId: sourceWsId || null,
        generation,
        staleGeneration: current ? current.generation !== generation : true,
        streamConnectionKey,
        bridgeConnectionKey,
        baseUrl: streamDescriptor.baseUrl || null,
        directory: streamDescriptor.directory || null,
        durationMs: Date.now() - startedAt,
        activeEventStreamsByWorkspace: activeEventStreamsSnapshot(),
      });
      innerCleanup();
    };
    activeSseStreamsByWorkspace.set(streamConnectionKey, {
      generation,
      cleanup,
      startedAt,
    });
    return cleanup;
  };

  const startEventStreams = () => {
    const reconciledStreams = new Map<string, ReconciledSseStream>();

    const cleanupAllReconciledStreams = () => {
      for (const [key, stream] of Array.from(reconciledStreams.entries())) {
        cleanupReconciledSseStream(reconciledStreams, key, stream);
      }
    };

    createEffect(() => {
      const activeWorkspaceId = deps.routing.activeWorkspaceId().trim();
      const entryIds = deps.isSharedEngineSingleViewFallback?.()
        ? (activeWorkspaceId ? [activeWorkspaceId] : [])
        : deps.routing.entryIds();

      const targets: SseTargetDescriptor[] = [];
      for (const wsId of entryIds) {
        if (!deps.isWorkspaceRuntimeReady(wsId)) continue;
        const entry = deps.routing.entry(wsId);
        const c = entry?.client ?? deps.routing.client(wsId);
        if (!c) continue;
        const descriptor = routeDescriptor(entry, c);
        targets.push({
          wsId,
          key: sseConnectionKey(wsId),
          ...descriptor,
        });
      }

      const changed = reconcileSseStreamTargets(
        reconciledStreams,
        targets,
        (target) => setupSseStream(target.wsId, target.client, "routing-entry"),
      );
      if (changed) {
        deps.workspaceSessionIds.clear();
        sessionWorkspaceBindings.clear();
      }

      if (reconciledStreams.size === 0) {
        sseConnectedByStream.clear();
        deps.setSseConnected(false);
      }
    });

    onCleanup(() => {
      cleanupAllReconciledStreams();
    });
  };

  return {
    applyBackgroundWorkspaceEvent,
    applyEvent,
    setupSseStream,
    startEventStreams,
  };
}

async function closeSseSubscription(subscription: SseSubscription): Promise<void> {
  try {
    if (typeof subscription.close === "function") {
      await subscription.close();
      return;
    }
    const dispose = subscription[Symbol.asyncDispose];
    if (typeof dispose === "function") {
      await dispose.call(subscription);
    }
  } catch {
    // Stream teardown is best-effort; callers already move to reconnect or cleanup.
  }
}
