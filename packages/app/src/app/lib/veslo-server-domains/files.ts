import type {
  VesloArtifactList,
  VesloFileCatalogEntry,
  VesloFileOpsBatchResult,
  VesloFileReadBatchResult,
  VesloFileSession,
  VesloFileSessionEvent,
  VesloFileWriteBatchResult,
  VesloInboxList,
  VesloInboxUploadResult,
  VesloWorkspaceFileContent,
  VesloWorkspaceFileWriteResult,
} from "../veslo-server/types";

type RequestJsonOptions = {
  method?: string;
  token?: string;
  hostToken?: string;
  body?: unknown;
  timeoutMs?: number;
};

type RequestMultipartOptions = {
  method?: string;
  token?: string;
  hostToken?: string;
  body?: FormData;
  timeoutMs?: number;
};

type RequestBinaryOptions = {
  method?: string;
  token?: string;
  hostToken?: string;
  timeoutMs?: number;
};

export type FilesClientContext = {
  baseUrl: string;
  token?: string;
  hostToken?: string;
  requestJson: <T>(baseUrl: string, path: string, options?: RequestJsonOptions) => Promise<T>;
  requestMultipartRaw: (
    baseUrl: string,
    path: string,
    options?: RequestMultipartOptions,
  ) => Promise<{ ok: boolean; status: number; text: string }>;
  requestBinary: (
    baseUrl: string,
    path: string,
    options?: RequestBinaryOptions,
  ) => Promise<{ data: ArrayBuffer; contentType: string | null; filename: string | null }>;
  createRequestFailedError: (status: number, message: string) => Error;
  binaryTimeoutMs: number;
};

