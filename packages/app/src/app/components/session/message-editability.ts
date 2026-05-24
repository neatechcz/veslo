import type { Part } from "@opencode-ai/sdk/v2/client";

import type { ComposerDraft, ComposerPart, MessageWithParts } from "../../types";
import { isUserVisiblePart } from "../../utils";

export type EditableUserMessageDraft = {
  messageId: string;
  draft: ComposerDraft;
};

const READ_ONLY_TOOLS = new Set(["read", "list", "list_files", "grep", "glob", "webfetch", "search"]);

function isAllowedPostUserPart(part: Part): boolean {
  if (part.type === "reasoning") return true;
  if (part.type === "step-start" || part.type === "step-finish") return true;
  if (part.type === "text") return !partString(part, "text").trim();
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

  let decodedPath = safeDecodeURIComponent(rawPath);
  if (decodedPath.startsWith("localhost/")) {
    decodedPath = decodedPath.slice("localhost".length);
  }

  if (/^[A-Za-z]:[\\/]/.test(decodedPath)) {
    return decodedPath;
  }

  if (/^\/[A-Za-z]:[\\/]/.test(decodedPath)) {
    return decodedPath.slice(1);
  }

  if (decodedPath.startsWith("/")) return decodedPath;

  return `//${decodedPath}`;
};

type FileReference = Extract<ComposerPart, { type: "file" }>;
type AgentReference = Extract<ComposerPart, { type: "agent" }>;

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

const isNonImageDataFileAttachment = (part: Part): boolean => {
  if (part.type !== "file") return false;
  const url = partString(part, "url");
  if (!url.startsWith("data:")) return false;
  const mime = partString(part, "mime") || url.slice("data:".length, url.indexOf(";") === -1 ? undefined : url.indexOf(";"));
  return !mime.toLowerCase().startsWith("image/");
};

const hasVisiblePathEndingWithFilename = (text: string, filename: string): boolean => {
  if (!filename) return false;

  let index = text.indexOf(filename);
  while (index !== -1) {
    const before = text[index - 1];
    const after = text[index + filename.length];
    const cleanStart = !before || /\s/.test(before) || before === "/" || before === "\\";
    if (cleanStart && isMentionBoundary(after)) return true;
    index = text.indexOf(filename, index + 1);
  }

  return false;
};

const isIgnorableDataFileAttachment = (part: Part, visibleText: string): boolean =>
  isNonImageDataFileAttachment(part) &&
  hasVisiblePathEndingWithFilename(visibleText, partString(part, "filename"));

const isMentionBoundary = (value: string | undefined): boolean => !value || !/[A-Za-z0-9_.\\/:-]/.test(value);

const findBoundaryTokenIndex = (text: string, token: string): number => {
  let index = text.indexOf(token);
  while (index !== -1) {
    if (isMentionBoundary(text[index + token.length])) return index;
    index = text.indexOf(token, index + 1);
  }

  return -1;
};

const countBoundaryTokenOccurrences = (text: string, token: string): number => {
  let count = 0;
  let index = text.indexOf(token);
  while (index !== -1) {
    if (isMentionBoundary(text[index + token.length])) count += 1;
    index = text.indexOf(token, index + 1);
  }

  return count;
};

const pathSuffixCandidates = (path: string): string[] => {
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  const candidates: string[] = [];

  for (let index = 0; index < segments.length; index += 1) {
    candidates.push(segments.slice(index).join("/"));
  }

  return candidates.sort((a, b) => b.length - a.length);
};

const findBestFileTokenMatch = (text: string, filePath: string): FileTokenMatch | null => {
  const exactToken = `@${filePath}`;
  const exactIndex = findBoundaryTokenIndex(text, exactToken);
  if (exactIndex !== -1) {
    return { token: exactToken, path: filePath, index: exactIndex };
  }

  for (const candidatePath of pathSuffixCandidates(filePath)) {
    if (candidatePath === filePath) continue;
    const token = `@${candidatePath}`;
    const index = findBoundaryTokenIndex(text, token);
    if (index !== -1) {
      return { token, path: candidatePath, index };
    }
  }

  return null;
};

const fileTokenCandidates = (filePath: string): string[] => [
  `@${filePath}`,
  ...pathSuffixCandidates(filePath)
    .filter((candidatePath) => candidatePath !== filePath)
    .map((candidatePath) => `@${candidatePath}`),
];

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

const replaceAgentToken = (parts: ComposerPart[], agent: AgentReference): { parts: ComposerPart[]; replaced: boolean } => {
  const token = `@${agent.name}`;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part.type !== "text") continue;

    const tokenIndex = findBoundaryTokenIndex(part.text, token);
    if (tokenIndex === -1) continue;

    return {
      parts: [
        ...parts.slice(0, index),
        ...textPart(part.text.slice(0, tokenIndex)),
        agent,
        ...textPart(part.text.slice(tokenIndex + token.length)),
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
      if (part.type === "file") return `@${part.path}`;
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

const visibleTextFromParts = (parts: Part[]): string =>
  parts
    .filter((part) => part.type === "text")
    .map((part) => partString(part, "text"))
    .join("");

const hasAmbiguousResolvedAgentTokens = (visibleParts: Part[], visibleText: string): boolean => {
  const agentCounts = new Map<string, number>();

  for (const part of visibleParts) {
    if (part.type !== "agent") continue;
    const name = partString(part, "name");
    if (!name) continue;
    agentCounts.set(name, (agentCounts.get(name) ?? 0) + 1);
  }

  for (const [name, partCount] of agentCounts) {
    if (countBoundaryTokenOccurrences(visibleText, `@${name}`) > partCount) return true;
  }

  return false;
};

const hasAmbiguousResolvedFileTokens = (visibleParts: Part[], visibleText: string): boolean => {
  const fileTokenCounts = new Map<string, number>();

  for (const part of visibleParts) {
    if (part.type !== "file") continue;
    const file = fileReferenceFromPart(part);
    if (!file) continue;

    for (const token of fileTokenCandidates(file.path)) {
      fileTokenCounts.set(token, (fileTokenCounts.get(token) ?? 0) + 1);
    }
  }

  for (const [token, partCount] of fileTokenCounts) {
    if (countBoundaryTokenOccurrences(visibleText, token) > partCount) return true;
  }

  return false;
};

const reconstructComposerDraft = (message: MessageWithParts): ComposerDraft | null => {
  let parts: ComposerPart[] = [];
  const files: FileReference[] = [];
  const visibleParts = message.parts.filter(isUserVisiblePart);
  const visibleText = visibleTextFromParts(visibleParts);

  if (hasAmbiguousResolvedAgentTokens(visibleParts, visibleText)) return null;
  if (hasAmbiguousResolvedFileTokens(visibleParts, visibleText)) return null;

  for (const part of visibleParts) {
    if (part.type === "text") {
      const text = partString(part, "text");
      parts.push({ type: "text", text });
      continue;
    }

    if (part.type === "agent") {
      const name = partString(part, "name");
      if (!name) return null;
      const agent = { type: "agent", name } as const;
      const result = replaceAgentToken(parts, agent);
      parts = result.replaced ? result.parts : [...parts, agent];
      continue;
    }

    if (part.type === "file") {
      if (isNonImageDataFileAttachment(part)) {
        if (isIgnorableDataFileAttachment(part, visibleText)) continue;
        return null;
      }
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
