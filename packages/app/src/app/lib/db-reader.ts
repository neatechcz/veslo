import { invoke } from "@tauri-apps/api/core";
import type { Message, Part } from "@opencode-ai/sdk/v2/client";
import type { SidebarSessionItem } from "../types";
import type { VesloSessionTranscriptSnapshot } from "./veslo-server";

// --- DB row types (match Rust #[serde(rename_all = "camelCase")]) ---

type DbSessionRow = {
  id: string;
  title: string;
  directory: string;
  parentId?: string | null;
  timeCreated: number;
  timeUpdated: number;
};

type DbMessageRow = { id: string; sessionId: string; data: string };
type DbPartRow = { id: string; messageId: string; sessionId: string; data: string };
type DbTranscriptResult = { messages: DbMessageRow[]; parts: DbPartRow[] };

const isParsedDbRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// --- Tauri invoke wrappers ---

export async function readSessionsFromDb(directory: string): Promise<DbSessionRow[]> {
  return invoke<DbSessionRow[]>("opencode_db_read_sessions", { directory });
}

export async function readTranscriptFromDb(
  sessionId: string,
  limit?: number,
): Promise<DbTranscriptResult> {
  return invoke<DbTranscriptResult>("opencode_db_read_transcript", {
    sessionId,
    limit: limit ?? null,
  });
}

// --- Conversion helpers ---

export function dbSessionRowToSidebarItem(row: DbSessionRow): SidebarSessionItem {
  return {
    id: row.id,
    title: row.title,
    directory: row.directory,
    parentID: row.parentId ?? null,
    time: {
      created: row.timeCreated,
      updated: row.timeUpdated,
    },
  };
}

export function dbTranscriptToSnapshot(
  sessionId: string,
  workspaceId: string,
  result: DbTranscriptResult,
  limit: number,
): VesloSessionTranscriptSnapshot {
  const messages: Message[] = [];
  for (const row of result.messages) {
    try {
      const parsed = JSON.parse(row.data) as unknown;
      if (!isParsedDbRecord(parsed)) {
        console.warn("[db-reader] skipping non-object message", row.id);
        continue;
      }

      messages.push({
        ...parsed,
        id: typeof parsed.id === "string" && parsed.id.trim() ? parsed.id : row.id,
        sessionID:
          typeof parsed.sessionID === "string" && parsed.sessionID.trim()
            ? parsed.sessionID
            : row.sessionId,
      } as Message);
    } catch {
      console.warn("[db-reader] skipping unparseable message", row.id);
    }
  }

  const partsByMessageId: Record<string, Part[]> = {};
  for (const row of result.parts) {
    try {
      const parsed = JSON.parse(row.data) as unknown;
      if (!isParsedDbRecord(parsed)) {
        console.warn("[db-reader] skipping non-object part", row.id);
        continue;
      }

      const key = row.messageId;
      if (!partsByMessageId[key]) {
        partsByMessageId[key] = [];
      }
      partsByMessageId[key].push({
        ...parsed,
        id: typeof parsed.id === "string" && parsed.id.trim() ? parsed.id : row.id,
        messageID:
          typeof parsed.messageID === "string" && parsed.messageID.trim()
            ? parsed.messageID
            : row.messageId,
        sessionID:
          typeof parsed.sessionID === "string" && parsed.sessionID.trim()
            ? parsed.sessionID
            : row.sessionId,
      } as Part);
    } catch {
      console.warn("[db-reader] skipping unparseable part", row.id);
    }
  }

  return {
    workspaceId,
    sessionId,
    limit,
    messages,
    partsByMessageId,
    fetchedAt: Date.now(),
  };
}
