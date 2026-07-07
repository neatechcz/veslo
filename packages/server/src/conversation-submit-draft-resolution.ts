import { basename, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ConversationSubmitBlockedResult,
  ConversationSubmitAttachment,
  ConversationSubmitDebugTraceEntry,
  ConversationSubmitRequest,
  ConversationSubmitResolvedRunInput,
} from "./conversation-submit-contract.js";
import type {
  DocumentRuntimeStatusPayload,
} from "./routes/document-runtime.js";
import type { WorkspaceInfo } from "./types.js";

type DocumentRuntimeFormat = "docx" | "xlsx" | "pdf" | "pptx";

export type ConversationSubmitDocumentRuntimeStatusReader = () =>
  | DocumentRuntimeStatusPayload
  | null
  | undefined
  | Promise<DocumentRuntimeStatusPayload | null | undefined>;

export type ConversationSubmitSkillCommandResolverInput = {
  request: ConversationSubmitRequest;
  text: string;
  workspace: WorkspaceInfo | null;
  includeGlobal: boolean;
};

export type ConversationSubmitSkillCommandResolver = (
  input: ConversationSubmitSkillCommandResolverInput,
) => string | null | undefined | Promise<string | null | undefined>;

export type ConversationSubmitDraftResolution =
  | { status: "ok"; resolvedRunInput: ConversationSubmitResolvedRunInput }
  | { status: "blocked"; result: ConversationSubmitBlockedResult };

type ConversationSubmitRunInputResolution =
  | { status: "ok"; resolvedRunInput: ConversationSubmitResolvedRunInput }
  | { status: "blocked"; result: ConversationSubmitBlockedResult };

type FilePartInput = {
  type: "file";
  url: string;
  filename: string;
  mime: string;
};

type AgentPartInput = {
  type: "agent";
  name: string;
};

type TextPartInput = {
  type: "text";
  text: string;
};

type AttachmentRunParts = {
  pathLinesForPrompt: string[];
  pathLinesForPathBasedRuns: string[];
  inlineFileParts: FilePartInput[];
};

type AttachmentRunPartsResolution =
  | { status: "ok"; parts: AttachmentRunParts }
  | { status: "blocked"; result: ConversationSubmitBlockedResult };

const DOCUMENT_RUNTIME_FORMAT_BY_SKILL_NAME = {
  "veslo-docx": "docx",
  "veslo-xlsx": "xlsx",
  "veslo-pdf": "pdf",
  "veslo-pptx": "pptx",
} satisfies Record<string, DocumentRuntimeFormat>;

export function documentRuntimeFormatForSubmitCommand(skillName: string): DocumentRuntimeFormat | null {
  const key = skillName.trim();
  return Object.prototype.hasOwnProperty.call(DOCUMENT_RUNTIME_FORMAT_BY_SKILL_NAME, key)
    ? DOCUMENT_RUNTIME_FORMAT_BY_SKILL_NAME[key as keyof typeof DOCUMENT_RUNTIME_FORMAT_BY_SKILL_NAME]
    : null;
}

function promptRunInput(
  request: ConversationSubmitRequest,
  text: string,
  attachmentParts: AttachmentRunParts,
  workspace?: WorkspaceInfo | null,
): ConversationSubmitResolvedRunInput {
  const finalText = appendLines(text, attachmentParts.pathLinesForPrompt);
  return {
    kind: "prompt_async",
    text: finalText,
    parts: promptParts({
      text: finalText,
      draftParts: request.draft.parts,
      attachmentParts: attachmentParts.inlineFileParts,
      ...(workspace !== undefined ? { workspace } : {}),
    }),
  };
}

function documentRuntimeSkillReady(
  status: DocumentRuntimeStatusPayload | null | undefined,
  format: DocumentRuntimeFormat,
): boolean {
  if (!status?.ready) return false;
  return status.skills.some((skill) => skill.format === format && skill.ready);
}

