import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveCreateSessionManagedAiPreflightDecision,
  resolveCreateSessionRuntimeHealthPreflightDecision,
  resolveSendPromptBusyOwnership,
} from "../../controllers/send-orchestration-controller.js";

test("send prompt owns the busy timer only when sending to an existing real session", () => {
  assert.deepEqual(
    resolveSendPromptBusyOwnership({ sessionId: "ses_123" }),
    { ownsBusy: true },
  );

  assert.deepEqual(
    resolveSendPromptBusyOwnership({ sessionId: "" }),
    { ownsBusy: false },
  );

  assert.deepEqual(
    resolveSendPromptBusyOwnership({ sessionId: null }),
    { ownsBusy: false },
  );
});

test("created first-session sends skip managed AI bootstrap when the send preflight already passed", () => {
  assert.deepEqual(
    resolveCreateSessionManagedAiPreflightDecision({
      preflightManagedAiReady: true,
      runtimeAlreadyPrepared: false,
    }),
    { type: "skip", reason: "send-preflight-already-ready" },
  );

  assert.deepEqual(
    resolveCreateSessionManagedAiPreflightDecision({
      preflightManagedAiReady: false,
      runtimeAlreadyPrepared: true,
    }),
    { type: "skip", reason: "send-preflight-already-ready" },
  );

  assert.deepEqual(
    resolveCreateSessionManagedAiPreflightDecision({
      preflightManagedAiReady: false,
      runtimeAlreadyPrepared: false,
    }),
    { type: "run" },
  );
});

test("created first-session sends skip duplicate runtime health after send preflight", () => {
  assert.deepEqual(
    resolveCreateSessionRuntimeHealthPreflightDecision({ preflightRuntimeHealthOk: true }),
    { type: "skip", reason: "send-preflight-already-healthy" },
  );

  assert.deepEqual(
    resolveCreateSessionRuntimeHealthPreflightDecision({ preflightRuntimeHealthOk: false }),
    { type: "run" },
  );
});
