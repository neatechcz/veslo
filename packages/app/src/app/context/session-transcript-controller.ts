import { batch, createSignal, onCleanup } from "solid-js";
import type { SetStoreFunction } from "solid-js/store";

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
  preserveLiveParts?: boolean;
};

export const INITIAL_SESSION_MESSAGE_LIMIT = 140;
export const SESSION_MESSAGE_LOAD_CHUNK = 120;

type TranscriptStoreState = {
  sessions: Session[];
  messages: Record<string, MessageInfo[]>;
  parts: Record<string, Part[]>;
};

type TranscriptIngestScope = {
  directory?: string | null;
};

export type SessionTranscriptControllerDeps = {
  store: TranscriptStoreState;
  setStore: SetStoreFunction<TranscriptStoreState>;
  routing: WorkspaceRouting;
  activeWorkspaceRoot: () => string;
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

    let preservedMessageCount = 0;
    let preservedPartCount = 0;
    const preserveLiveParts = options.preserveLiveParts !== false;
    const nextMessages: MessageWithParts[] = snapshot.messages
      .filter((info): info is MessageInfo => Boolean(info?.id))
      .map((info) => {
        const snapshotParts = sortById(
          (snapshot.partsByMessageId[info.id] ?? []).filter((part): part is Part => Boolean(part?.id)),
        );
        const observedParts = (deps.store.parts[info.id] ?? []).filter((part): part is Part => Boolean(part?.id));
        const preservesLiveParts = preserveLiveParts &&
          snapshotParts.length === 0 && observedParts.length > 0;
        if (preservesLiveParts) {
          preservedMessageCount += 1;
          preservedPartCount += observedParts.length;
        }
        return {
          info,
          // A passive snapshot can lag the live event stream even when it has the
          // same message list. Never let it erase message content already shown.
          parts: preservesLiveParts
            ? sortById(observedParts)
            : snapshotParts,
        };
      });
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

      if (preservedMessageCount > 0) {
        recordSendWorkflowTrace("session-transcript", "session-transcript:snapshot-preserved-live-parts", {
          workspaceId: snapshot.workspaceId,
          sessionId: sessionID,
          preservedMessageCount,
          preservedPartCount,
        });
      }

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

  const resolveTranscriptIngestDirectory = (
    workspaceId: string,
    sessionID: string,
    scope?: TranscriptIngestScope,
  ) => {
    const session = deps.store.sessions.find((candidate) => candidate.id === sessionID) ?? null;
    if (session) return normalizeDirectoryPath(deps.resolveSessionDirectory(session));
    const scopedDirectory = normalizeDirectoryPath(scope?.directory ?? "");
    if (scopedDirectory) return scopedDirectory;
    const entryDirectory = normalizeDirectoryPath(deps.routing.entry(workspaceId)?.directory ?? "");
    if (entryDirectory) return entryDirectory;
    const activeWorkspaceId = deps.routing.activeWorkspaceId().trim();
    return activeWorkspaceId === workspaceId ? normalizeDirectoryPath(deps.activeWorkspaceRoot()) : "";
  };

  const captureTranscriptIngestScope = (workspaceId: string, sessionID: string): TranscriptIngestScope => ({
    directory: resolveTranscriptIngestDirectory(workspaceId, sessionID),
  });

  const buildTranscriptIngestPayload = (
    workspaceId: string,
    sessionID: string,
    reason: string,
    scope?: TranscriptIngestScope,
  ) => {
    const key = transcriptIngestKey(workspaceId, sessionID);
    const pendingDeletions = pendingTranscriptDeletionsForKey(key);

    const activeWorkspaceId = deps.routing.activeWorkspaceId().trim();
    if (activeWorkspaceId && activeWorkspaceId !== workspaceId) {
      recordSendWorkflowTrace("session-transcript", "session-transcript:ingest-active-workspace-switched", {
        workspaceId,
        sessionID,
        reason,
        activeWorkspaceId,
      });
    }
    const directory = resolveTranscriptIngestDirectory(workspaceId, sessionID, scope);
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
  };
}
