import type { Part } from "@opencode-ai/sdk/v2/client";

import type { ComposerDraft, ComposerPart, MessageWithParts } from "../../types";

export type EditableUserMessageDraft = {
  messageId: string;
  draft: ComposerDraft;
};

const READ_ONLY_TOOLS = new Set(["read", "list", "grep", "glob", "webfetch", "search"]);

function isAllowedPostUserPart(part: Part): boolean {
  if (part.type === "reasoning") return true;
  if (part.type !== "tool") return false;
  const tool = String((part as { tool?: string }).tool ?? "").toLowerCase();
  return READ_ONLY_TOOLS.has(tool);
}

const partString = (part: Part, key: string): string => {
  const value = (part as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
};

const reconstructComposerDraft = (message: MessageWithParts): ComposerDraft | null => {
  const parts: ComposerPart[] = [];
  const visibleText: string[] = [];
  const resolvedText: string[] = [];

  for (const part of message.parts) {
    if (part.type === "text") {
      const text = partString(part, "text");
      parts.push({ type: "text", text });
      visibleText.push(text);
      resolvedText.push(text);
      continue;
    }

    if (part.type === "agent") {
      const name = partString(part, "name");
      if (!name) return null;
      parts.push({ type: "agent", name });
      visibleText.push(`@${name}`);
      resolvedText.push(`@${name}`);
      continue;
    }

    if (part.type === "file") {
      const path = partString(part, "path");
      if (!path) return null;
      const label = partString(part, "label") || undefined;
      parts.push({ type: "file", path, label });
      visibleText.push(`@${label ?? path}`);
      resolvedText.push(`@${path}`);
      continue;
    }

    return null;
  }

  const text = visibleText.join("");

  return {
    mode: "prompt",
    parts,
    attachments: [],
    text,
    resolvedText: resolvedText.join(""),
  };
};

export function getEditableUserMessageDraft(input: {
  messages: MessageWithParts[];
  sessionIdle: boolean;
  queueEmpty: boolean;
  composerEmpty: boolean;
}): EditableUserMessageDraft | null {
  if (!input.sessionIdle || !input.queueEmpty || !input.composerEmpty) return null;

  let messageIndex = -1;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    if (input.messages[index]!.info.role === "user") {
      messageIndex = index;
      break;
    }
  }
  if (messageIndex === -1) return null;

  const message = input.messages[messageIndex]!;
  const followingMessages = input.messages.slice(messageIndex + 1);
  for (const followingMessage of followingMessages) {
    if (followingMessage.info.role !== "assistant") return null;
    if (!followingMessage.parts.every(isAllowedPostUserPart)) return null;
  }

  const draft = reconstructComposerDraft(message);
  if (!draft) return null;

  return {
    messageId: message.info.id,
    draft,
  };
}
