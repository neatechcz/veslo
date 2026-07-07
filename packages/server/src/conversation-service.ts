import type { WorkspaceInfo } from "./types.js";
import { ApiError } from "./errors.js";
import type {
  ConversationReadStore,
  ConversationSummary,
} from "./conversation-read-store.js";
import type {
  ConversationBinding,
  ConversationBindingStore,
} from "./conversation-binding-store.js";
import { deterministicConversationId } from "./conversation-binding-store.js";
import type {
  ConversationTranscriptStore,
  TranscriptMessageInput,
} from "./conversation-transcript-store.js";

type LogFn = (message: string, details?: Record<string, unknown>) => void;

type OpenCodeSessionCreateInput = {
  workspace: WorkspaceInfo;
  directory: string | null;
  title?: string | null;
  sendTraceId?: string | null;
};

export type OpenCodeSessionCreate = (
  input: OpenCodeSessionCreateInput,
) => Promise<unknown>;

export type ConversationCreateResult = Record<string, unknown> & {
  workspaceId: string;
  id: string;
  conversationId: string;
  opencodeSessionId: string;
  parentConversationId: string | null;
  branchId: string | null;
  title: string;
  slug: string;
  directory: string;
  parentID: string | null;
  time: {
    created: number;
    updated: number;
  };
};

export type ConversationTranscriptResult = {
  workspaceId: string;
  sessionId: string;
  conversationId?: string;
  opencodeSessionId: string;
  limit: number;
  messages: unknown[];
  partsByMessageId: Record<string, unknown[]>;
  fetchedAt?: number;
  staleAt?: number;
  source?: "sqlite" | "unavailable";
};

export type ConversationService = {
  listConversations(input: {
    workspace: WorkspaceInfo;
    directory: string | null;
    sync?: boolean;
  }): Promise<{
    workspaceId: string;
    items: ConversationSummary[];
    source: "sqlite" | "unavailable";
  }>;

  resolveOpenCodeSessionForRead(input: {
    workspaceId: string;
    workspace?: WorkspaceInfo | null;
    directory: string | null;
    sessionOrConversationId: string;
  }): Promise<ConversationBinding | null>;

  loadTranscript(input: {
    workspace: WorkspaceInfo;
    sessionId: string;
    limit: number;
    directory: string | null;
  }): Promise<ConversationTranscriptResult>;

  appendTranscript(input: {
    workspace: WorkspaceInfo;
    sessionId: string;
    directory: string | null;
    limit?: number;
    messages: unknown[];
    partsByMessageId: Record<string, unknown[]>;
    deletedMessageIds?: string[];
    deletedPartsByMessageId?: Record<string, string[]>;
  }): Promise<ConversationTranscriptResult>;

  createConversation(input: {
    workspace: WorkspaceInfo;
    directory: string | null;
    title?: string | null;
    sendTraceId?: string | null;
  }): Promise<ConversationCreateResult>;

  importOpenCodeSessions(input: {
    workspace: WorkspaceInfo;
    directory: string | null;
    sessions: Array<{
      id: string;
      title?: string | null;
      parentID?: string | null;
      time?: {
        created?: number | null;
        updated?: number | null;
      } | null;
    }>;
  }): Promise<{
    workspaceId: string;
    items: ConversationSummary[];
  }>;
};

const normalizeText = (value: string | null | undefined) => value?.trim() ?? "";

const isVesloConversationId = (value: string) =>
  /^conv-[0-9a-f]{20}$/i.test(value.trim());

type ConversationReadTarget =
  | { kind: "conversation"; conversationId: string }
  | { kind: "engine-session"; engineSessionId: string };

const conversationReadTarget = (value: string): ConversationReadTarget | null => {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  return isVesloConversationId(normalized)
    ? { kind: "conversation", conversationId: normalized }
    : { kind: "engine-session", engineSessionId: normalized };
};

const conversationReadTargetValue = (target: ConversationReadTarget): string =>
  target.kind === "conversation" ? target.conversationId : target.engineSessionId;

const normalizeNullableText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const normalizeTimestamp = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;

const readTimeRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

