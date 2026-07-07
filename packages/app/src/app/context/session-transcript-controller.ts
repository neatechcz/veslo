import { batch, createSignal, onCleanup } from "solid-js";

import type { Part, Session } from "@opencode-ai/sdk/v2/client";

import type { VesloSessionTranscriptSnapshot } from "../lib/veslo-server";
import { unwrap } from "../lib/opencode";
import { recordSendWorkflowTrace } from "../lib/send-workflow-trace";
import { normalizeDirectoryPath } from "../utils";
import type { MessageInfo, MessageWithParts } from "../types";
import type { WorkspaceRouting } from "./workspace-routing";
import {
  sortById,
  sortMessagesByActivity,
} from "./session-store-model";

export type TranscriptFreshness = {
  fetchedAt: number | null;
  staleAt: number | null;
};

export type HydrateTranscriptSnapshotOptions = {
  allowShorter?: boolean;
};

export const INITIAL_SESSION_MESSAGE_LIMIT = 140;
export const SESSION_MESSAGE_LOAD_CHUNK = 120;

type TranscriptStoreState = {
  sessions: Session[];
  messages: Record<string, MessageInfo[]>;
  parts: Record<string, Part[]>;
};

type AppendTranscriptSnapshot = (input: {
  workspaceId: string;
  sessionId: string;
  directory?: string | null;
  limit?: number;
  messages: MessageInfo[];
  partsByMessageId: Record<string, Part[]>;
  deletedMessageIds?: string[];
  deletedPartsByMessageId?: Record<string, string[]>;
  reason?: string;
}) => Promise<void> | void;

export type SessionTranscriptControllerDeps = {
  store: TranscriptStoreState;
  setStore: (...args: any[]) => void;
  routing: WorkspaceRouting;
  activeWorkspaceRoot: () => string;
  appendTranscriptSnapshot?: AppendTranscriptSnapshot;
  applySessionDirectoryOverride: <T extends Session>(session: T) => T;
  resolveSessionDirectory: (session: Pick<Session, "id" | "directory">) => string;
  sessionWarn: (label: string, payload?: unknown) => void;
  withTimeout: <T>(promise: Promise<T>, ms: number, label: string) => Promise<T>;
};

