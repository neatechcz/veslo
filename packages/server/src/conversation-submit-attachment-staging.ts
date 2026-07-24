import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import type {
  ConversationSubmitAttachment,
  ConversationSubmitBlockedResult,
  ConversationSubmitRequest,
} from "./conversation-submit-contract.js";
import type { WorkspaceInfo } from "./types.js";

export const CONVERSATION_SUBMIT_MAX_ATTACHMENTS = 16;
export const CONVERSATION_SUBMIT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const CONVERSATION_SUBMIT_MAX_TOTAL_ATTACHMENT_BYTES = 32 * 1024 * 1024;
export const CONVERSATION_SUBMIT_MAX_BODY_BYTES = 48 * 1024 * 1024;

const MSG_COMPOUND_FILE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const WINDOWS_RESERVED_BASENAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export type ConversationSubmitAttachmentPreparation =
  | { status: "ok"; request: ConversationSubmitRequest }
  | { status: "blocked"; result: ConversationSubmitBlockedResult };

type DecodedAttachment = {
  bytes: Buffer;
  digest: string;
};

type AttachmentDecodeResult =
  | { status: "ok"; decoded: DecodedAttachment }
  | { status: "missing" | "invalid" | "too_large" };

function blocked(input: {
  code: string;
  message: string;
  attachmentName?: string;
  format?: string;
  suggestedAlternatives?: string[];
  maxBytes?: number;
  maxAttachments?: number;
}): ConversationSubmitAttachmentPreparation {
  const details = {
    ...(input.attachmentName ? { attachmentName: input.attachmentName } : {}),
    ...(input.format ? { format: input.format } : {}),
    ...(input.suggestedAlternatives ? { suggestedAlternatives: input.suggestedAlternatives } : {}),
    ...(input.maxBytes ? { maxBytes: input.maxBytes } : {}),
    ...(input.maxAttachments ? { maxAttachments: input.maxAttachments } : {}),
  };
  return {
    status: "blocked",
    result: {
      status: "blocked",
      code: input.code,
      message: input.message,
      draftDisposition: "restore",
      recoverable: true,
      ...(Object.keys(details).length ? { details } : {}),
    },
  };
}

function pathWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function slashPath(path: string): string {
  return path.split(sep).join("/");
}

function safeFilename(input: string): string {
  const normalized = basename(input.replaceAll("\\", "/"))
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  const withFallback = normalized || "attachment";
  const unreserved = WINDOWS_RESERVED_BASENAMES.test(withFallback) ? `_${withFallback}` : withFallback;
  if (Buffer.byteLength(unreserved, "utf8") <= 180) return unreserved;
  const extensionIndex = unreserved.lastIndexOf(".");
  const extension = extensionIndex > 0 ? unreserved.slice(extensionIndex, extensionIndex + 24) : "";
  return `${unreserved.slice(0, Math.max(1, 150 - extension.length))}${extension}`;
}

function safeSessionDirectoryName(sessionId: string): string {
  const label = sessionId.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 72) || "session";
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
  return `${label}-${digest}`;
}

function decodeBase64Strict(value: string): Buffer | null {
  const compact = value.replace(/\s+/g, "");
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  const bytes = Buffer.from(compact, "base64");
  const canonicalInput = compact.replace(/=+$/, "");
  const canonicalOutput = bytes.toString("base64").replace(/=+$/, "");
  return canonicalInput === canonicalOutput ? bytes : null;
}

function decodeAttachment(attachment: ConversationSubmitAttachment): AttachmentDecodeResult {
  const dataUrl = attachment.dataUrl?.trim() || "";
  let encoded = attachment.contentBase64?.trim() || "";
  if (dataUrl) {
    const match = /^data:([^;,]*)(?:;[^,]*)?;base64,([\s\S]*)$/i.exec(dataUrl);
    if (!match) return { status: "invalid" };
    encoded = match[2] ?? "";
  }
  if (!dataUrl && attachment.contentBase64 == null) return { status: "missing" };
  if (encoded.length > Math.ceil(CONVERSATION_SUBMIT_MAX_ATTACHMENT_BYTES / 3) * 4 + 8) {
    return { status: "too_large" };
  }
  const bytes = decodeBase64Strict(encoded);
  if (!bytes) return { status: "invalid" };
  if (bytes.byteLength > CONVERSATION_SUBMIT_MAX_ATTACHMENT_BYTES) return { status: "too_large" };
  return {
    status: "ok",
    decoded: {
      bytes,
      digest: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

function normalizedRelativeInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed)) return null;
  const segments = trimmed.replaceAll("\\", "/").split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.join(sep);
}

