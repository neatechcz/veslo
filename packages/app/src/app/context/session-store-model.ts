import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client";

import type {
  MessageInfo,
  MessageWithParts,
  PlaceholderAssistantMessage,
  SessionErrorTurn,
} from "../types";
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "../types";
import { scopedSessionStatusKey } from "../lib/scoped-session-status";

export function scopedSessionAliasKeys(
  workspaceId: string | null | undefined,
  values: Array<string | null | undefined>,
): string[] {
  const normalizedWorkspaceId = workspaceId?.trim() ?? "";
  const ids = values.map((value) => value?.trim() ?? "").filter(Boolean);
  return [...new Set(ids.map((id) => scopedSessionStatusKey(normalizedWorkspaceId, id) || id))];
}

export function sessionErrorTurnScopeKey(
  workspaceId: string | null | undefined,
  sessionId: string | null | undefined,
): string {
  const id = sessionId?.trim() ?? "";
  if (!id) return "";
  return scopedSessionStatusKey(workspaceId?.trim() ?? "", id) || id;
}

export function readSessionErrorTurnsForScope(
  current: Record<string, SessionErrorTurn[] | undefined>,
  workspaceId: string | null | undefined,
  sessionId: string | null | undefined,
): SessionErrorTurn[] {
  const id = sessionId?.trim() ?? "";
  if (!id) return [];
  const normalizedWorkspaceId = workspaceId?.trim() ?? "";
  const key = sessionErrorTurnScopeKey(normalizedWorkspaceId, id);
  if (normalizedWorkspaceId) return current[key] ?? [];
  return current[id] ?? [];
}

export const sortById = <T extends { id: string }>(list: T[]) =>
  list.slice().sort((a, b) => a.id.localeCompare(b.id));

const messageActivity = (message: { id: string; time?: { created?: number; updated?: number } }) =>
  Number.isFinite(message.time?.created ?? NaN)
    ? message.time!.created!
    : Number.isFinite(message.time?.updated ?? NaN)
      ? message.time!.updated!
      : 0;

export const sortMessagesByActivity = <T extends { id: string; time?: { created?: number; updated?: number } }>(
  list: T[],
) =>
  list
    .slice()
    .sort((a, b) => {
      const delta = messageActivity(a) - messageActivity(b);
      if (delta !== 0) return delta;
      return a.id.localeCompare(b.id);
    });

const sessionActivity = (session: Session) =>
  session.time?.updated ?? session.time?.created ?? 0;

export const sortSessionsByActivity = (list: Session[]) =>
  list
    .slice()
    .sort((a, b) => {
      const delta = sessionActivity(b) - sessionActivity(a);
      if (delta !== 0) return delta;
      return a.id.localeCompare(b.id);
    });

export const formatSlashCommandDisplay = (name: string, args: string) => {
  const cleanName = name.trim().replace(/^\/+/, "");
  if (!cleanName) return "";
  const cleanArgs = args.trim();
  return cleanArgs ? `/${cleanName} ${cleanArgs}` : `/${cleanName}`;
};

export const createPlaceholderMessage = (part: Part): PlaceholderAssistantMessage => ({
  id: part.messageID,
  sessionID: part.sessionID,
  role: "assistant",
  time: { created: Date.now() },
  parentID: "",
  modelID: "",
  providerID: "",
  mode: "",
  agent: "",
  path: { cwd: "", root: "" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

export const upsertSession = (list: Session[], next: Session) => {
  const index = list.findIndex((session) => session.id === next.id);
  if (index === -1) return sortSessionsByActivity([...list, next]);
  const copy = list.slice();
  copy[index] = next;
  return sortSessionsByActivity(copy);
};

export const removeSession = (list: Session[], sessionID: string) =>
  list.filter((session) => session.id !== sessionID);

export const upsertMessageInfo = (list: MessageInfo[], next: MessageInfo) => {
  const index = list.findIndex((message) => message.id === next.id);
  if (index === -1) return sortMessagesByActivity([...list, next]);
  const copy = list.slice();
  copy[index] = next;
  return sortMessagesByActivity(copy);
};

export const removeMessageInfo = (list: MessageInfo[], messageID: string) =>
  list.filter((message) => message.id !== messageID);

export const upsertPartInfo = (list: Part[], next: Part) => {
  const index = list.findIndex((part) => part.id === next.id);
  if (index === -1) return sortById([...list, next]);
  const copy = list.slice();
  copy[index] = next;
  return copy;
};

export const removePartInfo = (list: Part[], partID: string) =>
  list.filter((part) => part.id !== partID);

export function applyCommandDisplayAlias(
  info: MessageInfo,
  parts: Part[],
  alias: string | null | undefined,
): MessageWithParts {
  if (!alias || (info as { role?: string }).role !== "user") {
    return { info, parts };
  }

  const firstText = parts.find((part) => part.type === "text");
  if (firstText) {
    let replaced = false;
    return {
      info,
      parts: parts.map((part) => {
        if (!replaced && part.type === "text") {
          replaced = true;
          return { ...part, text: alias, synthetic: false, ignored: false } as Part;
        }
        return part;
      }),
    };
  }

  const aliasPart = {
    id: `command-display:${info.id}`,
    sessionID: info.sessionID,
    messageID: info.id,
    type: "text",
    text: alias,
    synthetic: false,
    ignored: false,
  } as Part;
  return { info, parts: [aliasPart, ...parts] };
}

export function appendSessionErrorTurnModel(input: {
  current: SessionErrorTurn[] | undefined;
  sessionID: string;
  message: string | null | undefined;
  messages: MessageInfo[];
  runId?: string | null;
  now?: number;
}): SessionErrorTurn[] {
  const text = input.message?.trim() ?? "";
  if (!input.sessionID || !text) return input.current ?? [];

  const existing = input.current ?? [];
  const durableRunId = input.runId?.trim() || null;
  if (durableRunId && existing.some((turn) => turn.durableRunId === durableRunId)) {
    return existing;
  }
  const lastMessage = input.messages.at(-1) ?? null;
  const afterMessageID = lastMessage?.id ?? null;
  const previous = existing.at(-1);
  if (previous && previous.text === text && previous.afterMessageID === afterMessageID) {
    return existing;
  }

  const now = input.now ?? Date.now();
  return existing.concat({
    id: `${SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX}${input.sessionID}:${now}:${existing.length}`,
    text,
    afterMessageID,
    time: now,
    durableRunId,
  });
}

export type { Message, Part, Session };
