export type ConversationRunDeliveryPresentation =
  | "visible_output"
  | "hidden_progress"
  | "no_visible_output"
  | "unknown";

type DeliveryMessage = { id: string; role?: string | null };
type DeliveryPart = { type?: string | null; text?: unknown };

/**
 * Classifies the already-projected terminal state. This is evidence only: it
 * does not decide which progress parts the UI renders or collapses.
 */
export function classifyConversationRunDeliveryPresentation(input: {
  assistantMessageIds: Array<string | null | undefined>;
  messagesBySession: Record<string, DeliveryMessage[] | undefined>;
  partsByMessageId: Record<string, DeliveryPart[] | undefined>;
}): ConversationRunDeliveryPresentation {
  let hasAssistantProgress = false;
  const assistantMessageIds = new Set(
    input.assistantMessageIds
      .map((value) => value?.trim() ?? "")
      .filter(Boolean),
  );
  if (assistantMessageIds.size === 0) return "unknown";
  for (const messages of Object.values(input.messagesBySession)) {
    for (const message of messages ?? []) {
      if (message.role !== "assistant" || !assistantMessageIds.has(message.id)) continue;
      const parts = input.partsByMessageId[message.id] ?? [];
      if (parts.length > 0) hasAssistantProgress = true;
      if (parts.some((part) => part.type === "text" && typeof part.text === "string" && part.text.trim())) {
        return "visible_output";
      }
    }
  }
  return hasAssistantProgress ? "hidden_progress" : "no_visible_output";
}
