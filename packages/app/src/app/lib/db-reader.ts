import { invoke } from "@tauri-apps/api/core";
import type { Message, Part } from "@opencode-ai/sdk/v2/client";
import type { SidebarSessionItem } from "../types";
import type { VesloSessionTranscriptSnapshot } from "./veslo-server";

// --- DB row types (match Rust #[serde(rename_all = "camelCase")]) ---

type DbSessionRow = {
  id: string;
  title: string;
  directory: string;
  timeCreated: number;
  timeUpdated: number;
};

type DbMessageRow = { id: string; sessionId: string; data: string };
type DbPartRow = { id: string; messageId: string; sessionId: string; data: string };
type DbTranscriptResult = { messages: DbMessageRow[]; parts: DbPartRow[] };

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
      const parsed = JSON.parse(row.data) as Message;
      if (parsed?.id) {
        messages.push(parsed);
      }
    } catch {
      console.warn("[db-reader] skipping unparseable message", row.id);
    }
  }

  const partsByMessageId: Record<string, Part[]> = {};
  for (const row of result.parts) {
    try {
      const parsed = JSON.parse(row.data) as Part;
      if (parsed?.id) {
        const key = row.messageId;
        if (!partsByMessageId[key]) {
          partsByMessageId[key] = [];
        }
        partsByMessageId[key].push(parsed);
      }
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
