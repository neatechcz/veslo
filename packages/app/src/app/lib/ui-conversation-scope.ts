export type UiConversationKeyKind =
  | "session"
  | "pending-session"
  | "pending-draft"
  | "pending-workspace";

export type UiConversationKeyParts = {
  workspaceId: string;
  kind: UiConversationKeyKind;
  id: string;
  workspaceRoot?: string;
  directory?: string;
  conversationId?: string;
  opencodeSessionId?: string;
};

export type UiConversationRef = {
  workspaceId: string;
  workspaceRoot: string;
  directory: string;
  sessionId: string | null;
  conversationId?: string | null;
  opencodeSessionId?: string | null;
  key: string;
};

export type UiScopeToken = UiConversationRef & {
  generation: number;
};

const KEY_PREFIX = "ws";
const SCOPED_KEY_PREFIX = "ws2";
const DEFAULT_WORKSPACE_ID = "default";
const DEFAULT_PENDING_ID = "active";

const normalize = (value: string | null | undefined) => value?.trim() ?? "";

/**
 * Each conversation key encodes six or seven parts, and the sidebar builds one
 * per row on every render. The distinct values are a small, stable set —
 * workspace ids, roots, directories, session ids — so encoding them repeatedly
 * was pure waste: a captured profile attributed 383 ms of main-thread time to
 * this call. The cache is bounded and cleared wholesale, since these keys live
 * as long as the workspaces they name.
 */
const ENCODED_KEY_PART_CACHE_LIMIT = 4096;
const encodedKeyParts = new Map<string, string>();

const encodeKeyPart = (value: string) => {
  const cached = encodedKeyParts.get(value);
  if (cached !== undefined) return cached;
  const encoded = encodeURIComponent(value);
  if (encodedKeyParts.size >= ENCODED_KEY_PART_CACHE_LIMIT) encodedKeyParts.clear();
  encodedKeyParts.set(value, encoded);
  return encoded;
};

const decodeKeyPart = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export function createUiConversationKey(input: {
  workspaceId?: string | null;
  workspaceRoot?: string | null;
  directory?: string | null;
  conversationId?: string | null;
  opencodeSessionId?: string | null;
  kind: UiConversationKeyKind;
  id?: string | null;
}) {
  const workspaceId = normalize(input.workspaceId) || DEFAULT_WORKSPACE_ID;
  const id = normalize(input.id) || DEFAULT_PENDING_ID;
  const workspaceRoot = normalize(input.workspaceRoot);
  const directory = normalize(input.directory);
  const conversationId = normalize(input.conversationId);
  const opencodeSessionId = normalize(input.opencodeSessionId);
  if (workspaceRoot || directory || conversationId || opencodeSessionId) {
    return [
      SCOPED_KEY_PREFIX,
      encodeKeyPart(workspaceId),
      input.kind,
      encodeKeyPart(id),
      encodeKeyPart(workspaceRoot),
      encodeKeyPart(directory),
      encodeKeyPart(conversationId),
      encodeKeyPart(opencodeSessionId),
    ].join(":");
  }
  return [
    KEY_PREFIX,
    encodeKeyPart(workspaceId),
    input.kind,
    encodeKeyPart(id),
  ].join(":");
}

export function parseUiConversationKey(value: string | null | undefined): UiConversationKeyParts | null {
  const key = normalize(value);
  if (!key) return null;
  const parts = key.split(":");
  if (parts[0] !== KEY_PREFIX && parts[0] !== SCOPED_KEY_PREFIX) return null;
  if (parts[0] === KEY_PREFIX && parts.length !== 4) return null;
  if (parts[0] === SCOPED_KEY_PREFIX && parts.length !== 8) return null;
  const kind = parts[2] ?? "";
  if (
    kind !== "session" &&
    kind !== "pending-session" &&
    kind !== "pending-draft" &&
    kind !== "pending-workspace"
  ) {
    return null;
  }
  return {
    workspaceId: decodeKeyPart(parts[1] ?? ""),
    kind: kind as UiConversationKeyKind,
    id: decodeKeyPart(parts[3] ?? ""),
    ...(parts[0] === SCOPED_KEY_PREFIX
      ? {
          workspaceRoot: decodeKeyPart(parts[4] ?? ""),
          directory: decodeKeyPart(parts[5] ?? ""),
          conversationId: decodeKeyPart(parts[6] ?? ""),
          opencodeSessionId: decodeKeyPart(parts[7] ?? ""),
        }
      : {}),
  };
}

export function sessionIdFromUiConversationKey(value: string | null | undefined) {
  const parsed = parseUiConversationKey(value);
  if (!parsed) return null;
  return parsed.kind === "session" ? parsed.id : null;
}

export function isPendingUiConversationKey(value: string | null | undefined) {
  const parsed = parseUiConversationKey(value);
  return Boolean(parsed && parsed.kind !== "session");
}

export function createUiScopeToken(
  ref: Omit<UiConversationRef, "key"> & { key?: string | null },
  generation: number,
): UiScopeToken {
  const workspaceId = normalize(ref.workspaceId);
  const sessionId = normalize(ref.sessionId);
  const key =
    normalize(ref.key) ||
    createUiConversationKey({
      workspaceId,
      workspaceRoot: ref.workspaceRoot,
      directory: ref.directory,
      conversationId: ref.conversationId,
      opencodeSessionId: ref.opencodeSessionId,
      kind: sessionId ? "session" : "pending-workspace",
      id: sessionId || DEFAULT_PENDING_ID,
    });

  return {
    workspaceId,
    workspaceRoot: normalize(ref.workspaceRoot),
    directory: normalize(ref.directory) || normalize(ref.workspaceRoot),
    sessionId: sessionId || null,
    conversationId: normalize(ref.conversationId) || null,
    opencodeSessionId: normalize(ref.opencodeSessionId) || null,
    key,
    generation,
  };
}