async function validateExistingAttachmentPath(input: {
  directoryReal: string;
  relativePath: string;
}): Promise<{ absolutePath: string; relativePath: string; size: number } | null> {
  const normalized = normalizedRelativeInput(input.relativePath);
  if (!normalized) return null;
  let current = input.directoryReal;
  for (const segment of normalized.split(sep)) {
    current = resolve(current, segment);
    if (!pathWithinRoot(input.directoryReal, current)) return null;
    const info = await lstat(current).catch(() => null);
    if (!info || info.isSymbolicLink()) return null;
  }
  const targetReal = await realpath(current).catch(() => null);
  if (!targetReal || !pathWithinRoot(input.directoryReal, targetReal)) return null;
  const info = await stat(targetReal).catch(() => null);
  if (!info?.isFile() || info.size > CONVERSATION_SUBMIT_MAX_ATTACHMENT_BYTES) return null;
  return {
    absolutePath: targetReal,
    relativePath: slashPath(relative(input.directoryReal, targetReal)),
    size: info.size,
  };
}

async function fileMatches(path: string, bytes: Buffer, digest: string): Promise<boolean> {
  const entry = await lstat(path).catch(() => null);
  if (!entry?.isFile() || entry.isSymbolicLink() || entry.size !== bytes.byteLength) return false;
  const existing = await readFile(path);
  return createHash("sha256").update(existing).digest("hex") === digest;
}

async function ensureSafeStageDirectory(rootReal: string, segments: string[]): Promise<string | null> {
  let current = rootReal;
  for (const segment of segments) {
    current = resolve(current, segment);
    if (!pathWithinRoot(rootReal, current)) return null;
    let info = await lstat(current).catch(() => null);
    if (!info) {
      await mkdir(current).catch(() => undefined);
      info = await lstat(current).catch(() => null);
    }
    if (!info?.isDirectory() || info.isSymbolicLink()) return null;
    const currentReal = await realpath(current).catch(() => null);
    if (!currentReal || !pathWithinRoot(rootReal, currentReal)) return null;
  }
  return current;
}

