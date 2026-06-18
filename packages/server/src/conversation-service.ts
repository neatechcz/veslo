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
  }): Promise<{
    workspaceId: string;
    items: ConversationSummary[];
    source: "sqlite" | "unavailable";
  }>;

  resolveOpenCodeSessionForRead(input: {
    workspaceId: string;
    directory: string | null;
    sessionOrConversationId: string;
  }): Promise<ConversationBinding | null>;

  loadTranscript(input: {
    workspace: WorkspaceInfo;
    sessionId: string;
    limit: number;
    directory: string | null;
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

const normalizeNullableText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeTimestamp = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;

const readTimeRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

// Merge two summary lists, deduped by engine session id, preserving order.
// `primary` (the sandbox read, already in its own order) comes first and wins
// on conflict; owned-store entries the sandbox did not return are appended in
// their existing newest-first order. Order is intentionally preserved (not
// re-sorted) so the live-read ordering and existing callers stay stable.
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

export function createConversationService(options: {
  readStore: ConversationReadStore;
  bindingStore: ConversationBindingStore;
  createOpenCodeSession: OpenCodeSessionCreate;
  now?: () => number;
  warn?: LogFn;
}): ConversationService {
  const now = options.now ?? (() => Date.now());
  const warn = options.warn ?? ((message, details) => console.warn(message, details));

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
    directory: string | null;
    sessionOrConversationId: string;
  }) => {
    const workspaceId = normalizeText(input.workspaceId);
    const directory = normalizeText(input.directory);
    const sessionOrConversationId = normalizeText(input.sessionOrConversationId);
    if (!workspaceId || !directory || !sessionOrConversationId) return null;

    try {
      return await options.bindingStore.resolveOpenCodeSession({
        workspaceId,
        directory,
        sessionOrConversationId,
      });
    } catch (error) {
      warn("[veslo-server] conversation binding resolution failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
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

  return {
    async listConversations(input) {
      const result = await options.readStore.listConversations({
        workspaceId: input.workspace.id,
        directory: input.directory,
        workspace: input.workspace,
      });
      // Sandbox-read items get persisted into our owned binding store
      // (tunnel-in) by attachConversationBindings. The owned store is our
      // authoritative, sandbox-independent source. Return the UNION so a
      // partial / empty / unavailable sandbox read can never shrink the
      // sidebar below what we already own — a conversation we have seen once
      // keeps listing even when the sandbox DB is unreachable or its stored
      // directory form does not match the browse path.
      const sandboxItems = result.source === "sqlite" && result.items.length > 0
        ? await attachConversationBindings(input.workspace.id, input.directory, result.items)
        : result.items;
      const ownedItems = await listPersistedBindings(input.workspace.id, input.directory);
      const items = mergeConversationSummaries(sandboxItems, ownedItems);
      return { ...result, items };
    },

    resolveOpenCodeSessionForRead,

    async loadTranscript(input) {
      const binding = await resolveOpenCodeSessionForRead({
        workspaceId: input.workspace.id,
        directory: input.directory,
        sessionOrConversationId: input.sessionId,
      });
      const opencodeSessionId = binding?.engineSessionId ?? input.sessionId;
      const snapshot = await options.readStore.getTranscript({
        workspaceId: input.workspace.id,
        sessionId: opencodeSessionId,
        limit: input.limit,
        directory: input.directory,
        workspace: input.workspace,
      });
      return {
        workspaceId: input.workspace.id,
        sessionId: opencodeSessionId,
        ...(binding?.conversationId ? { conversationId: binding.conversationId } : {}),
        opencodeSessionId,
        limit: snapshot.limit,
        messages: snapshot.messages,
        partsByMessageId: snapshot.partsByMessageId,
        fetchedAt: snapshot.fetchedAt,
        source: snapshot.source,
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
      const engineSessionId = normalizeText(
        typeof record.id === "string" ? record.id : String(record.id ?? ""),
      );
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
