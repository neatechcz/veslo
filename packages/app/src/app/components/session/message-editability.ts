import type { Part } from "@opencode-ai/sdk/v2/client";

import type { ComposerDraft, ComposerPart, MessageWithParts } from "../../types";
import { isUserVisiblePart } from "../../utils";

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

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const fileUrlPath = (part: Part): string | null => {
  const url = partString(part, "url");
  if (!url.startsWith("file://")) return null;

  const rawPath = url.slice("file://".length);
  if (!rawPath) return null;

  const decodedPath = safeDecodeURIComponent(rawPath);
  if (/^[A-Za-z]:[\\/]/.test(decodedPath)) {
    return decodedPath;
  }

  if (/^\/[A-Za-z]:\//.test(decodedPath)) {
    return decodedPath.slice(1);
  }

  if (decodedPath.startsWith("/")) return decodedPath;

  return `//${decodedPath}`;
};

type FileReference = Extract<ComposerPart, { type: "file" }>;

type FileTokenMatch = {
  token: string;
  path: string;
  index: number;
};

const textPart = (text: string): ComposerPart[] => (text ? [{ type: "text", text }] : []);

const fileReferenceFromPart = (part: Part): FileReference | null => {
  const path = partString(part, "path") || fileUrlPath(part);
  if (!path) return null;
  const label = partString(part, "label") || partString(part, "filename") || undefined;
  return { type: "file", path, label };
};

const filePathSuffixMatches = (filePath: string, candidatePath: string): boolean =>
  filePath.endsWith(`/${candidatePath}`) || filePath.endsWith(`\\${candidatePath}`);

const findBestFileTokenMatch = (text: string, filePath: string): FileTokenMatch | null => {
  const exactToken = `@${filePath}`;
  const exactIndex = text.indexOf(exactToken);
  if (exactIndex !== -1) {
    return { token: exactToken, path: filePath, index: exactIndex };
  }

  let bestMatch: FileTokenMatch | null = null;
  const tokenPattern = /@([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(text))) {
    const candidatePath = match[1];
    if (!candidatePath || !filePathSuffixMatches(filePath, candidatePath)) continue;

    if (!bestMatch || candidatePath.length > bestMatch.path.length) {
      bestMatch = {
        token: match[0],
        path: candidatePath,
        index: match.index,
      };
    }
  }

  return bestMatch;
};

const replaceFileToken = (parts: ComposerPart[], file: FileReference): { parts: ComposerPart[]; replaced: boolean } => {
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part.type !== "text") continue;

    const match = findBestFileTokenMatch(part.text, file.path);
    if (!match) continue;
    const replacementFile = match.path === file.path ? file : { ...file, path: match.path };

    return {
      parts: [
        ...parts.slice(0, index),
        ...textPart(part.text.slice(0, match.index)),
        replacementFile,
        ...textPart(part.text.slice(match.index + match.token.length)),
        ...parts.slice(index + 1),
      ],
      replaced: true,
    };
  }

  return { parts, replaced: false };
};

const insertFileReferences = (parts: ComposerPart[], files: FileReference[]): ComposerPart[] => {
  let nextParts = parts;

  for (const file of files) {
    const result = replaceFileToken(nextParts, file);
    nextParts = result.replaced ? result.parts : [...nextParts, file];
  }

  return nextParts;
};

const partsToText = (parts: ComposerPart[]): string =>
  parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "agent") return `@${part.name}`;
      if (part.type === "file") return `@${part.label ?? part.path}`;
      return part.label;
    })
    .join("");

const partsToResolvedText = (parts: ComposerPart[]): string =>
  parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "agent") return `@${part.name}`;
      if (part.type === "file") return `@${part.path}`;
      return part.text;
    })
    .join("");

const reconstructComposerDraft = (message: MessageWithParts): ComposerDraft | null => {
  const parts: ComposerPart[] = [];
  const files: FileReference[] = [];

  for (const part of message.parts.filter(isUserVisiblePart)) {
    if (part.type === "text") {
      const text = partString(part, "text");
      parts.push({ type: "text", text });
      continue;
    }

    if (part.type === "agent") {
      const name = partString(part, "name");
      if (!name) return null;
      parts.push({ type: "agent", name });
      continue;
    }

    if (part.type === "file") {
      const file = fileReferenceFromPart(part);
      if (!file) return null;
      files.push(file);
      continue;
    }

    return null;
  }

  const reconstructedParts = insertFileReferences(parts, files);

  return {
    mode: "prompt",
    parts: reconstructedParts,
    attachments: [],
    text: partsToText(reconstructedParts),
    resolvedText: partsToResolvedText(reconstructedParts),
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
    const message = input.messages[index]!;
    if (message.info.role === "user" && message.parts.some(isUserVisiblePart)) {
      messageIndex = index;
      break;
    }
  }
  if (messageIndex === -1) return null;

  const message = input.messages[messageIndex]!;
  const followingMessages = input.messages.slice(messageIndex + 1);
  for (const followingMessage of followingMessages) {
    const visibleParts = followingMessage.parts.filter(isUserVisiblePart);
    if (visibleParts.length === 0) continue;
    if (followingMessage.info.role !== "assistant") return null;
    if (!visibleParts.every(isAllowedPostUserPart)) return null;
  }

  const draft = reconstructComposerDraft(message);
  if (!draft) return null;

  return {
    messageId: message.info.id,
    draft,
  };
}
