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

type ProgressMessageBlock = {
  kind: "message";
  message: MessageWithParts;
  renderableParts: Part[];
  groups: MessageGroup[];
  isUser: boolean;
  messageId: string;
};

type ProgressGroupBlock = {
  kind: "progress-group";
  id: string;
  items: ProgressGroupItem[];
  messageIds: string[];
  isUser: false;
};

export type ProgressRenderBlock = ProgressMessageBlock | ProgressGroupBlock;

export type ProgressRenderBlockEntry = {
  key: string;
  block: ProgressRenderBlock;
  unstable: boolean;
};

export function shouldAutoExpandProgressGroup(input: {
  isStreaming: boolean;
  blockIndex: number;
  blockCount: number;
}): boolean {
  return (
    input.isStreaming &&
    input.blockCount > 0 &&
    input.blockIndex === input.blockCount - 1
  );
}

const contentFreeFingerprint = (value: unknown) => {
  let source = "";
  try {
    source = JSON.stringify(value) ?? "";
  } catch {
    source = String(value ?? "");
  }
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash) ^ source.charCodeAt(index);
  }
  return `${source.length}:${hash >>> 0}`;
};

/**
 * Content-free fingerprint of exactly the transcript data consumed by the
 * current progress grouping model. It is diagnostic only, never cache truth.
 */
export const progressGroupingInputFingerprint = (messages: readonly MessageWithParts[]) =>
  messages
    .map((message, index) => {
      const info = message.info as unknown as Record<string, unknown>;
      const messageId = typeof info.id === "string" && info.id ? info.id : `idx:${index}`;
      const parts = message.parts.map((part) => {
        const record = part as unknown as Record<string, unknown>;
        return `${String(record.id ?? "")}\u0000${String(record.type ?? "")}\u0000${contentFreeFingerprint(part)}`;
      });
      return `${messageId}\u0000${String(info.role ?? "")}\u0000${parts.join("\u0001")}`;
    })
    .join("\u0002");

/** A separate content-free representation of the produced block model. */
export const progressRenderBlockShapeFingerprint = (blocks: readonly ProgressRenderBlock[]) =>
  blocks.map((block) => {
    if (block.kind === "progress-group") {
      return [
        "progress",
        block.id,
        ...block.items.map((item) => item.kind === "steps"
          ? `steps:${item.id}:${item.parts.map((part) => contentFreeFingerprint(part)).join(",")}`
          : `comment:${item.id}:${contentFreeFingerprint(item.part)}`),
      ].join("\u0000");
    }
    return [
      "message",
      block.messageId,
      ...block.groups.map((group) => group.kind === "steps"
        ? `steps:${group.id}:${group.parts.map((part) => contentFreeFingerprint(part)).join(",")}`
        : `text:${group.segment}:${contentFreeFingerprint(group.part)}`),
    ].join("\u0000");
  }).join("\u0001");

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

export function progressRenderBlockKey(block: ProgressRenderBlock): string | null {
  const id = (block.kind === "progress-group" ? block.id : block.messageId).trim();
  if (!id) return null;
  return block.kind === "progress-group" ? `progress:${id}` : `message:${id}`;
}

export function progressRenderBlockEntries(blocks: readonly ProgressRenderBlock[]): ProgressRenderBlockEntry[] {
  const preferredKeys = blocks.map(progressRenderBlockKey);
  const preferredKeyCounts = new Map<string, number>();
  preferredKeys.forEach((key) => {
    if (!key) return;
    preferredKeyCounts.set(key, (preferredKeyCounts.get(key) ?? 0) + 1);
  });

  return blocks.map((block, index) => {
    const preferredKey = preferredKeys[index];
    if (preferredKey && preferredKeyCounts.get(preferredKey) === 1) {
      return { key: preferredKey, block, unstable: false };
    }
    return {
      key: `unstable:${block.kind}:${index}`,
      block,
      unstable: true,
    };
  });
}

const messageIdFor = (message: MessageWithParts, fallback: string) => {
  const id = (message.info as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id : fallback;
};

function renderablePartsForProgressMessage(
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

function isRenderableAttachment(part: Part) {
  if (part.type !== "file") return false;
  const url = (part as { url?: unknown }).url;
  return typeof url === "string" && !url.startsWith("file://");
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
  // A safe attachment intentionally does not become a text group, but the
  // message row still owns its visual attachment chip. Keep attachment-only
  // user messages in the render model instead of dropping canonical history.
  const hasRenderableAttachment = renderableParts.some(isRenderableAttachment);
  if (!groups.length && !hasRenderableAttachment) return null;
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
  const anchorId = messageIds[0] ?? "group";
  return {
    kind: "progress-group",
    id: `progress-${anchorId}`,
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
