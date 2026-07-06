import type {
  ConversationSubmitBlockedResult,
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

async function resolveRunInput(input: {
  request: ConversationSubmitRequest;
  resolveSkillCommand?: ConversationSubmitSkillCommandResolver;
  workspace?: WorkspaceInfo | null;
  includeGlobal?: boolean;
}): Promise<ConversationSubmitResolvedRunInput> {
  const { request } = input;
  if (request.draft.mode === "shell") {
    return {
      kind: "shell",
      command: resolvedContent(request),
    };
  }

  const command = submitCommand(request);
  if (command) {
    return {
      kind: "command",
      command: command.name,
      arguments: command.arguments,
      ...(request.draft.parts.length ? { parts: request.draft.parts } : {}),
    };
  }

  const text = resolvedContent(request);
  if (text && input.resolveSkillCommand) {
    const skillCommandName = (await input.resolveSkillCommand({
      request,
      text,
      workspace: input.workspace ?? null,
      includeGlobal: input.includeGlobal === true,
    }))?.trim();
    if (skillCommandName) {
      return {
        kind: "command",
        command: skillCommandName,
        arguments: text,
        ...(request.draft.parts.length ? { parts: request.draft.parts } : {}),
      };
    }
  }

  return {
    kind: "prompt_async",
    text,
    parts: request.draft.parts,
  };
}

export async function resolveConversationSubmitDraft(input: {
  request: ConversationSubmitRequest;
  documentRuntimeStatus?: ConversationSubmitDocumentRuntimeStatusReader;
  resolveSkillCommand?: ConversationSubmitSkillCommandResolver;
  workspace?: WorkspaceInfo | null;
  includeGlobal?: boolean;
}): Promise<ConversationSubmitDraftResolution> {
  const resolvedRunInput = await resolveRunInput(input);
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