// Merge two summary lists, deduped by engine session id. The primary list
// keeps ordering/title freshness from the currently synced source; host rows
// fill any gaps that the source did not return.
const mergeConversationSummaries = (
  primary: ConversationSummary[],
  secondary: ConversationSummary[],
): ConversationSummary[] => {
  const seen = new Set<string>();
  const merged: ConversationSummary[] = [];
  for (const item of [...primary, ...secondary]) {
    const id = normalizeText(item.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(item);
  }
  return merged;
};

const normalizeStringList = (values: string[] | null | undefined): string[] => {
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const normalized = normalizeText(value);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
};

const normalizeStringListRecord = (value: Record<string, string[]> | null | undefined): Record<string, string[]> => {
  const result: Record<string, string[]> = {};
  for (const [rawKey, rawValues] of Object.entries(value ?? {})) {
    const key = normalizeText(rawKey);
    const values = normalizeStringList(rawValues);
    if (key && values.length > 0) result[key] = values;
  }
  return result;
};

export function createConversationService(options: {
  readStore: ConversationReadStore;
  bindingStore: ConversationBindingStore;
  transcriptStore?: ConversationTranscriptStore;
  createOpenCodeSession: OpenCodeSessionCreate;
  now?: () => number;
  warn?: LogFn;
}): ConversationService {
  const now = options.now ?? (() => Date.now());
  const warn = options.warn ?? ((message, details) => console.warn(message, details));

  const conversationBindingUnavailableError = (
    workspaceId: string,
    directory: string,
    sessionOrConversationId: string,
    error: unknown,
  ) =>
    new ApiError(503, "conversation_binding_unavailable", "Conversation binding is unavailable", {
      workspaceId,
      directory,
      sessionOrConversationId,
      error: errorMessage(error),
    });

  const fallbackItems = (
    workspaceId: string,
    directory: string,
    items: ConversationSummary[],
  ) =>
    items.map((item) => ({
      ...item,
      conversationId: deterministicConversationId({
        workspaceId,
        directory,
        engineSessionId: item.id,
      }),
      opencodeSessionId: item.id,
      parentConversationId: item.parentID
        ? deterministicConversationId({
            workspaceId,
            directory,
            engineSessionId: item.parentID,
          })
        : null,
      branchId: null,
    }));

  const attachConversationBindings = async (
    workspaceId: string,
    directory: string | null,
    items: ConversationSummary[],
  ): Promise<ConversationSummary[]> => {
    const normalizedDirectory = normalizeText(directory);
    if (!normalizeText(workspaceId) || !normalizedDirectory || items.length === 0) return items;

    try {
      const bindings = await options.bindingStore.bindOpenCodeSessions({
        workspaceId,
        directory: normalizedDirectory,
        sessions: items.map((item) => ({
          engineSessionId: item.id,
          title: item.title,
          parentEngineSessionId: item.parentID,
          createdAt: item.time.created,
          updatedAt: item.time.updated,
        })),
      });

      return items.map((item) => {
        const binding = bindings.get(item.id);
        return {
          ...item,
          conversationId:
            binding?.conversationId ??
            deterministicConversationId({
              workspaceId,
              directory: normalizedDirectory,
              engineSessionId: item.id,
            }),
          opencodeSessionId: item.id,
          parentConversationId:
            binding?.parentConversationId ??
            (item.parentID
              ? deterministicConversationId({
                  workspaceId,
                  directory: normalizedDirectory,
                  engineSessionId: item.parentID,
                })
              : null),
          branchId: binding?.branchId ?? null,
        };
      });
    } catch (error) {
      warn("[veslo-server] conversation binding persistence failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return fallbackItems(workspaceId, normalizedDirectory, items);
    }
  };

  const resolveOpenCodeSessionForRead = async (input: {
    workspaceId: string;
    workspace?: WorkspaceInfo | null;
    directory: string | null;
    sessionOrConversationId: string;
  }) => {
    const workspaceId = normalizeText(input.workspaceId);
    const directory = normalizeText(input.directory);
    const target = conversationReadTarget(input.sessionOrConversationId);
    if (!workspaceId || !directory || !target) return null;
    const sessionOrConversationId = conversationReadTargetValue(target);

    try {
      const binding = await options.bindingStore.resolveOpenCodeSession({
        workspaceId,
        directory,
        sessionOrConversationId,
      });
      if (binding || target.kind === "conversation") return binding;

      const source = await options.readStore.listConversations({
        workspaceId,
        directory,
        workspace: input.workspace ?? null,
      });
      if (source.source !== "sqlite") return null;

      const session = source.items.find((item) => normalizeText(item.id) === target.engineSessionId);
      if (!session) return null;

      return await options.bindingStore.bindOpenCodeSession({
        workspaceId,
        directory,
        engineSessionId: session.id,
        title: session.title,
        parentEngineSessionId: session.parentID,
        createdAt: session.time.created,
        updatedAt: session.time.updated,
      });
    } catch (error) {
      warn("[veslo-server] conversation binding resolution failed", {
        workspaceId,
        error: errorMessage(error),
      });
      throw conversationBindingUnavailableError(workspaceId, directory, sessionOrConversationId, error);
    }
  };

  const bindingToSummary = (binding: ConversationBinding): ConversationSummary => ({
    id: binding.engineSessionId,
    conversationId: binding.conversationId,
    opencodeSessionId: binding.engineSessionId,
    title: binding.title ?? binding.engineSessionId,
    slug: binding.title ?? binding.engineSessionId,
    directory: binding.directory,
    parentID: binding.parentEngineSessionId,
    parentConversationId: binding.parentConversationId,
    branchId: binding.branchId,
    time: {
      created: binding.createdAt,
      updated: binding.updatedAt,
    },
  });

  const listPersistedBindings = async (
    workspaceId: string,
    directory: string | null,
  ): Promise<ConversationSummary[]> => {
    const normalizedDirectory = normalizeText(directory);
    if (!normalizeText(workspaceId) || !normalizedDirectory) return [];
    try {
      const bindings = await options.bindingStore.listOpenCodeSessions({
        workspaceId,
        directory: normalizedDirectory,
      });
      return bindings.map(bindingToSummary);
    } catch (error) {
      warn("[veslo-server] conversation binding list failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  };

  const snapshotToTranscriptMessages = (
    messages: unknown[],
    partsByMessageId: Record<string, unknown[]>,
  ): TranscriptMessageInput[] => {
    const result: TranscriptMessageInput[] = [];
    for (const raw of messages) {
      const record = isRecord(raw) ? raw : {};
      const id = normalizeText(typeof record.id === "string" ? record.id : "");
      if (!id) continue;
      const timeRecord = readTimeRecord(record.time);
      const parts = (partsByMessageId[id] ?? [])
        .map((part) => {
          const partRecord = isRecord(part) ? part : {};
          return {
            id: normalizeText(typeof partRecord.id === "string" ? partRecord.id : ""),
            type: typeof partRecord.type === "string" ? partRecord.type : null,
            payload: part,
          };
        })
        .filter((part) => part.id);
      result.push({
        id,
        role: typeof record.role === "string" ? record.role : null,
        createdAt: typeof timeRecord.created === "number" ? timeRecord.created : null,
        updatedAt: typeof timeRecord.updated === "number" ? timeRecord.updated : null,
        payload: raw,
        parts,
      });
    }
    return result;
  };

  const readPersistedTranscript = async (
    workspaceId: string,
    directory: string | null,
    engineSessionId: string,
    limit: number,
  ) => {
    if (!options.transcriptStore) return null;
    try {
      return await options.transcriptStore.getTranscript({ workspaceId, directory, engineSessionId, limit });
    } catch (error) {
      warn("[veslo-server] conversation transcript read failed", {
        workspaceId,
        error: errorMessage(error),
      });
      return null;
    }
  };

  const persistTranscriptSnapshot = async (
    workspaceId: string,
    directory: string | null,
    engineSessionId: string,
    messages: unknown[],
    partsByMessageId: Record<string, unknown[]>,
  ) => {
    if (!options.transcriptStore) return;
    try {
      await options.transcriptStore.appendTranscript({
        workspaceId,
        directory,
        engineSessionId,
        messages: snapshotToTranscriptMessages(messages, partsByMessageId),
      });
    } catch (error) {
      warn("[veslo-server] conversation transcript persist failed", {
        workspaceId,
        error: errorMessage(error),
      });
    }
  };

  return {
    async listConversations(input) {
      // Host-first listing. The owned host-side store (on the main OS) is the
      // source of truth for the sidebar list. If we already own conversations
      // for this workspace, serve them directly and NEVER reach into the
      // workspace's sandbox (WSL) opencode.db — passively listing an inactive
      // workspace must not spin up or touch WSL. The sandbox is read only to
      // *seed* the host store the first time it is empty for this workspace
      // (typically while the workspace is active); after that every later list
      // is host-only. Ingestion sandbox -> host also happens while active via
      // createConversation and importOpenCodeSessions (sidebar live backfill),
      // so the host store stays populated without re-reading the sandbox.
      const ownedItems = await listPersistedBindings(input.workspace.id, input.directory);
      if (ownedItems.length > 0 && input.sync !== true) {
        return { workspaceId: input.workspace.id, items: ownedItems, source: "sqlite" as const };
      }

      let result: Awaited<ReturnType<ConversationReadStore["listConversations"]>>;
      try {
        result = await options.readStore.listConversations({
          workspaceId: input.workspace.id,
          directory: input.directory,
          workspace: input.workspace,
        });
      } catch (error) {
        if (ownedItems.length > 0) {
          warn("[veslo-server] conversation sync read failed; serving host bindings", {
            workspaceId: input.workspace.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return { workspaceId: input.workspace.id, items: ownedItems, source: "sqlite" as const };
        }
        throw error;
      }
      // Host store empty -> seed it. Explicit sync -> read the active source
      // once and union it with host rows so gaps get tunneled into the host DB.
      const sourceItems = result.source === "sqlite" && result.items.length > 0
        ? await attachConversationBindings(input.workspace.id, input.directory, result.items)
        : result.items;
      const items = ownedItems.length > 0
        ? mergeConversationSummaries(sourceItems, ownedItems)
        : sourceItems;
      return {
        ...result,
        source: items.length > 0 ? "sqlite" as const : result.source,
        items,
      };
    },

    resolveOpenCodeSessionForRead,

    async loadTranscript(input) {
      const binding = await resolveOpenCodeSessionForRead({
        workspaceId: input.workspace.id,
        workspace: input.workspace,
        directory: input.directory,
        sessionOrConversationId: input.sessionId,
      });
      const requestedSessionId = normalizeText(input.sessionId);
      const directory = normalizeText(input.directory);
      if (!binding && isVesloConversationId(requestedSessionId)) {
        throw new ApiError(404, "conversation_not_found", "Conversation was not found in this workspace");
      }
      if (!binding && !directory) {
        throw new ApiError(400, "invalid_directory", "Conversation directory is required");
      }
      const opencodeSessionId = binding?.engineSessionId ?? requestedSessionId;
      const workspaceId = input.workspace.id;
      const conversationIdField = binding?.conversationId
        ? { conversationId: binding.conversationId }
        : {};

      // Host-first: serve the transcript from our durable host store. Only when
      // the host has nothing for this session do we read the sandbox/engine
      // opencode.db, then tunnel what we find back into the host store so every
      // later read is host-only (survives sandbox reset and app restart).
      const host = await readPersistedTranscript(workspaceId, input.directory, opencodeSessionId, input.limit);
      if (host) {
        return {
          workspaceId,
          sessionId: opencodeSessionId,
          ...conversationIdField,
          opencodeSessionId,
          limit: input.limit,
          messages: host.messages,
          partsByMessageId: host.partsByMessageId,
          fetchedAt: now(),
          source: "sqlite" as const,
        };
      }

      const snapshot = await options.readStore.getTranscript({
        workspaceId,
        sessionId: opencodeSessionId,
        limit: input.limit,
        directory: input.directory,
        workspace: input.workspace,
      });
      if (snapshot.source === "sqlite") {
        await persistTranscriptSnapshot(
          workspaceId,
          input.directory,
          opencodeSessionId,
          snapshot.messages,
          snapshot.partsByMessageId,
        );
      }
      return {
        workspaceId,
        sessionId: opencodeSessionId,
        ...conversationIdField,
        opencodeSessionId,
        limit: snapshot.limit,
        messages: snapshot.messages,
        partsByMessageId: snapshot.partsByMessageId,
        fetchedAt: snapshot.fetchedAt,
        source: snapshot.source,
      };
    },

    async appendTranscript(input) {
      if (!options.transcriptStore) {
        throw new ApiError(503, "transcript_store_unavailable", "Conversation transcript store is unavailable");
      }

      const workspaceId = normalizeText(input.workspace.id);
      const directory = normalizeText(input.directory);
      const sessionId = normalizeText(input.sessionId);
      if (!workspaceId || !directory || !sessionId) {
        throw new ApiError(400, "invalid_payload", "workspace, directory, and sessionId are required");
      }
      if (!Array.isArray(input.messages)) {
        throw new ApiError(400, "invalid_payload", "messages must be an array");
      }
      const deletedMessageIds = normalizeStringList(input.deletedMessageIds);
      const deletedPartsByMessageId = normalizeStringListRecord(input.deletedPartsByMessageId);

      const binding = await resolveOpenCodeSessionForRead({
        workspaceId,
        workspace: input.workspace,
        directory,
        sessionOrConversationId: sessionId,
      });
      if (!binding) {
        throw new ApiError(404, "conversation_not_found", "Conversation was not found in this workspace");
      }
      const opencodeSessionId = binding.engineSessionId;
      const limit = Number.isFinite(input.limit ?? Number.NaN) && (input.limit ?? 0) > 0
        ? Math.floor(input.limit as number)
        : Math.max(input.messages.length, deletedMessageIds.length, 1);
      const conversationIdField = binding.conversationId
        ? { conversationId: binding.conversationId }
        : {};

      await options.transcriptStore.appendTranscript({
        workspaceId,
        directory,
        engineSessionId: opencodeSessionId,
        messages: snapshotToTranscriptMessages(input.messages, input.partsByMessageId),
        deletedMessageIds,
        deletedPartsByMessageId,
      });

      const host = await readPersistedTranscript(workspaceId, directory, opencodeSessionId, limit);
      return {
        workspaceId,
        sessionId: opencodeSessionId,
        ...conversationIdField,
        opencodeSessionId,
        limit,
        messages: host?.messages ?? input.messages,
        partsByMessageId: host?.partsByMessageId ?? input.partsByMessageId,
        fetchedAt: now(),
        source: "sqlite" as const,
      };
    },

    async createConversation(input) {
      const workspaceId = normalizeText(input.workspace.id);
      const directory = normalizeText(input.directory);
      if (!workspaceId || !directory) {
        throw new ApiError(400, "invalid_directory", "Conversation directory is required");
      }

      const created = await options.createOpenCodeSession({
        workspace: input.workspace,
        directory,
        title: input.title,
        sendTraceId: input.sendTraceId ?? null,
      });
      const record = isRecord(created) ? created : {};
      const engineSessionId = normalizeText(typeof record.id === "string" ? record.id : "");
      if (!engineSessionId) {
        throw new ApiError(502, "opencode_failed", "OpenCode session did not return an id");
      }

      const timeRecord = readTimeRecord(record.time);
      const createdAt = normalizeTimestamp(timeRecord.created, now());
      const updatedAt = normalizeTimestamp(timeRecord.updated, createdAt);
      const title = normalizeText(
        typeof record.title === "string" ? record.title : input.title ?? "",
      ) || engineSessionId;
      const slug = normalizeText(
        typeof record.slug === "string" ? record.slug : title,
      ) || title;
      const parentEngineSessionId = normalizeNullableText(record.parentID);

      const binding = await options.bindingStore.bindOpenCodeSession({
        workspaceId,
        directory,
        engineSessionId,
        title,
        parentEngineSessionId,
        createdAt,
        updatedAt,
      });

      return {
        ...record,
        workspaceId,
        id: engineSessionId,
        title,
        slug,
        directory,
        parentID: parentEngineSessionId,
        time: {
          ...timeRecord,
          created: createdAt,
          updated: updatedAt,
        },
        conversationId: binding.conversationId,
        opencodeSessionId: binding.engineSessionId,
        parentConversationId: binding.parentConversationId,
        branchId: binding.branchId,
      };
    },

    async importOpenCodeSessions(input) {
      const workspaceId = normalizeText(input.workspace.id);
      const directory = normalizeText(input.directory);
      if (!workspaceId || !directory) {
        throw new ApiError(400, "invalid_directory", "Conversation directory is required");
      }

      const sessions = input.sessions
        .map((session) => {
          const engineSessionId = normalizeText(session.id);
          if (!engineSessionId) return null;
          const title = normalizeNullableText(session.title) ?? engineSessionId;
          const parentEngineSessionId = normalizeNullableText(session.parentID);
          const createdAt = normalizeTimestamp(session.time?.created, now());
          const updatedAt = normalizeTimestamp(session.time?.updated, createdAt);
          return {
            engineSessionId,
            title,
            parentEngineSessionId,
            createdAt,
            updatedAt,
          };
        })
        .filter((session): session is NonNullable<typeof session> => Boolean(session));

      if (sessions.length === 0) return { workspaceId, items: [] };

      const bindings = await options.bindingStore.bindOpenCodeSessions({
        workspaceId,
        directory,
        sessions,
      });

      return {
        workspaceId,
        items: sessions
          .map((session) => bindings.get(session.engineSessionId))
          .filter((binding): binding is ConversationBinding => Boolean(binding))
          .map(bindingToSummary),
      };
    },
  };
}
