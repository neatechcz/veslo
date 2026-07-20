import type { SessionSubmitResult } from "../../lib/session-send-contract";

export type ComposerSubmittedRevision = {
  readonly revision: number;
  transferAcknowledged: boolean;
  clearApplied: boolean;
};

export type ComposerDraftHandoffController = {
  acknowledgeTransfer: (submission: ComposerSubmittedRevision, clear: () => boolean) => boolean;
  applyResult: (
    submission: ComposerSubmittedRevision,
    disposition: SessionSubmitResult["draftDisposition"],
    clear: () => boolean,
  ) => boolean;
  beginSubmission: () => ComposerSubmittedRevision;
  currentRevision: () => number;
  markDraftChanged: () => number;
};

/**
 * Keeps delayed submit outcomes scoped to the exact Composer revision they
 * started from. The controller does not own draft content; it only decides
 * whether the Composer-owned clear callback may still mutate the live editor.
 */
export const createComposerDraftHandoffController = (): ComposerDraftHandoffController => {
  let revision = 0;

  const tryClear = (submission: ComposerSubmittedRevision, clear: () => boolean) => {
    if (submission.clearApplied || submission.revision !== revision) return false;
    if (!clear()) return false;
    submission.clearApplied = true;
    revision += 1;
    return true;
  };

  return {
    acknowledgeTransfer: (submission, clear) => {
      if (submission.transferAcknowledged) return false;
      submission.transferAcknowledged = true;
      return tryClear(submission, clear);
    },
    applyResult: (submission, disposition, clear) => {
      if (submission.transferAcknowledged || disposition !== "clear") return false;
      return tryClear(submission, clear);
    },
    beginSubmission: () => ({
      revision,
      transferAcknowledged: false,
      clearApplied: false,
    }),
    currentRevision: () => revision,
    markDraftChanged: () => {
      revision += 1;
      return revision;
    },
  };
};
