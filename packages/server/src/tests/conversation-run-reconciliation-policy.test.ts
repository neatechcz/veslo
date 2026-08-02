import { describe, expect, test } from "bun:test";

import {
  classifyExhaustedReconciliation,
  classifyReconciliationEvidence,
} from "../conversation-run-reconciliation-policy.js";

const base = {
  runId: "run-1",
  status: "running" as const,
  stale: false,
};

const policyInput = (status: typeof base | null | Record<string, unknown>) => ({
  status: status as never,
  reason: "accepted",
  now: 100_000,
  startupOrphanedAssistantMessageGraceMs: 60_000,
  engineUnreachableWithoutProgressGraceMs: 60_000,
});

describe("conversation run reconciliation policy", () => {
  test("classifies absence, active evidence, stale evidence, and terminal evidence without effects", () => {
    expect(classifyReconciliationEvidence(policyInput(null))).toEqual({ kind: "authoritative-absence" });
    expect(classifyReconciliationEvidence(policyInput(base))).toEqual({ kind: "active" });
    expect(classifyReconciliationEvidence(policyInput({ ...base, stale: true }))).toEqual({ kind: "unavailable" });
    expect(classifyReconciliationEvidence(policyInput({ ...base, status: "completed" }))).toEqual({ kind: "terminal" });
    expect(classifyReconciliationEvidence(policyInput({ ...base, status: "completed", stale: true }))).toEqual({
      kind: "unavailable",
    });
  });

  test("requires a narrowly trusted progress timeout before terminalization", () => {
    expect(classifyReconciliationEvidence({
      ...policyInput({
        ...base,
        stale: true,
        waitReason: "engine_unreachable",
        lastUsefulProgressAt: 40_000,
      }),
    })).toEqual({ kind: "terminalization-required", reasonCode: "engine_unreachable_without_progress" });
    expect(classifyReconciliationEvidence({
      ...policyInput({
        ...base,
        activityKind: "unknown",
        waitReason: "assistant_message_open",
        lastUsefulProgressAt: 40_000,
      }),
      reason: "startup-workspace-reservation-reconcile",
    })).toEqual({ kind: "terminalization-required", reasonCode: "startup_orphaned_assistant_message" });
  });

  test("keeps model retry without output recoverable after the normal poll budget", () => {
    expect(classifyExhaustedReconciliation({ ...base, waitReason: "model_retry_no_output" } as never)).toEqual({
      kind: "background-observe-no-output",
    });
    expect(classifyExhaustedReconciliation(base as never)).toEqual({
      kind: "terminalization-required",
      reasonCode: "reconcile_exhausted",
    });
    expect(classifyExhaustedReconciliation(null)).toEqual({ kind: "retain" });
  });
});
