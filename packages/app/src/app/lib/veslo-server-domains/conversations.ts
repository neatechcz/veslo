import type {
  VesloConversationAbortInput,
  VesloConversationAbortResult,
  VesloConversationCreateResult,
  VesloConversationImportInput,
  VesloConversationImportResult,
  VesloConversationList,
  VesloConversationRunInput,
  VesloConversationRunResult,
  VesloConversationRunStatusResult,
  VesloConversationQueueItem,
  VesloConversationQueueList,
  VesloConversationQueueStatus,
  VesloConversationSubmitRequest,
  VesloConversationSubmitResult,
  VesloSessionArchiveRecord,
  VesloSessionLatestRunArtifacts,
  VesloSessionTranscriptPrefetchInput,
  VesloSessionTranscriptPrefetchResult,
  VesloSessionTranscriptReadOptions,
  VesloSessionTranscriptRecoveryInput,
  VesloSessionTranscriptRecoveryResult,
  VesloSessionTranscriptSnapshot,
} from "../veslo-server/types";
import { VESLO_ACCOUNT_ID_HEADER, VESLO_SEND_TRACE_ID_HEADER } from "../veslo-server/header-profiles";

type RequestJsonOptions = {
  method?: string;
  token?: string;
  hostToken?: string;
  body?: unknown;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
  diagnosticOperation?: "session-archives:list";
};

export type ConversationsClientContext = {
  baseUrl: string;
  token?: string;
  hostToken?: string;
  accountId?: string;
  requestJson: <T>(baseUrl: string, path: string, options?: RequestJsonOptions) => Promise<T>;
  timeouts: {
    deleteSession: number;
    sessionArtifacts: number;
    sessionTranscript: number;
    conversationCreate: number;
    conversationRun: number;
    conversationAbort: number;
    status: number;
  };
};

type TranscriptOptions = VesloSessionTranscriptReadOptions & {
  limit?: number;
  directory?: string | null;
};

const sendTraceHeaders = (options?: { sendTraceId?: string | null }) =>
  options?.sendTraceId?.trim() ? { [VESLO_SEND_TRACE_ID_HEADER]: options.sendTraceId.trim() } : undefined;