export function documentRuntimeBlockReasonForSubmitCommand(
  status: DocumentRuntimeStatusPayload | null | undefined,
  format: DocumentRuntimeFormat,
): string | null {
  if (documentRuntimeSkillReady(status, format)) return null;
  if (!status) return "Document runtime status is not loaded yet.";

  switch (status.status) {
    case "missing":
      return "Document runtime package is missing. Repair or update Veslo before starting this document task.";
    case "repairing":
    case "package_installing":
      return "Document runtime repair is still in progress. Wait until it finishes before starting this document task.";
    case "outdated":
    case "package_update_available":
      return "Document runtime package must be updated before starting this document task.";
    case "package_rollback":
      return "Document runtime package is rolling back. Wait until recovery finishes before starting this document task.";
    case "remote_only":
      return "Local document runtime is disabled for this install. Use a remote document-capable worker instead.";
    case "disabled_by_product_policy":
      return "Document runtime is disabled by product policy for this install.";
    case "blocked":
      return status.repair.blockedReason ?? "Document runtime repair is blocked.";
    case "failed":
      return status.repair.lastError ?? "Document runtime failed its readiness check.";
    case "ready":
      return "Document runtime is not ready for this file type.";
  }
}

type ParsedSlashCommand = {
  name: string;
  arguments: string;
};

function parseSlashCommandFromText(text: string): ParsedSlashCommand | null {
  const match = text.trim().match(/^\/([a-zA-Z0-9][a-zA-Z0-9_-]*)(?:\s+([\s\S]*))?$/);
  if (!match?.[1]) return null;
  return {
    name: match[1],
    arguments: match[2]?.trim() ?? "",
  };
}

function submitCommand(request: ConversationSubmitRequest): ParsedSlashCommand | null {
  const explicit = request.draft.command?.name?.trim();
  if (explicit) {
    return {
      name: explicit,
      arguments: request.draft.command?.arguments?.trim() ?? "",
    };
  }
  return parseSlashCommandFromText(request.draft.text) ?? parseSlashCommandFromText(request.draft.resolvedText ?? "");
}

function resolvedContent(request: ConversationSubmitRequest): string {
  return request.draft.resolvedText?.trim() || request.draft.text.trim();
}

function isCompactSubmitCommand(command: ParsedSlashCommand): boolean {
  return command.name.trim().toLowerCase() === "compact";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function blockedResult(input: {
  code: string;
  message: string;
  draftDisposition?: "restore" | "keep";
  recoverable?: boolean;
}): { status: "blocked"; result: ConversationSubmitBlockedResult } {
  return {
    status: "blocked",
    result: {
      status: "blocked",
      code: input.code,
      message: input.message,
      draftDisposition: input.draftDisposition ?? "restore",
      recoverable: input.recoverable ?? true,
    },
  };
}

function appendLines(base: string | undefined, lines: string[]): string {
  const nextLines = lines.map((line) => line.trim()).filter(Boolean);
  const trimmed = (base ?? "").trim();
  if (!nextLines.length) return trimmed;
  return trimmed ? `${trimmed}\n${nextLines.join("\n")}` : nextLines.join("\n");
}

function attachmentDataUrl(attachment: ConversationSubmitAttachment): string | null {
  const dataUrl = attachment.dataUrl?.trim();
  if (dataUrl) return dataUrl;
  const contentBase64 = attachment.contentBase64?.trim();
  if (!contentBase64) return null;
  const mimeType = attachment.mimeType.trim() || "application/octet-stream";
  return `data:${mimeType};base64,${contentBase64}`;
}

function attachmentFilePart(attachment: ConversationSubmitAttachment): FilePartInput | null {
  const url = attachmentDataUrl(attachment);
  if (!url) return null;
  return {
    type: "file",
    url,
    filename: attachment.name.trim() || "attachment",
    mime: attachment.mimeType.trim() || "application/octet-stream",
  };
}

function isImageAttachment(attachment: ConversationSubmitAttachment): boolean {
  const kind = attachment.kind.trim().toLowerCase();
  const mimeType = attachment.mimeType.trim().toLowerCase();
  return kind === "image" || mimeType.startsWith("image/");
}

function pathWithinRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function workspaceRootForFileParts(workspace?: WorkspaceInfo | null): string {
  return workspace?.path?.trim() || workspace?.directory?.trim() || "";
}

function resolveWorkspaceFilePart(
  path: string,
  workspace?: WorkspaceInfo | null,
): FilePartInput | null {
  const trimmed = path.trim();
  const root = workspaceRootForFileParts(workspace);
  if (!trimmed || !root) return null;
  const rootResolved = resolve(root);
  const absolute = isAbsolute(trimmed) ? resolve(trimmed) : resolve(rootResolved, trimmed);
  if (!pathWithinRoot(rootResolved, absolute)) return null;
  return {
    type: "file",
    url: pathToFileURL(absolute).href,
    filename: basename(absolute) || "file",
    mime: "text/plain",
  };
}

function filePartsFromDraftParts(
  parts: unknown[],
  workspace?: WorkspaceInfo | null,
): Array<FilePartInput | AgentPartInput> {
  const result: Array<FilePartInput | AgentPartInput> = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.type === "agent" && typeof part.name === "string" && part.name.trim()) {
      result.push({ type: "agent", name: part.name.trim() });
      continue;
    }
    if (part.type === "file" && typeof part.path === "string") {
      const filePart = resolveWorkspaceFilePart(part.path, workspace);
      if (filePart) result.push(filePart);
    }
  }
  return result;
}

