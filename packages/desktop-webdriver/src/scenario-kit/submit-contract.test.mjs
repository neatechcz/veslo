import assert from "node:assert/strict";
import test from "node:test";

import {
  identityAdoptionAfter,
  requireSingleSubmitContract,
  summarizeSubmitContract,
  traceCursor,
} from "./submit-contract.mjs";

const entries = [
  { id: 1, event: "older" },
  { id: 2, event: "sendPromptImmediate:start", traceId: "trace-a" },
  { id: 3, event: "sendPrompt:server-submit-existing:start", traceId: "trace-a" },
  { id: 4, event: "pending-submit:transcript-reconciliation", result: "adopt", matchKind: "identity", candidateCount: 1 },
];

test("submit contract requires one trace id on the expected route", () => {
  assert.equal(traceCursor(entries), 4);
  assert.deepEqual(summarizeSubmitContract(entries, 1), {
    submitStartCount: 1,
    traceIds: ["trace-a"],
    createsConversation: false,
    targetsExistingConversation: true,
  });
  assert.equal(requireSingleSubmitContract(entries, 1, "existing").submitStartCount, 1);
  assert.throws(
    () => requireSingleSubmitContract([...entries, { id: 5, event: "sendPromptImmediate:start", traceId: "trace-b" }], 1, "existing"),
    /exactly one submit/,
  );
});

test("identity adoption accepts only one exact canonical identity match", () => {
  assert.equal(identityAdoptionAfter(entries, 1)?.matchKind, "identity");
  assert.equal(identityAdoptionAfter([
    { id: 2, event: "pending-submit:transcript-reconciliation", result: "adopt", matchKind: "fingerprint", candidateCount: 1 },
  ], 1), null);
});
