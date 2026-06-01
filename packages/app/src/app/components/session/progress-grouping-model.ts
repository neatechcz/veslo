import type { Part } from "@opencode-ai/sdk/v2/client";

import type { MessageGroup, MessageWithParts, StepGroupMode } from "../../types";
import { groupMessageParts, isUserVisiblePart } from "../../utils";

export type ProgressStepItem = {
  kind: "steps";
  id: string;
  parts: Part[];
  mode: StepGroupMode;
  messageId: string;
};

export type ProgressCommentItem = {
  kind: "comment";
  id: string;
  part: Part;
  messageId: string;
};

export type ProgressGroupItem = ProgressStepItem | ProgressCommentItem;

export type ProgressMessageBlock = {
  kind: "message";
  message: MessageWithParts;
  renderableParts: Part[];
  groups: MessageGroup[];
  isUser: boolean;
  messageId: string;
};

export type ProgressGroupBlock = {
  kind: "progress-group";
  id: string;
  items: ProgressGroupItem[];
  messageIds: string[];
  isUser: false;
};

export type ProgressRenderBlock = ProgressMessageBlock | ProgressGroupBlock;

export type BuildProgressRenderBlocksInput = {
  messages: MessageWithParts[];
  isStreaming?: boolean;
  developerMode: boolean;
  showThinking: boolean;
};

type AssistantGroupEntry = {
  group: MessageGroup;
  message: MessageWithParts;
  messageId: string;
};

const messageIdFor = (message: MessageWithParts, fallback: string) => {
  const id = (message.info as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id : fallback;
};

export function renderablePartsForProgressMessage(
  message: MessageWithParts,
  options: { developerMode: boolean; showThinking: boolean },
): Part[] {
  return message.parts.filter((part) => {
    if (!options.developerMode && !isUserVisiblePart(part)) {
      return false;
    }

    if (part.type === "step-start" || part.type === "step-finish") {
      return false;
    }

    if (part.type === "reasoning") {
      return options.showThinking;
    }

    if (part.type === "text" || part.type === "tool" || part.type === "agent" || part.type === "file") {
      return true;
    }

    return options.developerMode;
  });
}

function messageBlock(
  message: MessageWithParts,
  groups: MessageGroup[],
  messageId: string,
  isUser: boolean,
): ProgressMessageBlock {
  const renderableParts = groups.flatMap((group) => {
    if (group.kind === "text") return [group.part];
    return group.parts;
  });

  return {
    kind: "message",
    message,
    renderableParts,
    groups,
    isUser,
    messageId,
  };
}

function messageBlockFromMessage(
  message: MessageWithParts,
  index: number,
  options: { developerMode: boolean; showThinking: boolean },
): ProgressMessageBlock | null {
  const renderableParts = renderablePartsForProgressMessage(message, options);
  if (!renderableParts.length) return null;
  const messageId = messageIdFor(message, `idx:${index}`);
  const groups = groupMessageParts(renderableParts, messageId, { showThinking: options.showThinking });
  if (!groups.length) return null;
  return messageBlock(message, groups, messageId, (message.info as { role?: unknown }).role === "user");
}

function assistantEntriesFromMessage(
  message: MessageWithParts,
  index: number,
  options: { developerMode: boolean; showThinking: boolean },
): AssistantGroupEntry[] {
  const renderableParts = renderablePartsForProgressMessage(message, options);
  if (!renderableParts.length) return [];
  const messageId = messageIdFor(message, `idx:${index}`);
  const groups = groupMessageParts(renderableParts, messageId, { showThinking: options.showThinking });
  return groups.map((group) => ({ group, message, messageId }));
}

function textContent(part: Part): string {
  if (part.type === "text") return String((part as { text?: unknown }).text ?? "");
  if (part.type === "file") {
    const record = part as { label?: unknown; path?: unknown; filename?: unknown; url?: unknown };
    return String(record.label ?? record.path ?? record.filename ?? record.url ?? "");
  }
  if (part.type === "agent") {
    const name = (part as { name?: unknown }).name;
    return typeof name === "string" ? name : "agent";
  }
  return "";
}

function isVisibleCommentEntry(entry: AssistantGroupEntry): boolean {
  if (entry.group.kind !== "text") return false;
  return textContent(entry.group.part).trim().length > 0;
}

function progressItemFromEntry(entry: AssistantGroupEntry, itemIndex: number): ProgressGroupItem | null {
  if (entry.group.kind === "steps") {
    return {
      kind: "steps",
      id: entry.group.id,
      parts: entry.group.parts,
      mode: entry.group.mode,
      messageId: entry.messageId,
    };
  }

  if (!textContent(entry.group.part).trim()) return null;
  const record = entry.group.part as { id?: unknown };
  const partId = typeof record.id === "string" && record.id.trim()
    ? record.id
    : `${entry.messageId}:comment:${itemIndex}`;
  return {
    kind: "comment",
    id: partId,
    part: entry.group.part,
    messageId: entry.messageId,
  };
}

function finalAnswerStartIndex(entries: AssistantGroupEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (isVisibleCommentEntry(entries[index]!)) return index;
  }
  return -1;
}

function progressGroupFromEntries(entries: AssistantGroupEntry[]): ProgressGroupBlock | null {
  const items = entries
    .map((entry, index) => progressItemFromEntry(entry, index))
    .filter((item): item is ProgressGroupItem => item !== null);
  if (!items.length) return null;

  const messageIds = Array.from(new Set(items.map((item) => item.messageId).filter(Boolean)));
  return {
    kind: "progress-group",
    id: `progress-${messageIds.join("-") || "group"}`,
    items,
    messageIds,
    isUser: false,
  };
}

function messageBlocksFromFinalEntries(entries: AssistantGroupEntry[]): ProgressMessageBlock[] {
  const grouped = new Map<string, AssistantGroupEntry[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.messageId) ?? [];
    list.push(entry);
    grouped.set(entry.messageId, list);
  }

  return Array.from(grouped.values()).map((list) => {
    const first = list[0]!;
    return messageBlock(
      first.message,
      list.map((entry) => entry.group),
      first.messageId,
      false,
    );
  });
}

function flushAssistantTurn(output: ProgressRenderBlock[], entries: AssistantGroupEntry[]) {
  if (!entries.length) return;

  const finalStart = finalAnswerStartIndex(entries);
  if (finalStart === -1) {
    const group = progressGroupFromEntries(entries);
    if (group) output.push(group);
    return;
  }

  const progressEntries = entries.slice(0, finalStart);
  const finalEntries = entries.slice(finalStart);
  const group = progressGroupFromEntries(progressEntries);
  if (group) output.push(group);
  output.push(...messageBlocksFromFinalEntries(finalEntries));
}

export function buildProgressRenderBlocks(input: BuildProgressRenderBlocksInput): ProgressRenderBlock[] {
  const output: ProgressRenderBlock[] = [];
  let assistantTurn: AssistantGroupEntry[] = [];

  const flush = () => {
    flushAssistantTurn(output, assistantTurn);
    assistantTurn = [];
  };

  input.messages.forEach((message, index) => {
    const isUser = (message.info as { role?: unknown }).role === "user";
    if (isUser) {
      flush();
      const block = messageBlockFromMessage(message, index, input);
      if (block) output.push(block);
      return;
    }

    assistantTurn.push(...assistantEntriesFromMessage(message, index, input));
  });

  flush();
  return output;
}
