import type { Part } from "@opencode-ai/sdk/v2/client";

import type { ComposerDraft, MessageWithParts } from "../../types";
import type { EditableUserMessageDraft } from "./message-editability";
import { currentLocale as __vesloIndirectLocale, t as __vesloIndirectT } from "../../../i18n";

export type PendingSubmittedDraftState = "sending" | "error";
export type PendingSubmittedDraftAdmission = "pending" | "accepted";

export type PendingSubmittedDraft = {
  id: string;
  clientMessageId: string;
  sessionKey: string;
  sessionId: string | null;
  createdAt: number;
  transcriptMessageIdsAtSubmit?: string[];
  draft: ComposerDraft;
  state: PendingSubmittedDraftState;
  error?: string;
  admission?: PendingSubmittedDraftAdmission;
  acceptedRunId?: string | null;
  acceptedClientMessageId?: string | null;
  admissionDiagnostic?: "client-message-mismatch";
};

type PendingSubmittedDraftInput = Omit<
  PendingSubmittedDraft,
  "state" | "error" | "admission" | "acceptedRunId" | "acceptedClientMessageId" | "admissionDiagnostic"
>;

const filenameFromPath = (path: string) => {
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "file";
};

const toAbsolutePath = (path: string, workspaceRoot: string) => {
  const trimmed = path.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("/")) return trimmed;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return trimmed;
  const root = workspaceRoot.trim();
  if (!root) return "";
  return `${root}/${trimmed}`.replace("//", "/");
};

export function createPendingSubmittedDraft(input: PendingSubmittedDraftInput): PendingSubmittedDraft {
  return {
    ...input,
    state: "sending",
    admission: "pending",
  };
}

export function markPendingSubmittedAccepted(
  pending: PendingSubmittedDraft,
  input: { runId?: string | null; clientMessageId?: string | null },
): PendingSubmittedDraft {
  if (pending.state === "error") return pending;
  const acceptedClientMessageId = input.clientMessageId?.trim() || pending.clientMessageId.trim();
  if (acceptedClientMessageId && acceptedClientMessageId !== pending.clientMessageId.trim()) {
    return {
      ...pending,
      admissionDiagnostic: "client-message-mismatch",
    };
  }
  return {
    ...pending,
    admission: "accepted",
    acceptedRunId: input.runId?.trim() || null,
    acceptedClientMessageId: acceptedClientMessageId || null,
    admissionDiagnostic: undefined,
  };
}

export function markPendingSubmittedFailed(
  pending: PendingSubmittedDraft,
  error: string,
): PendingSubmittedDraft {
  return {
    ...pending,
    state: "error",
    error,
  };
}

export function remapPendingSubmittedSession(
  pending: PendingSubmittedDraft,
  sessionId: string,
): PendingSubmittedDraft {
  return {
    ...pending,
    sessionId,
  };
}

export function pendingSubmittedDraftToEditable(
  pending: PendingSubmittedDraft,
): EditableUserMessageDraft | null {
  if (pending.state !== "error") return null;
  return {
    messageId: pending.id,
    draft: pending.draft,
  };
}

export function pendingSubmittedDraftToMessage(
  pending: PendingSubmittedDraft,
  workspaceRoot: string,
): MessageWithParts {
  const sessionID = pending.sessionId ?? "";
  const parts: Part[] = [];
  const text = (pending.draft.resolvedText ?? pending.draft.text).trim();
  const placeholderText = pending.draft.attachments.length === 1 ? __vesloIndirectT("ui.indirect.attachment_1417wq", __vesloIndirectLocale()) : __vesloIndirectT("ui.indirect.attachments_8925gh", __vesloIndirectLocale());

  if (text || pending.draft.attachments.length > 0) {
    parts.push({
      id: `${pending.id}:text`,
      sessionID,
      messageID: pending.id,
      type: "text",
      text: text || placeholderText,
    } as Part);
  }

  for (const part of pending.draft.parts) {
    if (part.type !== "file") continue;
    const absolute = toAbsolutePath(part.path, workspaceRoot);
    if (!absolute) continue;
    parts.push({
      id: `${pending.id}:file:${parts.length}`,
      sessionID,
      messageID: pending.id,
      type: "file",
      mime: "text/plain",
      url: `file://${absolute}`,
      filename: filenameFromPath(part.path),
      path: part.path,
      label: part.label,
    } as unknown as Part);
  }

  pending.draft.attachments.forEach((attachment, index) => {
    parts.push({
      id: `${pending.id}:attachment:${index}`,
      sessionID,
      messageID: pending.id,
      type: "file",
      url: attachment.dataUrl,
      filename: attachment.name,
      mime: attachment.mimeType,
    } as Part);
  });

  return {
    info: {
      id: pending.id,
      clientMessageId: pending.clientMessageId,
      sessionID,
      role: "user",
      time: { created: pending.createdAt },
      parentID: "",
      model: "",
      modelID: "",
      providerID: "",
      mode: pending.draft.mode,
      agent: "",
      path: {
        cwd: workspaceRoot,
        root: workspaceRoot,
      },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as unknown as MessageWithParts["info"],
    parts,
  };
}
