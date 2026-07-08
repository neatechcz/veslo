import type { Part, Session } from "@opencode-ai/sdk/v2/client";

const VESLO_INTERNAL_SUBAGENT_PREFIX = "veslo-internal-";

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

const SESSION_ID_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeSessionCandidate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readSessionIdCandidates(record: Record<string, unknown>): string[] {
  const values = [
    record.sessionId,
    record.sessionID,
    record.session_id,
    record.childSessionId,
    record.childSessionID,
    record.child_session_id,
  ];

  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeSessionCandidate(value);
    if (normalized) out.push(normalized);
  }
  return out;
}

function looksLikeSessionId(value: string): boolean {
  return value.startsWith("ses_") || SESSION_ID_UUID_PATTERN.test(value);
}

function readTaskChildSessionId(record: Record<string, unknown>): string | undefined {
  const state = record.state && typeof record.state === "object" ? (record.state as Record<string, unknown>) : {};
  const metadata =
    state.metadata && typeof state.metadata === "object"
      ? (state.metadata as Record<string, unknown>)
      : {};
  const output =
    state.output && typeof state.output === "object"
      ? (state.output as Record<string, unknown>)
      : {};
  const partMetadata =
    record.metadata && typeof record.metadata === "object"
      ? (record.metadata as Record<string, unknown>)
      : {};

  // Prefer explicit tool result payload first, then metadata, then legacy state fields.
  const candidates = [
    ...readSessionIdCandidates(output),
    ...readSessionIdCandidates(metadata),
    ...readSessionIdCandidates(state),
    ...readSessionIdCandidates(partMetadata),
  ];
  if (candidates.length === 0) return undefined;

  const sessionLike = candidates.find((candidate) => looksLikeSessionId(candidate));
  return sessionLike ?? candidates[0];
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
