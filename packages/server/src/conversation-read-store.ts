import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type ConversationSummary = {
  id: string;
  conversationId?: string;
  opencodeSessionId?: string;
  title: string;
  slug?: string;
  directory: string;
  parentID: string | null;
  parentConversationId?: string | null;
  branchId?: string | null;
  time: {
    created: number;
    updated: number;
  };
};

export type ConversationTranscriptSnapshot = {
  workspaceId: string;
  sessionId: string;
  limit: number;
  messages: unknown[];
  partsByMessageId: Record<string, unknown[]>;
  fetchedAt: number;
};

export type ConversationReadDiagnosticReason =
  | "missing_scope"
  | "database_missing"
  | "schema_unavailable"
  | "session_not_found"
  | "malformed_json";

export type ConversationReadDiagnostic = {
  reason: ConversationReadDiagnosticReason;
  workspaceId?: string;
  directory?: string | null;
  sessionId?: string | null;
  missing?: Array<"workspaceId" | "directory" | "sessionId">;
  dbPath?: string | null;
  dbPathExists?: boolean;
  directoryVariantCount?: number;
  message?: string;
  invalidMessageJsonRows?: number;
  invalidPartJsonRows?: number;
  messageRowCount?: number;
  partRowCount?: number;
};

export type ConversationReadStore = {
  listConversations(input: {
    workspaceId: string;
    directory: string | null;
    workspace?: ConversationReadWorkspace | null;
  }): Promise<{
    workspaceId: string;
    items: ConversationSummary[];
    source: "sqlite" | "unavailable";
    diagnostic?: ConversationReadDiagnostic;
  }>;
  getTranscript(input: {
    workspaceId: string;
    sessionId: string;
    limit: number;
    directory: string | null;
    workspace?: ConversationReadWorkspace | null;
  }): Promise<ConversationTranscriptSnapshot & {
    source: "sqlite" | "unavailable";
    diagnostic?: ConversationReadDiagnostic;
  }>;
};

export type ConversationReadWorkspace = {
  id?: string;
  path?: string;
  directory?: string;
  opencodeDbPath?: string;
  opencodeDataDir?: string;
  opencodeDataHome?: string;
  opencode?: {
    dbPath?: string;
    dataDir?: string;
    dataHome?: string;
    xdgDataHome?: string;
  };
};

type SessionRow = {
  id: string;
  title: string | null;
  directory: string | null;
  parent_id: string | null;
  time_created: number | null;
  time_updated: number | null;
};

type MessageRow = {
  id: string;
  session_id: string;
  data: string | null;
};

type PartRow = {
  id: string;
  message_id: string | null;
  session_id: string;
  data: string | null;
};

const normalizeId = (value: string | null | undefined) => value?.trim() ?? "";

