import type { Part, Session } from "@opencode-ai/sdk/v2/client";

export const VESLO_INTERNAL_SUBAGENT_PREFIX = "veslo-internal-";

export function isVesloInternalSubagentType(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith(VESLO_INTERNAL_SUBAGENT_PREFIX);
}

export type TaskPartSubagentInfo = {
  isTask: boolean;
  subagentType?: string;
  sessionId?: string;
  internal: boolean;
};

function readTaskChildSessionId(record: Record<string, unknown>): string | undefined {
  const state = record.state && typeof record.state === "object" ? (record.state as Record<string, unknown>) : {};
  const metadata =
    state.metadata && typeof state.metadata === "object"
      ? (state.metadata as Record<string, unknown>)
      : {};

  const rawSessionId =
    metadata.sessionId ??
    metadata.sessionID ??
    state.sessionId ??
    state.sessionID;

  if (typeof rawSessionId !== "string") return undefined;
  const value = rawSessionId.trim();
  return value || undefined;
}

export function getTaskPartSubagentInfo(part: Part): TaskPartSubagentInfo {
  if (part.type !== "tool") return { isTask: false, internal: false };

  const record = part as unknown as Record<string, unknown>;
  const tool = typeof record.tool === "string" ? record.tool.trim().toLowerCase() : "";
  if (tool !== "task") return { isTask: false, internal: false };

  const state = record.state && typeof record.state === "object" ? (record.state as Record<string, unknown>) : {};
  const input = state.input && typeof state.input === "object" ? (state.input as Record<string, unknown>) : {};
  const subagentType =
    typeof input.subagent_type === "string" && input.subagent_type.trim()
      ? input.subagent_type.trim()
      : undefined;

  return {
    isTask: true,
    subagentType,
    sessionId: readTaskChildSessionId(record),
    internal: isVesloInternalSubagentType(subagentType),
  };
}

export function sessionLooksLikeInternalSubagent(session: Session | Record<string, unknown>): boolean {
  const record = session as unknown as Record<string, unknown>;
  const candidateValues = [
    record.agent,
    record.subagentType,
    record.subagent_type,
    record.name,
    record.title,
  ];

  for (const value of candidateValues) {
    if (isVesloInternalSubagentType(value)) {
      return true;
    }
  }

  const metadata = record.metadata && typeof record.metadata === "object"
    ? (record.metadata as Record<string, unknown>)
    : {};
  if (isVesloInternalSubagentType(metadata.subagent_type)) {
    return true;
  }

  return false;
}
