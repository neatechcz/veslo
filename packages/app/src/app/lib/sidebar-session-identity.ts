import type { SidebarSessionItem } from "../types";
import { normalizeDirectoryPath } from "../utils";

type SidebarSessionIdentityRecord = Pick<
  SidebarSessionItem,
  "id" | "directory" | "conversationId" | "opencodeSessionId"
>;

const normalizeText = (value: string | null | undefined) => value?.trim() ?? "";

const normalizedIdentity = (item: SidebarSessionIdentityRecord) => ({
  id: normalizeText(item.id),
  directory: normalizeDirectoryPath(normalizeText(item.directory)),
  conversationId: normalizeText(item.conversationId),
  opencodeSessionId: normalizeText(item.opencodeSessionId),
});

const hasDurableConversationIdentity = (identity: ReturnType<typeof normalizedIdentity>) =>
  Boolean(identity.conversationId || identity.opencodeSessionId);

export const sidebarSessionIdentityKey = (item: SidebarSessionIdentityRecord) => {
  const identity = normalizedIdentity(item);
  return [
    identity.id,
    identity.directory,
    identity.conversationId,
    identity.opencodeSessionId,
  ].join("\0");
};

const sidebarSessionMergeScore = (
  existing: SidebarSessionIdentityRecord,
  incoming: SidebarSessionIdentityRecord,
) => {
  const left = normalizedIdentity(existing);
  const right = normalizedIdentity(incoming);
  if (!left.id || left.id !== right.id) return -1;
  if (left.conversationId && right.conversationId && left.conversationId !== right.conversationId) return -1;
  if (left.opencodeSessionId && right.opencodeSessionId && left.opencodeSessionId !== right.opencodeSessionId) {
    return -1;
  }
  if (
    left.directory &&
    right.directory &&
    left.directory !== right.directory &&
    hasDurableConversationIdentity(left) &&
    hasDurableConversationIdentity(right)
  ) {
    return -1;
  }

  let score = 1;
  if (left.directory && right.directory && left.directory === right.directory) score += 2;
  if (left.conversationId && right.conversationId && left.conversationId === right.conversationId) score += 4;
  if (left.opencodeSessionId && right.opencodeSessionId && left.opencodeSessionId === right.opencodeSessionId) {
    score += 3;
  }
  if (sidebarSessionIdentityKey(existing) === sidebarSessionIdentityKey(incoming)) score += 10;
  return score;
};

export const findSidebarSessionItemMergeIndex = (
  items: readonly SidebarSessionIdentityRecord[],
  incoming: SidebarSessionIdentityRecord,
) => {
  let bestIndex = -1;
  let bestScore = -1;
  let tied = false;

  items.forEach((item, index) => {
    const score = sidebarSessionMergeScore(item, incoming);
    if (score < 0) return;
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
      tied = false;
      return;
    }
    if (score === bestScore) {
      tied = true;
    }
  });

  return tied ? -1 : bestIndex;
};