async function writeAtomicIdempotent(path: string, decoded: DecodedAttachment): Promise<void> {
  if (await fileMatches(path, decoded.bytes, decoded.digest)) return;
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tempPath, decoded.bytes, { flag: "wx", mode: 0o600 });
  try {
    const existing = await stat(path).catch(() => null);
    if (existing) {
      if (await fileMatches(path, decoded.bytes, decoded.digest)) return;
      throw new Error("Attachment staging target already exists with different content");
    }
    try {
      await rename(tempPath, path);
    } catch (error) {
      if (await fileMatches(path, decoded.bytes, decoded.digest)) return;
      throw error;
    }
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function isImageAttachment(attachment: ConversationSubmitAttachment): boolean {
  return attachment.kind.trim().toLowerCase() === "image" || attachment.mimeType.trim().toLowerCase().startsWith("image/");
}

function isMsgFilename(name: string): boolean {
  return name.trim().toLowerCase().endsWith(".msg");
}

async function validateMsgFallback(input: {
  attachment: ConversationSubmitAttachment;
  absolutePath: string;
}): Promise<ConversationSubmitAttachmentPreparation | null> {
  if (!isMsgFilename(input.attachment.name)) return null;
  const bytes = await readFile(input.absolutePath).catch(() => null);
  if (!bytes) {
    return blocked({
      code: "attachment_processing_failed",
      message: `The file ${input.attachment.name} could not be read. Attach it again.`,
      attachmentName: input.attachment.name,
      format: "MSG",
    });
  }
  if (bytes.byteLength < MSG_COMPOUND_FILE_SIGNATURE.byteLength ||
    !bytes.subarray(0, MSG_COMPOUND_FILE_SIGNATURE.byteLength).equals(MSG_COMPOUND_FILE_SIGNATURE)) {
    return blocked({
      code: "attachment_processing_failed",
      message: `The file ${input.attachment.name} is not a valid Outlook MSG file. Re-export it and try again.`,
      attachmentName: input.attachment.name,
      format: "MSG",
    });
  }
  return blocked({
    code: "attachment_format_unsupported",
    message: `Outlook MSG files are not supported yet. Convert ${input.attachment.name} to EML, PDF, or TXT and attach it again.`,
    attachmentName: input.attachment.name,
    format: "MSG",
    suggestedAlternatives: ["EML", "PDF", "TXT"],
  });
}

export async function prepareConversationSubmitAttachments(input: {
  workspace: WorkspaceInfo;
  request: ConversationSubmitRequest;
  directory: string | null;
  stagingSessionId: string;
}): Promise<ConversationSubmitAttachmentPreparation> {
  const attachments = input.request.draft.attachments ?? [];
  if (!attachments.length) return { status: "ok", request: input.request };
  if (attachments.length > CONVERSATION_SUBMIT_MAX_ATTACHMENTS) {
    return blocked({
      code: "attachment_limit_exceeded",
      message: `You can attach at most ${CONVERSATION_SUBMIT_MAX_ATTACHMENTS} files at once.`,
      maxAttachments: CONVERSATION_SUBMIT_MAX_ATTACHMENTS,
    });
  }
  const directory = input.directory?.trim() || "";
  const workspaceRoot = input.workspace.path?.trim() || input.workspace.directory?.trim() || "";
  if (!directory || !workspaceRoot) {
    return blocked({
      code: "attachment_staging_failed",
      message: "The attachment could not be saved because the workspace directory is unavailable.",
    });
  }
  const workspaceReal = await realpath(workspaceRoot).catch(() => null);
  const directoryReal = await realpath(directory).catch(() => null);
  if (!workspaceReal || !directoryReal || !pathWithinRoot(workspaceReal, directoryReal)) {
    return blocked({
      code: "attachment_staging_failed",
      message: "The attachment could not be saved inside the selected workspace.",
    });
  }

  const prepared: ConversationSubmitAttachment[] = [];
  let totalBytes = 0;
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index]!;
    const image = isImageAttachment(attachment);
    const existingPath = attachment.fileSessionPath?.trim() || "";
    let stored = existingPath
      ? await validateExistingAttachmentPath({ directoryReal, relativePath: existingPath })
      : null;
    let decoded: DecodedAttachment | null = null;

    if (!stored && (!image || existingPath)) {
      const decodedResult = decodeAttachment(attachment);
      if (decodedResult.status === "too_large") {
        return blocked({
          code: "attachment_too_large",
          message: `The file ${attachment.name} is too large. The limit is ${CONVERSATION_SUBMIT_MAX_ATTACHMENT_BYTES} bytes.`,
          attachmentName: attachment.name,
          maxBytes: CONVERSATION_SUBMIT_MAX_ATTACHMENT_BYTES,
        });
      }
      if (decodedResult.status !== "ok") {
        return blocked({
          code: existingPath ? "attachment_reference_missing" : "attachment_processing_failed",
          message: existingPath
            ? `The staged file ${attachment.name} is missing or is outside the workspace. Attach it again.`
            : `The file ${attachment.name} could not be decoded. Attach it again.`,
          attachmentName: attachment.name,
        });
      }
      decoded = decodedResult.decoded;
      if (decoded.bytes.byteLength > CONVERSATION_SUBMIT_MAX_ATTACHMENT_BYTES) {
        return blocked({
          code: "attachment_too_large",
          message: `The file ${attachment.name} is too large. The limit is ${CONVERSATION_SUBMIT_MAX_ATTACHMENT_BYTES} bytes.`,
          attachmentName: attachment.name,
          maxBytes: CONVERSATION_SUBMIT_MAX_ATTACHMENT_BYTES,
        });
      }
      const stageDirectory = await ensureSafeStageDirectory(directoryReal, [
        "sessions",
        safeSessionDirectoryName(input.stagingSessionId),
        "attachments",
      ]);
      if (!stageDirectory) {
        return blocked({
          code: "attachment_staging_failed",
          message: `The file ${attachment.name} could not be saved safely.`,
          attachmentName: attachment.name,
        });
      }
      const target = resolve(stageDirectory, `${String(index + 1).padStart(2, "0")}-${decoded.digest.slice(0, 16)}-${safeFilename(attachment.name)}`);
      try {
        await writeAtomicIdempotent(target, decoded);
      } catch {
        return blocked({
          code: "attachment_staging_failed",
          message: `The file ${attachment.name} could not be saved safely. Attach it again.`,
          attachmentName: attachment.name,
        });
      }
      stored = await validateExistingAttachmentPath({
        directoryReal,
        relativePath: slashPath(relative(directoryReal, target)),
      });
    }

    if (!image && !stored) {
      return blocked({
        code: "attachment_reference_missing",
        message: `The file ${attachment.name} is not available inside the workspace. Attach it again.`,
        attachmentName: attachment.name,
      });
    }
    totalBytes += stored?.size ?? decoded?.bytes.byteLength ?? 0;
    if (totalBytes > CONVERSATION_SUBMIT_MAX_TOTAL_ATTACHMENT_BYTES) {
      return blocked({
        code: "attachment_total_size_exceeded",
        message: `The attached files exceed the total limit of ${CONVERSATION_SUBMIT_MAX_TOTAL_ATTACHMENT_BYTES} bytes.`,
        maxBytes: CONVERSATION_SUBMIT_MAX_TOTAL_ATTACHMENT_BYTES,
      });
    }
    if (stored) {
      const msgFailure = await validateMsgFallback({ attachment, absolutePath: stored.absolutePath });
      if (msgFailure) return msgFailure;
    }
    prepared.push({
      ...attachment,
      ...(stored ? { fileSessionPath: stored.relativePath } : {}),
      ...(!image ? { dataUrl: null, contentBase64: null } : {}),
    });
  }

  return {
    status: "ok",
    request: {
      ...input.request,
      draft: {
        ...input.request.draft,
        attachments: prepared,
      },
    },
  };
}