function isFilePart(part: FilePartInput | AgentPartInput): part is FilePartInput {
  return part.type === "file";
}

function promptParts(input: {
  text: string;
  draftParts: unknown[];
  attachmentParts: FilePartInput[];
  workspace?: WorkspaceInfo | null;
}): Array<TextPartInput | FilePartInput | AgentPartInput> {
  const text = input.text.trim();
  return [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...filePartsFromDraftParts(input.draftParts, input.workspace),
    ...input.attachmentParts,
  ];
}

function modelImageCapability(model: unknown): "supported" | "unsupported" | "unknown" {
  if (!isRecord(model)) return "unknown";
  const attachment = model.attachment;
  if (attachment === true) return "supported";
  const modalities = isRecord(model.modalities) ? model.modalities : null;
  const inputModalities = Array.isArray(modalities?.input) ? modalities.input : null;
  if (inputModalities?.some((entry) => entry === "image")) return "supported";
  if (attachment === false || inputModalities) return "unsupported";
  return "unknown";
}

function resolveAttachmentRunParts(input: {
  request: ConversationSubmitRequest;
  workspace?: WorkspaceInfo | null;
  validatePromptImageCapabilities: boolean;
}): AttachmentRunPartsResolution {
  const attachments = input.request.draft.attachments ?? [];
  const inlineFileParts: FilePartInput[] = [];
  const pathLinesForPrompt: string[] = [];
  const pathLinesForPathBasedRuns: string[] = [];
  const promptImages = attachments.filter(isImageAttachment);

  if (promptImages.length && input.validatePromptImageCapabilities) {
    const capability = modelImageCapability(input.request.options?.model);
    if (capability === "unknown") {
      return blockedResult({
        code: "model_capabilities_unavailable",
        message: "Model attachment capabilities are unavailable for image attachments.",
      });
    }
    if (capability === "unsupported") {
      return blockedResult({
        code: "attachment_rejected",
        message: "The selected model cannot inspect image attachments. Switch to a model with image input and send again.",
      });
    }
  }

  for (const attachment of attachments) {
    const fileSessionPath = attachment.fileSessionPath?.trim() || "";
    const image = isImageAttachment(attachment);
    if (fileSessionPath) {
      pathLinesForPathBasedRuns.push(fileSessionPath);
      if (!image) pathLinesForPrompt.push(fileSessionPath);
    }
    const inline = attachmentFilePart(attachment);
    if (inline) {
      inlineFileParts.push(inline);
      continue;
    }
    if (fileSessionPath) {
      const filePart = resolveWorkspaceFilePart(fileSessionPath, input.workspace);
      if (filePart) inlineFileParts.push(filePart);
    }
  }

  return {
    status: "ok",
    parts: {
      pathLinesForPrompt,
      pathLinesForPathBasedRuns,
      inlineFileParts,
    },
  };
}

