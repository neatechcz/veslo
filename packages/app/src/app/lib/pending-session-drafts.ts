import type { ComposerAttachment } from "../types";
import { normalizeDirectoryPath } from "../utils";
import type { PendingSessionDraftKind } from "./tauri";

const PENDING_DRAFT_KEY_PREFIX = "__pending-draft__:";
const GLOBAL_NEW_PRIVATE_PENDING_DRAFT_KEY = `${PENDING_DRAFT_KEY_PREFIX}new-private`;
const GLOBAL_UNPUBLISHED_COMPOSER_STORAGE_KEY = "__unpublished-composer-draft__:global";
const NO_SESSION_DRAFT_KEY = "__no-session__";
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export const GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID = "pending-global-unpublished";

export const isGlobalUnpublishedPendingDraftSummary = (draft: { id?: string | null }) =>
  (draft.id ?? "").trim() === GLOBAL_UNPUBLISHED_PENDING_DRAFT_ID;

export type PendingDraftIdentityInput = {
  kind: PendingSessionDraftKind;
  workspaceId?: string | null;
  directory?: string | null;
  privateWorkspaceId?: string | null;
};

export type PendingDraftAttachmentPayload = Omit<ComposerAttachment, "dataUrl"> & {
  bytes: number[];
};

const normalizeSessionId = (sessionId: string | null | undefined) => {
  const trimmed = (sessionId ?? "").trim();
  return trimmed || NO_SESSION_DRAFT_KEY;
};

const bytesToBase64 = (bytes: number[]) => {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const chunk = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

    output += BASE64_ALPHABET[(chunk >> 18) & 63];
    output += BASE64_ALPHABET[(chunk >> 12) & 63];
    output += second == null ? "=" : BASE64_ALPHABET[(chunk >> 6) & 63];
    output += third == null ? "=" : BASE64_ALPHABET[chunk & 63];
  }
  return output;
};

export const resolvePendingDraftKey = (input: PendingDraftIdentityInput) => {
  if (input.kind === "new-private") {
    return GLOBAL_NEW_PRIVATE_PENDING_DRAFT_KEY;
  }

  const workspaceId = (input.workspaceId ?? "").trim();
  if (!workspaceId) {
    throw new Error("directory pending drafts require workspaceId");
  }

  const directory = normalizeDirectoryPath(input.directory);
  if (!directory) {
    throw new Error("directory pending drafts require directory");
  }

  return `${PENDING_DRAFT_KEY_PREFIX}directory:${workspaceId}:${directory}`;
};

export const isPendingDraftKey = (value: string | null | undefined) =>
  (value ?? "").trim().startsWith(PENDING_DRAFT_KEY_PREFIX);

export const resolveComposerStorageKey = (input: {
  sessionId?: string | null;
  pendingDraftKey?: string | null;
}) => {
  const pendingDraftKey = (input.pendingDraftKey ?? "").trim();
  if (pendingDraftKey) {
    if (!isPendingDraftKey(pendingDraftKey)) {
      throw new Error("pendingDraftKey must be a pending draft key");
    }
    return GLOBAL_UNPUBLISHED_COMPOSER_STORAGE_KEY;
  }

  return normalizeSessionId(input.sessionId);
};

export const pendingDraftAttachmentPayloadToComposerAttachment = (
  payload: PendingDraftAttachmentPayload,
): ComposerAttachment => ({
  id: payload.id,
  name: payload.name,
  mimeType: payload.mimeType,
  size: payload.size,
  kind: payload.kind,
  dataUrl: `data:${payload.mimeType || "application/octet-stream"};base64,${bytesToBase64(payload.bytes)}`,
});

export const pendingDraftAttachmentPayloadsToComposerAttachments = (
  payloads: PendingDraftAttachmentPayload[],
): ComposerAttachment[] => payloads.map((payload) => pendingDraftAttachmentPayloadToComposerAttachment(payload));
