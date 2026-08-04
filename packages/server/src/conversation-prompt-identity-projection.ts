import type { RecordedPromptIdentityPair } from "./conversation-run-delivery-snapshot-store.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizedText = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

export function projectConversationPromptIdentities(
  messages: unknown[],
  identities: RecordedPromptIdentityPair[],
): unknown[] {
  const identitiesByOpenCodeMessageId = new Map<string, RecordedPromptIdentityPair[]>();
  for (const identity of identities) {
    const opencodeMessageId = normalizedText(identity.opencodeMessageId);
    const clientMessageId = normalizedText(identity.clientMessageId);
    if (!opencodeMessageId || !clientMessageId) continue;
    const recorded = identitiesByOpenCodeMessageId.get(opencodeMessageId) ?? [];
    recorded.push({ opencodeMessageId, clientMessageId });
    identitiesByOpenCodeMessageId.set(opencodeMessageId, recorded);
  }

  return messages.map((message) => {
    if (!isRecord(message) || !isRecord(message.info) || message.info.role !== "user") return message;
    const opencodeMessageId = normalizedText(message.info.id);
    const recorded = identitiesByOpenCodeMessageId.get(opencodeMessageId) ?? [];
    if (recorded.length !== 1) return message;
    return {
      ...message,
      info: {
        ...message.info,
        clientMessageId: recorded[0]!.clientMessageId,
      },
    };
  });
}
