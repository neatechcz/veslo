import assert from "node:assert/strict";
import test from "node:test";

import { createComposerDraftHandoffController } from "./composer-draft-handoff";

test("a clear result retries an ownership-transfer clear that initially lost a parent race", () => {
  const controller = createComposerDraftHandoffController();
  const submission = controller.beginSubmission();
  let attempts = 0;

  assert.equal(controller.acknowledgeTransfer(submission, () => {
    attempts += 1;
    return false;
  }), false);
  assert.equal(submission.transferAcknowledged, true);
  assert.equal(submission.clearApplied, false);

  assert.equal(controller.applyResult(submission, "clear", () => {
    attempts += 1;
    return true;
  }), true);
  assert.equal(attempts, 2);
  assert.equal(submission.clearApplied, true);
});

test("a delayed retry never clears after the Composer revision changed", () => {
  const controller = createComposerDraftHandoffController();
  const submission = controller.beginSubmission();
  controller.acknowledgeTransfer(submission, () => false);
  controller.markDraftChanged();

  let clearCalled = false;
  assert.equal(controller.applyResult(submission, "clear", () => {
    clearCalled = true;
    return true;
  }), false);
  assert.equal(clearCalled, false);
});