function normalizeWindowsExtendedPath(value: string): string {
  return value.replace(/^\\\\\?\\/, "").replace(/^\/\/\?\//, "");
}

function isWslMountPath(value: string): boolean {
  return /^\/mnt\/[a-z](?:\/|$)/i.test(value.replace(/\\/g, "/"));
}

function wslMountPathToWindowsPath(value: string): string | null {
  const match = value.replace(/\\/g, "/").match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (!match) return null;
  const drive = match[1]?.toUpperCase();
  if (!drive) return null;
  const rest = (match[2] ?? "").replace(/\//g, "\\");
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
}

function windowsPathToWslMountPath(value: string): string | null {
  const normalized = normalizeWindowsExtendedPath(value).replace(/\\/g, "/");
  const match = normalized.match(/^([A-Za-z]):(?:\/(.*))?$/);
  if (!match) return null;
  const drive = match[1]?.toLowerCase();
  if (!drive) return null;
  const rest = match[2]?.replace(/^\/+/, "").replace(/\/+$/, "") ?? "";
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
}

function shouldUseWindowsDirectoryLookup(value: string): boolean {
  return /^\\\\\?\\/.test(value) ||
    /^\/\/\?\//.test(value) ||
    /^[a-z]:[\\/]/i.test(value) ||
    /^\\\\[^\\]/.test(value) ||
    value.includes("\\") ||
    isWslMountPath(value);
}

function directoryLookupVariants(value: string, windowsLookup: boolean): string[] {
  const normalized = normalizeId(value);
  if (!normalized) return [];

  const variants = new Set<string>();
  const add = (candidate: string) => {
    const next = normalizeId(candidate);
    if (next) variants.add(next);
  };

  add(normalized);
  if (!windowsLookup) return [...variants];

  const withoutExtendedPrefix = normalizeWindowsExtendedPath(normalized);
  add(withoutExtendedPrefix);
  add(withoutExtendedPrefix.toLowerCase());
  add(`\\\\?\\${withoutExtendedPrefix}`);
  add(`//?/${withoutExtendedPrefix.replace(/\\/g, "/")}`);

  const backslash = withoutExtendedPrefix.replace(/\//g, "\\");
  add(backslash);
  add(backslash.toLowerCase());

  const slash = withoutExtendedPrefix.replace(/\\/g, "/");
  add(slash);
  add(slash.toLowerCase());
  const wslMount = windowsPathToWslMountPath(slash);
  if (wslMount) {
    add(wslMount);
    add(wslMount.toLowerCase());
  }
  const windowsFromWsl = wslMountPathToWindowsPath(slash);
  if (windowsFromWsl) {
    add(windowsFromWsl);
    add(windowsFromWsl.toLowerCase());
    add(windowsFromWsl.replace(/\\/g, "/"));
    add(windowsFromWsl.replace(/\\/g, "/").toLowerCase());
  }

  return [...variants];
}

function numberedInClause(
  column: string,
  startIndex: number,
  count: number,
): string {
  return count > 0
    ? `${column} IN (${Array.from(
        { length: count },
        (_, index) => `?${startIndex + index}`,
      ).join(", ")})`
    : "1 = 0";
}

function directoryMatchClause(
  column: string,
  startIndex: number,
  directCount: number,
  lowerCount: number,
): string {
  if (directCount <= 0 && lowerCount <= 0) return "1 = 0";
  const clauses = [numberedInClause(column, startIndex, directCount)];
  if (lowerCount > 0) {
    clauses.push(
      numberedInClause(`LOWER(${column})`, startIndex + directCount, lowerCount),
    );
  }
  return `(${clauses.join(" OR ")})`;
}

function directoryLookupArgs(directory: string): {
  directories: string[];
  lowerDirectories: string[];
} {
  const windowsLookup = shouldUseWindowsDirectoryLookup(directory);
  const directories = directoryLookupVariants(directory, windowsLookup);
  return {
    directories,
    lowerDirectories: windowsLookup ? directories.map((item) => item.toLowerCase()) : [],
  };
}

const envSuffixForWorkspace = (workspaceId: string) =>
  workspaceId.trim().replace(/[^A-Za-z0-9]/g, "_").toUpperCase();

const envForWorkspace = (workspaceId: string, key: string) => {
  const suffix = envSuffixForWorkspace(workspaceId);
  return process.env[`${key}_${suffix}`]?.trim() ?? "";
};

function resolveOpenCodeDbPath(input: {
  workspaceId: string;
  workspace?: ConversationReadWorkspace | null;
}): string | null {
  const workspaceId = normalizeId(input.workspaceId);
  const workspace = input.workspace ?? null;
  const explicit =
    (workspaceId ? envForWorkspace(workspaceId, "VESLO_OPENCODE_DB_PATH") : "") ||
    workspace?.opencodeDbPath?.trim() ||
    workspace?.opencode?.dbPath?.trim() ||
    process.env.VESLO_OPENCODE_DB_PATH?.trim() ||
    process.env.OPENCODE_DB_PATH?.trim() ||
    "";
  if (explicit) return resolve(explicit);

  const dataDir =
    (workspaceId ? envForWorkspace(workspaceId, "VESLO_OPENCODE_DATA_DIR") : "") ||
    workspace?.opencodeDataDir?.trim() ||
    workspace?.opencode?.dataDir?.trim() ||
    process.env.VESLO_OPENCODE_DATA_DIR?.trim() ||
    process.env.OPENCODE_DATA_DIR?.trim() ||
    "";
  if (dataDir) return join(resolve(dataDir), "opencode.db");

  const dataHome =
    (workspaceId ? envForWorkspace(workspaceId, "VESLO_OPENCODE_XDG_DATA_HOME") : "") ||
    workspace?.opencodeDataHome?.trim() ||
    workspace?.opencode?.dataHome?.trim() ||
    workspace?.opencode?.xdgDataHome?.trim() ||
    process.env.VESLO_OPENCODE_XDG_DATA_HOME?.trim() ||
    process.env.XDG_DATA_HOME?.trim() ||
    "";
  if (dataHome) return join(dataHome, "opencode", "opencode.db");

  const workspaceLocalDb = workspace?.path ? join(workspace.path, ".opencode", "opencode.db") : "";
  if (workspaceLocalDb && existsSync(workspaceLocalDb)) return workspaceLocalDb;

  const home = homedir();
  if (!home) return null;
  return join(home, ".local", "share", "opencode", "opencode.db");
}

type OpenReadOnlyDatabaseResult =
  | { db: Database; dbPath: string; diagnostic?: undefined }
  | { db: null; dbPath: string | null; diagnostic: ConversationReadDiagnostic };

function openReadOnlyDatabase(input: {
  workspaceId: string;
  directory?: string | null;
  sessionId?: string | null;
  workspace?: ConversationReadWorkspace | null;
}): OpenReadOnlyDatabaseResult {
  const workspaceId = normalizeId(input.workspaceId);
  const dbPath = resolveOpenCodeDbPath(input);
  const exists = Boolean(dbPath && existsSync(dbPath));
  if (!dbPath || !exists) {
    return {
      db: null,
      dbPath,
      diagnostic: {
        reason: "database_missing",
        workspaceId,
        directory: input.directory ?? null,
        sessionId: input.sessionId ?? null,
        dbPath,
        dbPathExists: false,
      },
    };
  }
  return { db: new Database(dbPath, { readonly: true }), dbPath };
}

function isOpenCodeReadSchemaUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table:\s*(session|message|part)\b/i.test(message) ||
    /no such column:\s*(session|message|part)\./i.test(message) ||
    /no such column:\s*(id|title|directory|parent_id|time_created|time_updated|session_id|data|message_id)\b/i.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type JsonParseCounters = {
  invalidMessageJsonRows: number;
  invalidPartJsonRows: number;
};

function parseJsonRecord(
  raw: string | null,
  fallback: Record<string, unknown>,
  onInvalidJson?: () => void,
): Record<string, unknown> | null {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
    return parsed as Record<string, unknown>;
  } catch {
    onInvalidJson?.();
    return null;
  }
}

function normalizeMessage(row: MessageRow, counters?: JsonParseCounters): Record<string, unknown> | null {
  const parsed = parseJsonRecord(row.data, {}, () => {
    if (counters) counters.invalidMessageJsonRows += 1;
  });
  if (!parsed) return null;
  return {
    ...parsed,
    id: typeof parsed.id === "string" && parsed.id.trim() ? parsed.id : row.id,
    sessionID:
      typeof parsed.sessionID === "string" && parsed.sessionID.trim()
        ? parsed.sessionID
        : row.session_id,
  };
}

function normalizePart(row: PartRow, counters?: JsonParseCounters): Record<string, unknown> | null {
  const parsed = parseJsonRecord(row.data, {}, () => {
    if (counters) counters.invalidPartJsonRows += 1;
  });
  if (!parsed) return null;
  const messageId =
    typeof parsed.messageID === "string" && parsed.messageID.trim()
      ? parsed.messageID
      : row.message_id ?? "";
  return {
    ...parsed,
    id: typeof parsed.id === "string" && parsed.id.trim() ? parsed.id : row.id,
    messageID: messageId,
    sessionID:
      typeof parsed.sessionID === "string" && parsed.sessionID.trim()
        ? parsed.sessionID
        : row.session_id,
  };
}

export function createConversationReadStore(): ConversationReadStore {
  return {
    async listConversations(input) {
      const workspaceId = normalizeId(input.workspaceId);
      const directory = input.directory?.trim() ?? "";
      if (!workspaceId || !directory) {
        return {
          workspaceId,
          items: [],
          source: "unavailable",
          diagnostic: {
            reason: "missing_scope",
            workspaceId,
            directory: directory || null,
            missing: [
              ...(!workspaceId ? ["workspaceId" as const] : []),
              ...(!directory ? ["directory" as const] : []),
            ],
          },
        };
      }

      const opened = openReadOnlyDatabase({ workspaceId, directory, workspace: input.workspace });
      if (!opened.db) {
        return { workspaceId, items: [], source: "unavailable", diagnostic: opened.diagnostic };
      }
      const { db, dbPath } = opened;

      try {
        const { directories, lowerDirectories } = directoryLookupArgs(directory);
        const rows = db
          .query<SessionRow, Array<string>>(
            "SELECT id, title, directory, parent_id, time_created, time_updated " +
              `FROM session WHERE ${directoryMatchClause(
                "directory",
                1,
                directories.length,
                lowerDirectories.length,
              )} ` +
              "ORDER BY time_updated DESC",
          )
          .all(...directories, ...lowerDirectories);

        return {
          workspaceId,
          source: "sqlite",
          items: rows.map((row) => ({
            id: row.id,
            title: row.title ?? row.id,
            slug: row.title ?? row.id,
            directory: row.directory ?? directory,
            parentID: row.parent_id ?? null,
            time: {
              created: Number(row.time_created ?? 0),
              updated: Number(row.time_updated ?? 0),
            },
          })),
        };
      } catch (error) {
        if (isOpenCodeReadSchemaUnavailableError(error)) {
          return {
            workspaceId,
            items: [],
            source: "unavailable",
            diagnostic: {
              reason: "schema_unavailable",
              workspaceId,
              directory,
              dbPath,
              dbPathExists: true,
              message: errorMessage(error),
            },
          };
        }
        throw error;
      } finally {
        db.close();
      }
    },

    async getTranscript(input) {
      const workspaceId = normalizeId(input.workspaceId);
      const sessionId = normalizeId(input.sessionId);
      const directory = input.directory?.trim() ?? "";
      const limit = Number.isFinite(input.limit) && input.limit > 0 ? Math.floor(input.limit) : 140;
      const empty = {
        workspaceId,
        sessionId,
        limit,
        messages: [],
        partsByMessageId: {},
        fetchedAt: Date.now(),
      };

      if (!workspaceId || !sessionId || !directory) {
        return {
          ...empty,
          source: "unavailable",
          diagnostic: {
            reason: "missing_scope",
            workspaceId,
            sessionId,
            directory: directory || null,
            missing: [
              ...(!workspaceId ? ["workspaceId" as const] : []),
              ...(!sessionId ? ["sessionId" as const] : []),
              ...(!directory ? ["directory" as const] : []),
            ],
          },
        };
      }

      const opened = openReadOnlyDatabase({ workspaceId, directory, sessionId, workspace: input.workspace });
      if (!opened.db) return { ...empty, source: "unavailable", diagnostic: opened.diagnostic };
      const { db, dbPath } = opened;

      try {
        const { directories, lowerDirectories } = directoryLookupArgs(directory);
        const session = db
          .query<{ id: string }, Array<string>>(
            `SELECT id FROM session WHERE id = ?1 AND ${directoryMatchClause(
              "directory",
              2,
              directories.length,
              lowerDirectories.length,
            )} LIMIT 1`,
          )
          .get(sessionId, ...directories, ...lowerDirectories);
        // Session row not found under this directory (e.g. the stored
        // directory form differs from the browse path). This is "could not
        // locate", not "empty conversation" — report unavailable so the app
        // does not render a misleading empty transcript as a finished read.
        if (!session) {
          return {
            ...empty,
            source: "unavailable",
            diagnostic: {
              reason: "session_not_found",
              workspaceId,
              sessionId,
              directory,
              dbPath,
              dbPathExists: true,
              directoryVariantCount: directories.length + lowerDirectories.length,
            },
          };
        }

        const messageRows = db
          .query<MessageRow, [string, number]>(
            "SELECT id, session_id, data FROM message " +
              "WHERE session_id = ?1 ORDER BY id ASC LIMIT ?2",
          )
          .all(sessionId, limit);
        const partRows = db
          .query<PartRow, [string]>(
            "SELECT id, message_id, session_id, data FROM part " +
              "WHERE session_id = ?1 ORDER BY id ASC",
          )
          .all(sessionId);

        const counters: JsonParseCounters = {
          invalidMessageJsonRows: 0,
          invalidPartJsonRows: 0,
        };
        const messages = messageRows
          .map((row) => normalizeMessage(row, counters))
          .filter((message): message is Record<string, unknown> => Boolean(message));
        const messageIds = new Set(
          messages
            .map((message) => (typeof message.id === "string" ? message.id.trim() : ""))
            .filter(Boolean),
        );
        const partsByMessageId: Record<string, unknown[]> = {};
        for (const row of partRows) {
          const part = normalizePart(row, counters);
          if (!part) continue;
          const messageId = typeof part.messageID === "string" ? part.messageID.trim() : "";
          if (!messageId || !messageIds.has(messageId)) continue;
          if (!partsByMessageId[messageId]) partsByMessageId[messageId] = [];
          partsByMessageId[messageId].push(part);
        }

        return {
          workspaceId,
          sessionId,
          limit,
          messages,
          partsByMessageId,
          fetchedAt: Date.now(),
          source: "sqlite",
          ...((counters.invalidMessageJsonRows > 0 || counters.invalidPartJsonRows > 0)
            ? {
                diagnostic: {
                  reason: "malformed_json" as const,
                  workspaceId,
                  sessionId,
                  directory,
                  dbPath,
                  dbPathExists: true,
                  invalidMessageJsonRows: counters.invalidMessageJsonRows,
                  invalidPartJsonRows: counters.invalidPartJsonRows,
                  messageRowCount: messageRows.length,
                  partRowCount: partRows.length,
                },
              }
            : {}),
        };
      } catch (error) {
        if (isOpenCodeReadSchemaUnavailableError(error)) {
          return {
            ...empty,
            source: "unavailable",
            diagnostic: {
              reason: "schema_unavailable",
              workspaceId,
              sessionId,
              directory,
              dbPath,
              dbPathExists: true,
              message: errorMessage(error),
            },
          };
        }
        throw error;
      } finally {
        db.close();
      }
    },
  };
}