export function createConversationsClient(context: ConversationsClientContext) {
  const { baseUrl, token, hostToken, accountId, requestJson, timeouts } = context;
  const archiveHeaders = accountId ? { [VESLO_ACCOUNT_ID_HEADER]: accountId } : undefined;

  return {
    listArchives: () =>
      requestJson<{ items: VesloSessionArchiveRecord[] }>(baseUrl, "/session-archives", {
        token,
        hostToken,
        extraHeaders: archiveHeaders,
        diagnosticOperation: "session-archives:list",
      }),

    putArchive: (sessionId: string, payload: Omit<VesloSessionArchiveRecord, "sessionId">) =>
      requestJson<{ items: VesloSessionArchiveRecord[] }>(
        baseUrl,
        `/session-archives/${encodeURIComponent(sessionId)}`,
        {
          token,
          hostToken,
          method: "PUT",
          body: payload,
          extraHeaders: archiveHeaders,
        },
      ),

    deleteArchive: (
      sessionId: string,
      options?: { workspaceId?: string | null; workspaceIdentity?: string | null; directory?: string | null },
    ) => {
      const workspaceId = options?.workspaceId?.trim() ?? "";
      const workspaceIdentity = options?.workspaceIdentity?.trim() ?? "";
      const directory = options?.directory?.trim() ?? "";
      const search = new URLSearchParams();
      if (workspaceId) search.set("workspaceId", workspaceId);
      if (workspaceIdentity) search.set("workspaceIdentity", workspaceIdentity);
      if (directory) search.set("directory", directory);
      const query = search.size > 0 ? `?${search.toString()}` : "";
      return requestJson<{ items: VesloSessionArchiveRecord[] }>(
        baseUrl,
        `/session-archives/${encodeURIComponent(sessionId)}${query}`,
        {
          token,
          hostToken,
          method: "DELETE",
          extraHeaders: archiveHeaders,
        },
      );
    },

    deleteSession: (workspaceId: string, sessionId: string) =>
      requestJson<{ ok: boolean }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.deleteSession },
      ),

    list: (workspaceId: string, directory?: string, options?: { sync?: boolean }) => {
      const search = new URLSearchParams();
      const directoryRaw = directory?.trim() ?? "";
      if (directoryRaw) search.set("directory", directoryRaw);
      if (options?.sync === true) search.set("sync", "true");
      const query = search.toString();
      return requestJson<VesloConversationList>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/conversations${query ? `?${query}` : ""}`,
        { token, hostToken, timeoutMs: timeouts.sessionTranscript },
      );
    },

    create: (
      workspaceId: string,
      input?: { directory?: string | null; title?: string | null },
      options?: { sendTraceId?: string | null },
    ) =>
      requestJson<VesloConversationCreateResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/conversations`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            ...(input?.directory?.trim() ? { directory: input.directory.trim() } : {}),
            ...(input?.title?.trim() ? { title: input.title.trim() } : {}),
          },
          timeoutMs: timeouts.conversationCreate,
          extraHeaders: sendTraceHeaders(options),
        },
      ),

    import: (workspaceId: string, input: VesloConversationImportInput) =>
      requestJson<VesloConversationImportResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/conversations/import`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            ...(input.directory?.trim() ? { directory: input.directory.trim() } : {}),
            sessions: input.sessions.map((session) => ({
              id: session.id,
              title: session.title,
              parentID: session.parentID,
              time: session.time,
            })),
          },
          timeoutMs: timeouts.sessionTranscript,
        },
      ),

    run: (
      workspaceId: string,
      conversationId: string,
      input: VesloConversationRunInput,
      options?: { sendTraceId?: string | null },
    ) =>
      requestJson<VesloConversationRunResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(conversationId)}/runs`,
        {
          token,
          hostToken,
          method: "POST",
          body: input,
          timeoutMs: timeouts.conversationRun,
          extraHeaders: sendTraceHeaders(options),
        },
      ),

    submit: (
      workspaceId: string,
      input: VesloConversationSubmitRequest,
      options?: { sendTraceId?: string | null },
    ) =>
      requestJson<VesloConversationSubmitResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/conversations/submit`,
        {
          token,
          hostToken,
          method: "POST",
          body: input,
          timeoutMs: timeouts.conversationRun,
          extraHeaders: sendTraceHeaders(options),
        },
      ),

    abort: (workspaceId: string, conversationId: string, input: VesloConversationAbortInput) =>
      requestJson<VesloConversationAbortResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(conversationId)}/abort`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            ...(input.runId?.trim() ? { runId: input.runId.trim() } : { mode: input.mode ?? "active" }),
            ...(input.directory?.trim() ? { directory: input.directory.trim() } : {}),
          },
          timeoutMs: timeouts.conversationAbort,
        },
      ),

    getRunStatus: (workspaceId: string, conversationId: string, runId: string) =>
      requestJson<VesloConversationRunStatusResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}`,
        { token, hostToken, timeoutMs: timeouts.status },
      ),

    listQueue: (
      workspaceId: string,
      conversationId: string,
      options?: { status?: VesloConversationQueueStatus[]; cursor?: string | null; limit?: number },
    ) => {
      const search = new URLSearchParams();
      for (const status of options?.status ?? ["pending", "starting", "failed"]) search.append("status", status);
      const cursor = options?.cursor?.trim() ?? "";
      if (cursor) search.set("cursor", cursor);
      search.set("limit", String(options?.limit ?? 50));
      return requestJson<VesloConversationQueueList>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(conversationId)}/queue?${search.toString()}`,
        { token, hostToken, timeoutMs: timeouts.status },
      );
    },

    getQueueItem: (workspaceId: string, conversationId: string, queueItemId: string) =>
      requestJson<VesloConversationQueueItem>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(conversationId)}/queue/${encodeURIComponent(queueItemId)}`,
        { token, hostToken, timeoutMs: timeouts.status },
      ),

    getLatestRunArtifacts: (workspaceId: string, sessionId: string, directory?: string | null) => {
      const search = new URLSearchParams();
      const directoryRaw = directory?.trim() ?? "";
      if (directoryRaw) search.set("directory", directoryRaw);
      const query = search.toString();
      return requestJson<VesloSessionLatestRunArtifacts>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/artifacts/latest-run${query ? `?${query}` : ""}`,
        { token, hostToken, timeoutMs: timeouts.sessionArtifacts },
      );
    },

    prefetchTranscripts: (workspaceId: string, input: VesloSessionTranscriptPrefetchInput) =>
      requestJson<VesloSessionTranscriptPrefetchResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/transcript-prefetch`,
        { token, hostToken, method: "POST", body: input, timeoutMs: timeouts.sessionTranscript },
      ),

    getTranscript: (workspaceId: string, sessionId: string, options?: TranscriptOptions) => {
      const search = new URLSearchParams();
      search.set("limit", String(options?.limit ?? 140));
      const directoryRaw = options?.directory?.trim() ?? "";
      if (directoryRaw) search.set("directory", directoryRaw);
      const includeProjection = options?.includeLatestRunArtifacts === true && Boolean(options.caller);
      if (includeProjection) {
        search.set("include", "latest-run-artifacts");
        search.set("caller", options!.caller!);
      }
      return requestJson<VesloSessionTranscriptSnapshot>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/transcript?${search.toString()}`,
        {
          token,
          hostToken,
          timeoutMs: timeouts.sessionTranscript,
          extraHeaders: sendTraceHeaders(options),
        },
      );
    },

    recoverTranscript: (workspaceId: string, sessionId: string, input: VesloSessionTranscriptRecoveryInput) =>
      requestJson<VesloSessionTranscriptRecoveryResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/transcript/recover`,
        { token, hostToken, method: "POST", body: input, timeoutMs: timeouts.sessionTranscript },
      ),

  };
}

export type ConversationsClient = ReturnType<typeof createConversationsClient>;