export function createSessionTranscriptController(deps: SessionTranscriptControllerDeps) {
  const [messageLimitBySession, setMessageLimitBySession] = createSignal<Record<string, number>>({});
  const [messageCompleteBySession, setMessageCompleteBySession] = createSignal<Record<string, boolean>>({});
  const [messageLoadBusyBySession, setMessageLoadBusyBySession] = createSignal<Record<string, boolean>>({});
  const [transcriptFreshnessBySession, setTranscriptFreshnessBySession] = createSignal<
    Record<string, TranscriptFreshness>
  >({});

  function setMessagesForSession(sessionID: string, list: MessageWithParts[]) {
    const infos = list
      .map((msg) => msg.info)
      .filter((info) => !!info?.id)
      .map((info) => info as MessageInfo);

    batch(() => {
      deps.setStore("messages", sessionID, sortMessagesByActivity(infos));
      for (const message of list) {
        const parts = message.parts.filter((part) => !!part?.id);
        deps.setStore("parts", message.info.id, sortById(parts));
      }
    });
  }

  function hydrateTranscriptSnapshot(
    snapshot: VesloSessionTranscriptSnapshot,
    options: HydrateTranscriptSnapshotOptions = {},
  ) {
    if (snapshot.source === "unavailable") return;

    const sessionID = snapshot.sessionId.trim();
    if (!sessionID) return;

    const nextFetchedAt = typeof snapshot.fetchedAt === "number" ? snapshot.fetchedAt : null;
    const currentFreshness = transcriptFreshnessBySession()[sessionID];
    if (
      currentFreshness?.fetchedAt != null &&
      nextFetchedAt != null &&
      nextFetchedAt < currentFreshness.fetchedAt
    ) {
      return;
    }

    const nextMessages: MessageWithParts[] = snapshot.messages
      .filter((info): info is MessageInfo => Boolean(info?.id))
      .map((info) => ({
        info,
        parts: sortById((snapshot.partsByMessageId[info.id] ?? []).filter((part): part is Part => Boolean(part?.id))),
      }));
    const existingMessageCount = getCachedTranscriptMessageCount(sessionID);

    batch(() => {
      setTranscriptFreshnessBySession((current) => ({
        ...current,
        [sessionID]: {
          fetchedAt: nextFetchedAt,
          staleAt: typeof snapshot.staleAt === "number" ? snapshot.staleAt : null,
        },
      }));

      if (existingMessageCount > nextMessages.length && !options.allowShorter) return;

      setMessagesForSession(sessionID, nextMessages);

      const requestedLimit = Math.max(snapshot.limit || 0, nextMessages.length);
      const currentLimit = messageLimitBySession()[sessionID] ?? 0;
      const effectiveLimit = Math.max(requestedLimit, currentLimit);
      setMessageLimitBySession((current) => ({
        ...current,
        [sessionID]: effectiveLimit,
      }));
      setMessageCompleteBySession((current) => ({
        ...current,
        [sessionID]: nextMessages.length < effectiveLimit,
      }));
    });
  }

  function hasWarmTranscript(sessionID: string) {
    return (deps.store.messages[sessionID] ?? []).length > 0;
  }

  function getCachedTranscriptMessageCount(sessionID: string) {
    return (deps.store.messages[sessionID] ?? []).length;
  }

  function getCachedTranscriptMessages(sessionID: string) {
    return deps.store.messages[sessionID] ?? [];
  }

  function getTranscriptFreshness(sessionID: string) {
    return transcriptFreshnessBySession()[sessionID] ?? null;
  }

  const transcriptIngestTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const backgroundTranscriptIngestTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const transcriptIngestInFlight = new Map<string, Promise<void>>();
  const pendingTranscriptDeletedMessageIds = new Map<string, Set<string>>();
  const pendingTranscriptDeletedPartsByMessageId = new Map<string, Map<string, Set<string>>>();
  const TRANSCRIPT_INGEST_DEBOUNCE_MS = 600;
  const BACKGROUND_TRANSCRIPT_INGEST_DEBOUNCE_MS = 2_500;

  const transcriptIngestKey = (workspaceId: string, sessionID: string) => `${workspaceId}\0${sessionID}`;

  const resolveTranscriptIngestWorkspaceId = (sourceWsId?: string | null) =>
    sourceWsId?.trim() || deps.routing.activeWorkspaceId().trim();

  const countPartsByMessageId = (partsByMessageId: Record<string, Part[]>) =>
    Object.values(partsByMessageId).reduce((total, parts) => total + parts.length, 0);

  const resolveSessionIdForMessage = (messageID: string) => {
    const id = messageID.trim();
    if (!id) return "";
    for (const [sessionID, messages] of Object.entries(deps.store.messages)) {
      if (messages.some((message) => message.id === id)) return sessionID;
    }
    return "";
  };

  const recordPendingTranscriptMessageDeletion = (
    workspaceId: string,
    sessionID: string,
    messageID: string,
  ) => {
    const key = transcriptIngestKey(workspaceId, sessionID);
    const id = messageID.trim();
    if (!id) return;
    const messages = pendingTranscriptDeletedMessageIds.get(key) ?? new Set<string>();
    messages.add(id);
    pendingTranscriptDeletedMessageIds.set(key, messages);
    pendingTranscriptDeletedPartsByMessageId.get(key)?.delete(id);
  };

  const recordPendingTranscriptPartDeletion = (
    workspaceId: string,
    sessionID: string,
    messageID: string,
    partID: string,
  ) => {
    const key = transcriptIngestKey(workspaceId, sessionID);
    const messageId = messageID.trim();
    const partId = partID.trim();
    if (!messageId || !partId) return;
    let partsByMessage = pendingTranscriptDeletedPartsByMessageId.get(key);
    if (!partsByMessage) {
      partsByMessage = new Map<string, Set<string>>();
      pendingTranscriptDeletedPartsByMessageId.set(key, partsByMessage);
    }
    const parts = partsByMessage.get(messageId) ?? new Set<string>();
    parts.add(partId);
    partsByMessage.set(messageId, parts);
  };

  const pendingTranscriptDeletionsForKey = (key: string) => {
    const deletedMessageIds = [...(pendingTranscriptDeletedMessageIds.get(key) ?? new Set<string>())];
    const deletedPartsByMessageId: Record<string, string[]> = {};
    for (const [messageID, partIds] of pendingTranscriptDeletedPartsByMessageId.get(key) ?? new Map()) {
      const values = [...partIds];
      if (values.length > 0) deletedPartsByMessageId[messageID] = values;
    }
    return { deletedMessageIds, deletedPartsByMessageId };
  };

  const clearPendingTranscriptDeletions = (
    key: string,
    deletions: { deletedMessageIds?: string[]; deletedPartsByMessageId?: Record<string, string[]> },
  ) => {
    const messageSet = pendingTranscriptDeletedMessageIds.get(key);
    for (const messageID of deletions.deletedMessageIds ?? []) {
      messageSet?.delete(messageID);
    }
    if (messageSet && messageSet.size === 0) pendingTranscriptDeletedMessageIds.delete(key);

    const partsByMessage = pendingTranscriptDeletedPartsByMessageId.get(key);
    for (const [messageID, partIds] of Object.entries(deletions.deletedPartsByMessageId ?? {})) {
      const partSet = partsByMessage?.get(messageID);
      for (const partID of partIds) partSet?.delete(partID);
      if (partSet && partSet.size === 0) partsByMessage?.delete(messageID);
    }
    if (partsByMessage && partsByMessage.size === 0) {
      pendingTranscriptDeletedPartsByMessageId.delete(key);
    }
  };

  const buildTranscriptIngestPayload = (
    workspaceId: string,
    sessionID: string,
    reason: string,
  ) => {
    const activeWorkspaceId = deps.routing.activeWorkspaceId().trim();
    if (activeWorkspaceId && activeWorkspaceId !== workspaceId) return null;
    const key = transcriptIngestKey(workspaceId, sessionID);
    const pendingDeletions = pendingTranscriptDeletionsForKey(key);

    const session = deps.store.sessions.find((candidate) => candidate.id === sessionID) ?? null;
    const directory = session
      ? deps.resolveSessionDirectory(session)
      : normalizeDirectoryPath(deps.activeWorkspaceRoot());
    if (!workspaceId || !sessionID || !directory) return null;

    const messagesForSession = sortMessagesByActivity(
      (deps.store.messages[sessionID] ?? []).filter((message): message is MessageInfo => Boolean(message?.id)),
    );
    const hasPendingDeletions =
      pendingDeletions.deletedMessageIds.length > 0 ||
      Object.keys(pendingDeletions.deletedPartsByMessageId).length > 0;
    if (messagesForSession.length === 0 && !hasPendingDeletions) return null;

    const partsByMessageId: Record<string, Part[]> = {};
    for (const message of messagesForSession) {
      partsByMessageId[message.id] = sortById(
        (deps.store.parts[message.id] ?? []).filter((part): part is Part => Boolean(part?.id)),
      );
    }

    return {
      workspaceId,
      sessionId: sessionID,
      directory,
      limit: Math.max(messageLimitBySession()[sessionID] ?? 0, messagesForSession.length),
      messages: messagesForSession,
      partsByMessageId,
      deletedMessageIds: pendingDeletions.deletedMessageIds,
      deletedPartsByMessageId: pendingDeletions.deletedPartsByMessageId,
      reason,
    };
  };

  const flushTranscriptIngestion = (workspaceId: string, sessionID: string, reason: string) => {
    const key = transcriptIngestKey(workspaceId, sessionID);
    const timer = transcriptIngestTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      transcriptIngestTimers.delete(key);
    }

    const writer = deps.appendTranscriptSnapshot;
    if (!writer) return undefined;
    const payload = buildTranscriptIngestPayload(workspaceId, sessionID, reason);
    if (!payload) return undefined;
    const messageCount = payload.messages.length;
    const partCount = countPartsByMessageId(payload.partsByMessageId);
    const deletedMessageCount = payload.deletedMessageIds?.length ?? 0;
    const deletedPartCount = Object.values(payload.deletedPartsByMessageId ?? {})
      .reduce((total, partIds) => total + partIds.length, 0);
    recordSendWorkflowTrace("session-transcript", "session-transcript:ingest-flush-start", {
      workspaceId,
      sessionID,
      reason,
      messageCount,
      partCount,
      deletedMessageCount,
      deletedPartCount,
    });

    const previous = transcriptIngestInFlight.get(key) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        await writer(payload);
        clearPendingTranscriptDeletions(key, payload);
        recordSendWorkflowTrace("session-transcript", "session-transcript:ingest-flush-done", {
          workspaceId,
          sessionID,
          reason,
          messageCount,
          partCount,
          deletedMessageCount,
          deletedPartCount,
        });
      })
      .catch((error) => {
        recordSendWorkflowTrace("session-transcript", "session-transcript:ingest-flush-error", {
          workspaceId,
          sessionID,
          reason,
          messageCount,
          partCount,
          deletedMessageCount,
          deletedPartCount,
          error: error instanceof Error ? error.message : String(error),
        });
        deps.sessionWarn("transcript-ingest:failed", {
          workspaceId,
          sessionID,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    const tracked = run.finally(() => {
      if (transcriptIngestInFlight.get(key) === tracked) {
        transcriptIngestInFlight.delete(key);
      }
    });
    transcriptIngestInFlight.set(key, tracked);
    return tracked;
  };

  const scheduleTranscriptIngestion = (
    sessionID: string,
    sourceWsId: string | undefined,
    reason: string,
    delayMs = TRANSCRIPT_INGEST_DEBOUNCE_MS,
  ) => {
    if (!deps.appendTranscriptSnapshot) return;
    const workspaceId = resolveTranscriptIngestWorkspaceId(sourceWsId);
    if (!workspaceId || !sessionID) return;
    const key = transcriptIngestKey(workspaceId, sessionID);
    const existing = transcriptIngestTimers.get(key);
    if (existing) clearTimeout(existing);
    recordSendWorkflowTrace("session-transcript", "session-transcript:ingest-scheduled", {
      workspaceId,
      sessionID,
      reason,
      delayMs,
      replacedExistingTimer: Boolean(existing),
    });
    transcriptIngestTimers.set(
      key,
      setTimeout(() => {
        void flushTranscriptIngestion(workspaceId, sessionID, reason);
      }, delayMs),
    );
  };

  const flushBackgroundTranscriptIngestion = async (
    workspaceId: string,
    sessionID: string,
    reason: string,
  ) => {
    const key = transcriptIngestKey(workspaceId, sessionID);
    const timer = backgroundTranscriptIngestTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      backgroundTranscriptIngestTimers.delete(key);
    }

    const writer = deps.appendTranscriptSnapshot;
    if (!writer) return;
    const c = deps.routing.client(workspaceId);
    if (!c) return;

    const previous = transcriptIngestInFlight.get(key) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const entry = deps.routing.entry(workspaceId);
        const session = deps.applySessionDirectoryOverride(
          unwrap(await deps.withTimeout(c.session.get({ sessionID }), 8_000, "background session.get")),
        );
        const directory =
          deps.resolveSessionDirectory(session) ||
          normalizeDirectoryPath(entry?.directory ?? "");
        if (!directory) return;

        const limit = Math.max(INITIAL_SESSION_MESSAGE_LIMIT, messageLimitBySession()[sessionID] ?? 0);
        const transcript = unwrap(
          await deps.withTimeout(c.session.messages({ sessionID, limit }), 12_000, "background session.messages"),
        ) as MessageWithParts[];
        const messages = sortMessagesByActivity(
          transcript
            .map((message) => message.info)
            .filter((info): info is MessageInfo => Boolean(info?.id)),
        );
        if (messages.length === 0) return;

        const partsByMessageId: Record<string, Part[]> = {};
        for (const message of transcript) {
          if (!message.info?.id) continue;
          partsByMessageId[message.info.id] = sortById(
            message.parts.filter((part): part is Part => Boolean(part?.id)),
          );
        }

        await writer({
          workspaceId,
          sessionId: sessionID,
          directory,
          limit: Math.max(limit, messages.length),
          messages,
          partsByMessageId,
          reason,
        });
      })
      .catch((error) => {
        deps.sessionWarn("background-transcript-ingest:failed", {
          workspaceId,
          sessionID,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    const tracked = run.finally(() => {
      if (transcriptIngestInFlight.get(key) === tracked) {
        transcriptIngestInFlight.delete(key);
      }
    });
    transcriptIngestInFlight.set(key, tracked);
    await tracked;
  };

  const scheduleBackgroundTranscriptIngestion = (
    sessionID: string,
    workspaceId: string,
    reason: string,
    delayMs = BACKGROUND_TRANSCRIPT_INGEST_DEBOUNCE_MS,
  ) => {
    if (!deps.appendTranscriptSnapshot) return;
    const normalizedWorkspaceId = workspaceId.trim();
    const normalizedSessionId = sessionID.trim();
    if (!normalizedWorkspaceId || !normalizedSessionId) return;
    const key = transcriptIngestKey(normalizedWorkspaceId, normalizedSessionId);
    const existing = backgroundTranscriptIngestTimers.get(key);
    if (existing) clearTimeout(existing);
    backgroundTranscriptIngestTimers.set(
      key,
      setTimeout(() => {
        void flushBackgroundTranscriptIngestion(normalizedWorkspaceId, normalizedSessionId, reason);
      }, delayMs),
    );
  };

  onCleanup(() => {
    for (const timer of transcriptIngestTimers.values()) clearTimeout(timer);
    transcriptIngestTimers.clear();
    for (const timer of backgroundTranscriptIngestTimers.values()) clearTimeout(timer);
    backgroundTranscriptIngestTimers.clear();
  });

  return {
    messageLimitBySession,
    setMessageLimitBySession,
    messageCompleteBySession,
    setMessageCompleteBySession,
    messageLoadBusyBySession,
    setMessageLoadBusyBySession,
    transcriptFreshnessBySession,
    setTranscriptFreshnessBySession,
    setMessagesForSession,
    hydrateTranscriptSnapshot,
    hasWarmTranscript,
    getCachedTranscriptMessageCount,
    getCachedTranscriptMessages,
    getTranscriptFreshness,
    resolveTranscriptIngestWorkspaceId,
    resolveSessionIdForMessage,
    recordPendingTranscriptMessageDeletion,
    recordPendingTranscriptPartDeletion,
    buildTranscriptIngestPayload,
    flushTranscriptIngestion,
    scheduleTranscriptIngestion,
    flushBackgroundTranscriptIngestion,
    scheduleBackgroundTranscriptIngestion,
  };
}
