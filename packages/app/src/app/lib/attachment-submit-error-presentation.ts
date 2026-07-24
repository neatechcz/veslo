import type {
  SessionSubmitErrorDetails,
  SessionSubmitResult,
} from "./session-send-contract";

const ATTACHMENT_SUBMIT_ERROR_CODES = new Set([
  "attachment_format_unsupported",
  "attachment_processing_failed",
  "attachment_staging_failed",
  "attachment_reference_missing",
  "attachment_too_large",
  "attachment_total_size_exceeded",
  "attachment_limit_exceeded",
  "model_attachment_unsupported",
  "attachment_rejected",
  "attachment_runtime_rejected",
]);

const replaceTokens = (template: string, replacements: Record<string, string>) =>
  Object.entries(replacements).reduce(
    (value, [name, replacement]) => value.replaceAll(`{${name}}`, replacement),
    template,
  );

export function isAttachmentSubmitErrorCode(code: string | null | undefined): boolean {
  return ATTACHMENT_SUBMIT_ERROR_CODES.has(code?.trim() || "");
}

export function attachmentSubmitErrorMessage(input: {
  code?: string | null;
  details?: SessionSubmitErrorDetails | null;
  fallback?: string | null;
  tr: (key: string) => string;
}): { message: string; specific: boolean } {
  const code = input.code?.trim() || "";
  if (!isAttachmentSubmitErrorCode(code)) {
    return { message: input.fallback?.trim() || input.tr("session.pending_submit_failed"), specific: false };
  }
  const name = input.details?.attachmentName?.trim() || input.tr("session.attachment_unknown_name");
  const format = input.details?.format?.trim() || input.tr("session.attachment_unknown_format");
  const key = code === "attachment_rejected" ? "model_attachment_unsupported" : code;
  return {
    message: replaceTokens(input.tr(`session.${key}`), {
      name,
      format,
      maxBytes: String(input.details?.maxBytes ?? ""),
      maxAttachments: String(input.details?.maxAttachments ?? ""),
    }),
    specific: true,
  };
}

export function sessionSubmitFailureMessage(
  result: SessionSubmitResult,
  tr: (key: string) => string,
): { message: string; specific: boolean } {
  return attachmentSubmitErrorMessage({
    code: result.code,
    details: result.details,
    fallback: result.message,
    tr,
  });
}
