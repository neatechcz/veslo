import assert from "node:assert/strict";
import test from "node:test";
import { createConversationRunDeliveryReporter } from "./conversation-run-delivery-reporter.js";

const scope = { workspaceId: "workspace-a", conversationId: "conversation-a", runId: "run-a" };

test("conversation run delivery reporter batches many observations into one aggregate and one terminal report", async () => {
  const reports: unknown[] = [];
  const reporter = createConversationRunDeliveryReporter({
    report: (_scope, report) => { reports.push(report); },
    now: () => new Date("2026-07-30T10:00:00.000Z"),
  });

  reporter.observeAccepted(scope, true);
  reporter.observeAccepted(scope, false);
  reporter.observeRejected(scope, "duplicate_event");
  await Promise.resolve();
  reporter.reportTerminal(scope, { hydration: "adopted", presentation: "visible_output" });

  assert.equal(reports.length, 2);
  assert.deepEqual(reports[0], {
    kind: "aggregate",
    acceptedEventCount: 2,
    storeCommitCount: 1,
    rejectedByReason: { duplicate_event: 1 },
    firstObservedAt: "2026-07-30T10:00:00.000Z",
    lastObservedAt: "2026-07-30T10:00:00.000Z",
    reportedAt: "2026-07-30T10:00:00.000Z",
  });
  assert.deepEqual(reports[1], {
    kind: "terminal",
    hydration: "adopted",
    presentation: "visible_output",
    reportedAt: "2026-07-30T10:00:00.000Z",
  });
});

test("conversation run delivery reporter ignores late events after terminal reporting", async () => {
  const reports: unknown[] = [];
  const reporter = createConversationRunDeliveryReporter({
    report: (_scope, report) => { reports.push(report); },
  });

  reporter.observeAccepted(scope, true);
  reporter.reportTerminal(scope, { hydration: "adopted", presentation: "visible_output" });
  reporter.observeRejected(scope, "unknown_session");
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(reports.length, 2);
  assert.equal((reports[0] as { kind: string }).kind, "aggregate");
  assert.equal((reports[1] as { kind: string }).kind, "terminal");
});

test("conversation run delivery reporter retains only assistant IDs observed while that run is active", () => {
  const reporter = createConversationRunDeliveryReporter({ report: () => {} });
  reporter.observeAccepted(scope, true, { id: "msg-user", role: "user" });
  reporter.observeAccepted(scope, true, { id: "msg-assistant", role: "assistant" });

  assert.deepEqual(reporter.assistantMessageIds(scope), ["msg-assistant"]);
});

test("conversation run delivery reporter upserts final aggregate counts after early delivery", async () => {
  const reports: unknown[] = [];
  const reporter = createConversationRunDeliveryReporter({
    report: (_scope, report) => { reports.push(report); },
    now: () => new Date("2026-07-31T10:00:00.000Z"),
  });

  reporter.observeAccepted(scope, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  reporter.observeAccepted(scope, true);
  reporter.observeRejected(scope, "duplicate_event");
  reporter.reportTerminal(scope, { hydration: "adopted", presentation: "visible_output" });

  assert.deepEqual(reports, [
    {
      kind: "aggregate",
      acceptedEventCount: 1,
      storeCommitCount: 1,
      rejectedByReason: {},
      firstObservedAt: "2026-07-31T10:00:00.000Z",
      lastObservedAt: "2026-07-31T10:00:00.000Z",
      reportedAt: "2026-07-31T10:00:00.000Z",
    },
    {
      kind: "aggregate",
      acceptedEventCount: 2,
      storeCommitCount: 2,
      rejectedByReason: { duplicate_event: 1 },
      firstObservedAt: "2026-07-31T10:00:00.000Z",
      lastObservedAt: "2026-07-31T10:00:00.000Z",
      reportedAt: "2026-07-31T10:00:00.000Z",
    },
    {
      kind: "terminal",
      hydration: "adopted",
      presentation: "visible_output",
      reportedAt: "2026-07-31T10:00:00.000Z",
    },
  ]);
});
