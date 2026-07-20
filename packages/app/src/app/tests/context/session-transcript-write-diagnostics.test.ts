import assert from "node:assert/strict";
import test from "node:test";

import {
  describeTranscriptProjectionBoundary,
  describeTranscriptSurfaceIdentities,
  isMessageBlockMemoNoOp,
  observeTranscriptProjectionBoundary,
  observeTranscriptViewportProjectionBoundary,
  recordTranscriptStoreWrite,
  resetTranscriptWriteDiagnosticsForTests,
  setTranscriptWriteDiagnosticsEnabledForTests,
  transcriptWriteRevision,
} from "../../context/session-transcript-write-diagnostics.js";
import type { MessageInfo, MessageWithParts } from "../../types";

const message = (id = "msg-1"): MessageInfo =>
  ({
    id,
    sessionID: "ses-1",
    role: "assistant",
    time: { created: 1 },
  }) as MessageInfo;

const textPart = (id = "part-1") =>
  ({ id, sessionID: "ses-1", messageID: "msg-1", type: "text", text: "hello" }) as const;

test("reports content-free message, parts and part identities with their last write owners", () => {
  resetTranscriptWriteDiagnosticsForTests();
  setTranscriptWriteDiagnosticsEnabledForTests(true);
  const info = message();
  const part = textPart();
  const rendered = [{ info, parts: [part] }] as MessageWithParts[];

  const messageCause = recordTranscriptStoreWrite("sse.message.updated", "message-info", "ses-1", "msg-1");
  const partsCause = recordTranscriptStoreWrite("sse.part.updated", "parts", "ses-1", "msg-1");
  const partCause = recordTranscriptStoreWrite("sse.part.updated", "part", "ses-1", "msg-1", "part-1");

  const [surface] = describeTranscriptSurfaceIdentities(rendered);
  assert.equal(surface.messageId, "msg-1");
  assert.equal(surface.messageInfoCause?.causeId, messageCause?.causeId);
  assert.equal(surface.messageInfoCause?.owner, "sse.message.updated");
  assert.equal(surface.partsCause?.causeId, partsCause?.causeId);
  assert.equal(surface.partsCause?.target, "parts");
  assert.deepEqual(surface.partIdentities, [{
    partId: "part-1",
    identity: surface.partIdentities[0]?.identity,
    cause: partCause,
  }]);
  assert.ok(surface.messageIdentity > 0);
  assert.ok(surface.infoIdentity > 0);
  assert.ok(surface.partsIdentity > 0);
  assert.equal(partCause?.revision, 3);
  assert.equal(transcriptWriteRevision(), 3);
});

test("records projection boundaries only when their output array changes", () => {
  resetTranscriptWriteDiagnosticsForTests();
  setTranscriptWriteDiagnosticsEnabledForTests(true);
  const first = [{ info: message(), parts: [] }] as MessageWithParts[];

  const observed = observeTranscriptProjectionBoundary("visible", "ses-1", first);
  const replay = observeTranscriptProjectionBoundary("visible", "ses-1", first);
  const changed = observeTranscriptProjectionBoundary("visible", "ses-1", first.slice());

  assert.equal(observed?.revision, 1);
  assert.equal(replay?.revision, 1);
  assert.equal(changed?.revision, 2);
  assert.equal(describeTranscriptProjectionBoundary("visible", "ses-1")?.arrayIdentity, changed?.arrayIdentity);
  setTranscriptWriteDiagnosticsEnabledForTests(null);
});

test("records the viewport input tuple and identifies output churn without a tuple change", () => {
  resetTranscriptWriteDiagnosticsForTests();
  setTranscriptWriteDiagnosticsEnabledForTests(true);
  const canonical = [{ info: message(), parts: [] }] as MessageWithParts[];
  const first = canonical.slice();
  const replay = canonical.slice();
  const input = {
    sessionId: "ses-1",
    canonicalMessages: canonical,
    localSubmittedMessage: null,
    searchActive: false,
    windowExpanded: false,
    windowStart: 0,
  };

  const initial = observeTranscriptViewportProjectionBoundary({ ...input, renderedMessages: first });
  const churn = observeTranscriptViewportProjectionBoundary({ ...input, renderedMessages: replay });
  const changedTuple = observeTranscriptViewportProjectionBoundary({
    ...input,
    searchActive: true,
    renderedMessages: replay,
  });

  assert.equal(initial?.outputIdentityChanged, true);
  assert.equal(churn?.outputIdentityChanged, true);
  assert.deepEqual(churn?.previousInputTuple, churn?.inputTuple);
  assert.equal(changedTuple?.outputIdentityChanged, false);
  assert.notDeepEqual(changedTuple?.previousInputTuple, changedTuple?.inputTuple);
  setTranscriptWriteDiagnosticsEnabledForTests(null);
});

test("classifies a message-block memo run as no-op only without a new boundary or write", () => {
  const stable = {
    groupingInputFingerprint: "input-1",
    previousGroupingInputFingerprint: "input-1",
    blockShapeFingerprint: "shape-1",
    previousBlockShapeFingerprint: "shape-1",
    rowReferenceFingerprint: "rows-1",
    previousRowReferenceFingerprint: "rows-1",
    projectionBoundaryFingerprint: "boundary-1",
    previousProjectionBoundaryFingerprint: "boundary-1",
    writeRevisionStart: 4,
    writeRevisionEnd: 4,
  };
  assert.equal(isMessageBlockMemoNoOp(stable), true);
  assert.equal(isMessageBlockMemoNoOp({ ...stable, writeRevisionEnd: 5 }), false);
  assert.equal(isMessageBlockMemoNoOp({ ...stable, projectionBoundaryFingerprint: "boundary-2" }), false);
});

test("keeps write causes scoped by session and message", () => {
  resetTranscriptWriteDiagnosticsForTests();
  setTranscriptWriteDiagnosticsEnabledForTests(true);
  recordTranscriptStoreWrite("sse.part.updated", "parts", "ses-a", "shared-message");

  const other = [{ info: message("shared-message"), parts: [] }] as MessageWithParts[];
  other[0].info.sessionID = "ses-b";
  const [surface] = describeTranscriptSurfaceIdentities(other);
  assert.equal(surface.partsCause, null);
});

test("is a production no-op when diagnostics are disabled", () => {
  resetTranscriptWriteDiagnosticsForTests();
  setTranscriptWriteDiagnosticsEnabledForTests(false);
  assert.equal(recordTranscriptStoreWrite("sse.part.updated", "parts", "ses-1", "msg-1"), null);
  assert.deepEqual(describeTranscriptSurfaceIdentities([{ info: message(), parts: [] }]), []);
  assert.equal(transcriptWriteRevision(), 0);
  assert.equal(observeTranscriptProjectionBoundary("canonical", "ses-1", [{ info: message(), parts: [] }]), null);
  setTranscriptWriteDiagnosticsEnabledForTests(null);
});
