import type { PendingSubmittedDraft } from "./pending-submit-model";
import { remapPendingSubmittedSession } from "./pending-submit-model";
import { parseUiConversationKey } from "../../lib/ui-conversation-scope";

const PENDING_SESSION_INSTANCE_PREFIX = "pending-session:";

export type PendingSessionInstanceId = `${typeof PENDING_SESSION_INSTANCE_PREFIX}${string}`;

export type PendingSessionInstance = {
  id: PendingSessionInstanceId;
  sessionKey: string;
  workspaceId: string;
  workspaceRoot: string;
  title: string;
  createdAt: number;
  realSessionId?: string | null;
};

export type PendingSubmittedDraftBySessionKey = Record<string, PendingSubmittedDraft>;

const sanitizePendingSessionInstanceSuffix = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "");

const createDefaultPendingSessionInstanceSuffix = () =>
  sanitizePendingSessionInstanceSuffix(
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`,
  );

export const isPendingSessionInstanceId = (
  value: string | null | undefined,
): value is PendingSessionInstanceId => {
  const id = (value ?? "").trim();
  return (
    id.startsWith(PENDING_SESSION_INSTANCE_PREFIX) &&
    id.slice(PENDING_SESSION_INSTANCE_PREFIX.length) !== ""
  );
};

export function pendingSessionInstanceIdFromKey(
  value: string | null | undefined,
): PendingSessionInstanceId | null {
  const key = (value ?? "").trim();
  if (isPendingSessionInstanceId(key)) return key;

  const parsed = parseUiConversationKey(key);
  if (parsed?.kind !== "pending-session") return null;
  return isPendingSessionInstanceId(parsed.id) ? parsed.id : null;
}

export const isPendingSessionInstanceKey = (value: string | null | undefined) =>
  Boolean(pendingSessionInstanceIdFromKey(value));

export const createPendingSessionInstanceId = (
  uuid: string | (() => string) = createDefaultPendingSessionInstanceSuffix,
): PendingSessionInstanceId => {
  const value = typeof uuid === "function" ? uuid() : uuid;
  const suffix = sanitizePendingSessionInstanceSuffix(value) || createDefaultPendingSessionInstanceSuffix();
  return `${PENDING_SESSION_INSTANCE_PREFIX}${suffix}`;
};

export function pendingSessionKeyForInstance(id: PendingSessionInstanceId): string {
  return id;
}

export function createPendingSessionInstance(input: {
  id: PendingSessionInstanceId;
  workspaceId: string;
  workspaceRoot: string;
  title: string;
  createdAt: number;
}): PendingSessionInstance {
  return {
    id: input.id,
    sessionKey: pendingSessionKeyForInstance(input.id),
    workspaceId: input.workspaceId.trim(),
    workspaceRoot: input.workspaceRoot.trim(),
    title: input.title.trim(),
    createdAt: input.createdAt,
    realSessionId: null,
  };
}

export function selectPendingSubmittedDraft(
  current: PendingSubmittedDraftBySessionKey,
  sessionKey: string | null | undefined,
): PendingSubmittedDraft | null {
  const key = (sessionKey ?? "").trim();
  return key ? current[key] ?? null : null;
}

export function setPendingSubmittedDraftForKey(
  current: PendingSubmittedDraftBySessionKey,
  sessionKey: string,
  draft: PendingSubmittedDraft,
): PendingSubmittedDraftBySessionKey {
  const key = sessionKey.trim();
  if (!key) return current;
  return { ...current, [key]: { ...draft, sessionKey: key } };
}

export function removePendingSubmittedDraftForKey(
  current: PendingSubmittedDraftBySessionKey,
  sessionKey: string,
  submittedDraftId: string,
): PendingSubmittedDraftBySessionKey {
  const key = sessionKey.trim();
  const id = submittedDraftId.trim();
  if (!key || !id || current[key]?.id !== id) return current;
  const { [key]: _removed, ...rest } = current;
  return rest;
}

export function materializePendingSessionInstance(
  current: PendingSubmittedDraftBySessionKey,
  input: {
    pendingSessionKey: string;
    realSessionKey: string;
    realSessionId: string;
  },
): PendingSubmittedDraftBySessionKey {
  const pendingKey = input.pendingSessionKey.trim();
  const realKey = input.realSessionKey.trim();
  const realSessionId = input.realSessionId.trim();
  if (!pendingSessionInstanceIdFromKey(pendingKey) || !realKey || !realSessionId || pendingKey === realKey) {
    return current;
  }

  const pending = current[pendingKey];
  if (!pending) return current;

  const { [pendingKey]: _removed, ...rest } = current;
  return {
    ...rest,
    [realKey]: {
      ...remapPendingSubmittedSession(pending, realSessionId),
      sessionKey: realKey,
    },
  };
}