async function resolveRunInput(input: {
  request: ConversationSubmitRequest;
  documentRuntimeStatus?: ConversationSubmitDocumentRuntimeStatusReader;
  resolveSkillCommand?: ConversationSubmitSkillCommandResolver;
  recordDebugTrace?: (entry: ConversationSubmitDebugTraceEntry) => void;
  workspace?: WorkspaceInfo | null;
  includeGlobal?: boolean;
}): Promise<ConversationSubmitRunInputResolution> {
  const { request } = input;
  const hasExistingTarget = Boolean(
    request.target?.conversationId?.trim() || request.target?.opencodeSessionId?.trim(),
  );
  const attachmentResolution = resolveAttachmentRunParts({
    request,
    ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
    validatePromptImageCapabilities: hasExistingTarget || Boolean(request.options?.model),
  });
  if (attachmentResolution.status === "blocked") return attachmentResolution;
  const attachmentParts = attachmentResolution.parts;

  if (request.draft.mode === "shell") {
    return {
      status: "ok",
      resolvedRunInput: {
        kind: "shell",
        command: appendLines(resolvedContent(request), attachmentParts.pathLinesForPathBasedRuns),
      },
    };
  }

  const command = submitCommand(request);
  if (command) {
    if (isCompactSubmitCommand(command)) {
      return {
        status: "ok",
        resolvedRunInput: {
          kind: "summarize",
        },
      };
    }
    return {
      status: "ok",
      resolvedRunInput: {
        kind: "command",
        command: command.name,
        arguments: appendLines(command.arguments, attachmentParts.pathLinesForPathBasedRuns),
        ...(() => {
          const parts = [
            ...filePartsFromDraftParts(request.draft.parts, input.workspace).filter(isFilePart),
            ...attachmentParts.inlineFileParts,
          ];
          return parts.length ? { parts } : {};
        })(),
      },
    };
  }

  const text = resolvedContent(request);
  if (text && input.resolveSkillCommand) {
    let skillCommandName: string | undefined;
    try {
      skillCommandName = (await input.resolveSkillCommand({
        request,
        text,
        workspace: input.workspace ?? null,
        includeGlobal: input.includeGlobal === true,
      }))?.trim();
    } catch (error) {
      input.recordDebugTrace?.({
        source: "conversation-submit-draft-resolution",
        event: "implicit_skill_resolution_failed",
        message: error instanceof Error ? error.message : String(error),
      });
      skillCommandName = undefined;
    }
    if (skillCommandName) {
      const documentRuntimeFormat = documentRuntimeFormatForSubmitCommand(skillCommandName);
      if (documentRuntimeFormat) {
        const status = await input.documentRuntimeStatus?.();
        const message = documentRuntimeBlockReasonForSubmitCommand(status, documentRuntimeFormat);
        if (message) {
          return {
            status: "ok",
            resolvedRunInput: promptRunInput(request, text, attachmentParts, input.workspace),
          };
        }
      }
      return {
        status: "ok",
        resolvedRunInput: {
          kind: "command",
          command: skillCommandName,
          arguments: appendLines(text, attachmentParts.pathLinesForPathBasedRuns),
          ...(() => {
            const parts = [
              ...filePartsFromDraftParts(request.draft.parts, input.workspace).filter(isFilePart),
              ...attachmentParts.inlineFileParts,
            ];
            return parts.length ? { parts } : {};
          })(),
        },
      };
    }
  }

  return {
    status: "ok",
    resolvedRunInput: promptRunInput(request, text, attachmentParts, input.workspace),
  };
}

export async function resolveConversationSubmitDraft(input: {
  request: ConversationSubmitRequest;
  documentRuntimeStatus?: ConversationSubmitDocumentRuntimeStatusReader;
  resolveSkillCommand?: ConversationSubmitSkillCommandResolver;
  recordDebugTrace?: (entry: ConversationSubmitDebugTraceEntry) => void;
  workspace?: WorkspaceInfo | null;
  includeGlobal?: boolean;
}): Promise<ConversationSubmitDraftResolution> {
  const runInputResolution = await resolveRunInput(input);
  if (runInputResolution.status === "blocked") return runInputResolution;
  const { resolvedRunInput } = runInputResolution;
  const documentRuntimeFormat = resolvedRunInput.kind === "command"
    ? documentRuntimeFormatForSubmitCommand(resolvedRunInput.command)
    : null;
  if (!documentRuntimeFormat) return { status: "ok", resolvedRunInput };

  const status = await input.documentRuntimeStatus?.();
  const message = documentRuntimeBlockReasonForSubmitCommand(status, documentRuntimeFormat);
  if (!message) return { status: "ok", resolvedRunInput };

  return {
    status: "blocked",
    result: {
      status: "blocked",
      code: "document_runtime_blocked",
      message,
      draftDisposition: "restore",
      recoverable: true,
    },
  };
}
