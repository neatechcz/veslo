import type { ComposerDraft } from "../../types";
import { isAttachmentSubmitErrorCode } from "../../lib/attachment-submit-error-presentation";

export type ComposerAttachmentFailureCleanup =
  | { kind: "none" }
  | { kind: "replace"; draft: ComposerDraft };

const partsEqual = (left: ComposerDraft["parts"], right: ComposerDraft["parts"]) =>
  left.length === right.length
  && left.every((part, index) => JSON.stringify(part) === JSON.stringify(right[index]));

const commandEqual = (left: ComposerDraft["command"], right: ComposerDraft["command"]) =>
  left?.name === right?.name && left?.arguments === right?.arguments;

/**
 * Once the optimistic transcript row owns a rejected attachment draft, the
 * Composer must not silently attach the same bytes to the user's next message.
 * Preserve edits made while the submit was in flight and remove only the
 * attachment identities that belonged to the transferred snapshot.
 */
export function resolveComposerAttachmentFailureCleanup(input: {
  current: ComposerDraft;
  submitted: ComposerDraft;
  errorCode?: string | null;
  transferAcknowledged: boolean;
}): ComposerAttachmentFailureCleanup {
  if (
    !input.transferAcknowledged
    || !isAttachmentSubmitErrorCode(input.errorCode)
    || input.submitted.attachments.length === 0
  ) {
    return { kind: "none" };
  }

  const submittedAttachmentIds = new Set(input.submitted.attachments.map((attachment) => attachment.id));
  const attachments = input.current.attachments.filter(
    (attachment) => !submittedAttachmentIds.has(attachment.id),
  );
  if (attachments.length === input.current.attachments.length) return { kind: "none" };

  const currentStillMatchesSubmittedSnapshot =
    input.current.mode === input.submitted.mode
    && input.current.text === input.submitted.text
    && (input.current.resolvedText ?? input.current.text) ===
      (input.submitted.resolvedText ?? input.submitted.text)
    && commandEqual(input.current.command, input.submitted.command)
    && partsEqual(input.current.parts, input.submitted.parts)
    && input.current.attachments.length === input.submitted.attachments.length
    && input.current.attachments.every(
      (attachment, index) => attachment.id === input.submitted.attachments[index]?.id,
    );

  if (currentStillMatchesSubmittedSnapshot) {
    return {
      kind: "replace",
      draft: {
        mode: input.current.mode,
        parts: [],
        attachments: [],
        text: "",
        resolvedText: "",
      },
    };
  }

  return {
    kind: "replace",
    draft: {
      ...input.current,
      attachments,
    },
  };
}
