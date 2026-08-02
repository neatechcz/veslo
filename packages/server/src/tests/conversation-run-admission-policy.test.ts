import { describe, expect, test } from "bun:test";

import { decideEngineLossAdmission } from "../conversation-run-admission-policy.js";

const reservation = {
  workspaceId: "ws-1",
  conversationId: "conv-1",
  runId: "run-1",
  state: "active" as const,
  terminalizationReason: null,
  terminalizationAttempts: 0,
  terminalizationLastError: null,
  terminalizationNextAttemptAt: null,
  terminalizationDeadlineAt: null,
  engineSlotId: "slot-1",
  engineOwnerId: "owner-1",
  directoryInstanceEpoch: null,
  enginePid: 101,
  engineStartedAt: 1_000,
  engineBaseUrl: "http://127.0.0.1:50101",
  skillViewRevision: null,
  authorizationRevision: null,
  openCodeConfigDigest: null,
  createdAt: 1,
  updatedAt: 1,
};

const evidence = {
  engineSlotId: "slot-1",
  engineOwnerId: "owner-1",
  enginePid: 101,
  engineStartedAt: 1_000,
  engineBaseUrl: "http://127.0.0.1:50101",
};

describe("conversation run admission policy", () => {
  test("buffers a loss callback only while owner attachment is missing", () => {
    expect(decideEngineLossAdmission({ ...reservation, engineOwnerId: null }, evidence)).toEqual({
      kind: "buffer-pre-attachment",
    });
  });

  test("allows release only for the exact persisted owner tuple", () => {
    expect(decideEngineLossAdmission(reservation, evidence)).toEqual({ kind: "release-matching-owner" });
    expect(decideEngineLossAdmission(reservation, { ...evidence, enginePid: 102 })).toEqual({
      kind: "ignore-stale-or-incomplete-owner",
    });
  });
});