export function createFilesClient(context: FilesClientContext) {
  const {
    baseUrl,
    token,
    hostToken,
    requestJson,
    requestMultipartRaw,
    requestBinary,
    createRequestFailedError,
    binaryTimeoutMs,
  } = context;

  return {
    uploadInbox: async (workspaceId: string, file: File, options?: { path?: string }) => {
      const id = workspaceId.trim();
      if (!id) throw new Error("workspaceId is required");
      const form = new FormData();
      form.append("file", file);
      if (options?.path?.trim()) {
        form.append("path", options.path.trim());
      }

      const result = await requestMultipartRaw(baseUrl, `/workspace/${encodeURIComponent(id)}/inbox`, {
        token,
        hostToken,
        method: "POST",
        body: form,
        timeoutMs: binaryTimeoutMs,
      });

      if (!result.ok) {
        let message = result.text.trim();
        try {
          const json = message ? JSON.parse(message) : null;
          if (json && typeof json.message === "string") {
            message = json.message;
          }
        } catch {
          // Ignore invalid JSON and keep the raw response text.
        }
        throw createRequestFailedError(result.status, message || "Inbox upload failed");
      }

      const body = result.text.trim();
      if (body) {
        try {
          const parsed = JSON.parse(body) as Partial<VesloInboxUploadResult>;
          if (typeof parsed.path === "string" && parsed.path.trim()) {
            return {
              ok: parsed.ok ?? true,
              path: parsed.path.trim(),
              bytes: typeof parsed.bytes === "number" ? parsed.bytes : file.size,
            } satisfies VesloInboxUploadResult;
          }
        } catch {
          // Ignore invalid JSON and fall back to a local upload result.
        }
      }

      return {
        ok: true,
        path: options?.path?.trim() || file.name,
        bytes: file.size,
      } satisfies VesloInboxUploadResult;
    },

    listInbox: (workspaceId: string) =>
      requestJson<VesloInboxList>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/inbox`, {
        token,
        hostToken,
      }),

    downloadInboxItem: (workspaceId: string, inboxId: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/inbox/${encodeURIComponent(inboxId)}`,
        { token, hostToken, timeoutMs: binaryTimeoutMs },
      ),

    createSession: (workspaceId: string, options?: { ttlSeconds?: number; write?: boolean }) =>
      requestJson<{ session: VesloFileSession }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/files/sessions`, {
        token,
        hostToken,
        method: "POST",
        body: {
          ...(typeof options?.ttlSeconds === "number" ? { ttlSeconds: options.ttlSeconds } : {}),
          ...(typeof options?.write === "boolean" ? { write: options.write } : {}),
        },
      }),

    renewSession: (sessionId: string, options?: { ttlSeconds?: number }) =>
      requestJson<{ session: VesloFileSession }>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}/renew`, {
        token,
        hostToken,
        method: "POST",
        body: {
          ...(typeof options?.ttlSeconds === "number" ? { ttlSeconds: options.ttlSeconds } : {}),
        },
      }),

    closeSession: (sessionId: string) =>
      requestJson<{ ok: boolean }>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}`, {
        token,
        hostToken,
        method: "DELETE",
      }),

    getCatalogSnapshot: (
      sessionId: string,
      options?: { prefix?: string; after?: string; includeDirs?: boolean; limit?: number },
    ) => {
      const params = new URLSearchParams();
      if (options?.prefix?.trim()) params.set("prefix", options.prefix.trim());
      if (options?.after?.trim()) params.set("after", options.after.trim());
      if (typeof options?.includeDirs === "boolean") params.set("includeDirs", options.includeDirs ? "true" : "false");
      if (typeof options?.limit === "number") params.set("limit", String(options.limit));
      const query = params.toString();
      return requestJson<{
        sessionId: string;
        workspaceId: string;
        generatedAt: number;
        cursor: number;
        total: number;
        truncated: boolean;
        nextAfter?: string;
        items: VesloFileCatalogEntry[];
      }>(
        baseUrl,
        `/files/sessions/${encodeURIComponent(sessionId)}/catalog/snapshot${query ? `?${query}` : ""}`,
        { token, hostToken },
      );
    },

    listSessionEvents: (sessionId: string, options?: { since?: number }) => {
      const query = typeof options?.since === "number" ? `?since=${encodeURIComponent(String(options.since))}` : "";
      return requestJson<{ items: VesloFileSessionEvent[]; cursor: number }>(
        baseUrl,
        `/files/sessions/${encodeURIComponent(sessionId)}/catalog/events${query}`,
        { token, hostToken },
      );
    },

    readBatch: (sessionId: string, paths: string[]) =>
      requestJson<VesloFileReadBatchResult>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}/read-batch`, {
        token,
        hostToken,
        method: "POST",
        body: { paths },
      }),

    writeBatch: (
      sessionId: string,
      writes: Array<{ path: string; contentBase64: string; ifMatchRevision?: string; force?: boolean }>,
    ) =>
      requestJson<VesloFileWriteBatchResult>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}/write-batch`, {
        token,
        hostToken,
        method: "POST",
        body: { writes },
      }),

    runBatchOps: (
      sessionId: string,
      operations: Array<
        | { type: "mkdir"; path: string }
        | { type: "delete"; path: string; recursive?: boolean }
        | { type: "rename"; from: string; to: string }
      >,
    ) =>
      requestJson<VesloFileOpsBatchResult>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}/ops`, {
        token,
        hostToken,
        method: "POST",
        body: { operations },
      }),

    readWorkspaceFile: (workspaceId: string, path: string) =>
      requestJson<VesloWorkspaceFileContent>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(path)}`,
        { token, hostToken },
      ),

    writeWorkspaceFile: (
      workspaceId: string,
      payload: { path: string; content: string; baseUpdatedAt?: number | null; force?: boolean },
    ) =>
      requestJson<VesloWorkspaceFileWriteResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/content`,
        {
          token,
          hostToken,
          method: "POST",
          body: payload,
        },
      ),

    listArtifacts: (workspaceId: string) =>
      requestJson<VesloArtifactList>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/artifacts`, {
        token,
        hostToken,
      }),

    downloadArtifact: (workspaceId: string, artifactId: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}`,
        { token, hostToken, timeoutMs: binaryTimeoutMs },
      ),
  };
}

export type FilesClient = ReturnType<typeof createFilesClient>;
