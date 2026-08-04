import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendDiagnosticAnomaly, buildRemoteCommand, buildRemoteProgram, feedbackDiagnosticArtifactName, formatReport, normalizeOperationCorrelation, normalizeTraceLine, parseArgs, summarizeDiagnosticLine, writeReportOutput } from "./feedback-diagnostic-report.mjs";

test("feedback diagnostic report defaults to the latest feedback without exposing text", () => {
  assert.deepEqual(parseArgs([]), {
    feedbackId: null,
    includeFeedbackText: false,
    json: false,
    outputPath: null,
    outputDirectory: null,
    includeEvents: false,
    maxAnomalies: 30,
  });
});

test("feedback diagnostic report accepts an explicit feedback id and text opt-in", () => {
  assert.deepEqual(parseArgs(["--feedback", "fb_123", "--include-feedback-text", "--json", "--max-anomalies", "4"]), {
    feedbackId: "fb_123",
    includeFeedbackText: true,
    json: true,
    outputPath: null,
    outputDirectory: null,
    includeEvents: false,
    maxAnomalies: 4,
  });
});

test("feedback diagnostic report summarizes provider start timeout without returning raw payload", () => {
  const summary = summarizeDiagnosticLine(
    '[veslo:send-workflow] server:conversation-run:ai-gateway-provider-start-watch:timeout {"runId":"run_1","conversationId":"conv_1","clientMessageId":"msg_1"}',
  );
  assert.deepEqual(summary, {
    kind: "provider_start_timeout",
    event: "server:conversation-run:ai-gateway-provider-start-watch:timeout",
    workspaceId: null,
    runId: "run_1",
    blockingRunId: null,
    conversationId: "conv_1",
    clientMessageId: "msg_1",
    status: null,
    code: null,
    reason: null,
    terminalError: null,
    classification: null,
    runtimeReadyForSuccessor: null,
    engineOwnerState: null,
    unavailableReason: null,
    generationEvidenceKind: null,
    decision: null,
    pendingState: null,
    eligibility: null,
    result: null,
    matchKind: null,
    candidateCount: null,
    unresolvedReason: null,
  });
});

test("feedback diagnostic report names an unresolved historical handoff with its evidence fields", () => {
  const summary = summarizeDiagnosticLine(
    '[veslo:runtime-trace] server:conversation-run:predecessor-classified {"runId":"run_old","conversationId":"conv_old","classification":"terminal_handoff_unresolved","reason":"process_identity_unavailable","runtimeReadyForSuccessor":null,"engineOwnerState":"attached","unavailableReason":"no_current_engine"}',
  );
  assert.deepEqual(summary, {
    kind: "terminal_handoff_unresolved",
    event: "server:conversation-run:predecessor-classified",
    workspaceId: null,
    runId: "run_old",
    blockingRunId: null,
    conversationId: "conv_old",
    clientMessageId: null,
    status: null,
    code: null,
    reason: "process_identity_unavailable",
    terminalError: null,
    classification: "terminal_handoff_unresolved",
    runtimeReadyForSuccessor: null,
    engineOwnerState: "attached",
    unavailableReason: "no_current_engine",
    generationEvidenceKind: null,
    decision: null,
    pendingState: null,
    eligibility: null,
    result: null,
    matchKind: null,
    candidateCount: null,
    unresolvedReason: null,
  });
});

test("feedback diagnostic report summarizes mixed production-shaped trace fixtures", async () => {
  const fixture = await readFile(new URL("./test-fixtures/feedback-diagnostic-mixed-events.ndjson", import.meta.url), "utf8");
  const rows = fixture.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const traces = rows
    .filter((row) => row.recordType === "event")
    .map((row) => normalizeTraceLine(row.payload.line));

  assert.deepEqual(new Set(traces.filter((trace) => trace && !trace.malformed).map((trace) => trace.format)), new Set(["legacy", "otel"]));
  assert.equal(traces.filter((trace) => trace?.malformed).length, 1);
  assert.equal(traces.find((trace) => trace?.event === "proxy").format, "legacy");

  const summaries = rows
    .filter((row) => row.recordType === "event")
    .map((row) => ({ at: row.at, ...summarizeDiagnosticLine(row.payload.line) }))
    .filter((summary) => summary.kind);
  const noEngine = summaries.find((summary) => summary.reason === "no_current_engine" && summary.classification);
  assert.equal(noEngine.kind, "terminal_handoff_unresolved");
  assert.equal(noEngine.workspaceId, "workspace_fixture");
  assert.equal(noEngine.runId, "run_blocking_no_engine");
  assert.equal(noEngine.unavailableReason, "no_current_engine");

  const transportFailure = summaries.find((summary) => summary.reason === "request_transport_error");
  assert.equal(transportFailure.runId, "run_blocking_transport");
  assert.equal(transportFailure.unavailableReason, "request_transport_error");

  const blockingDecision = summaries.find((summary) => summary.decision === "blocked_terminal_handoff_unresolved");
  assert.equal(blockingDecision.kind, "blocked_terminal_handoff_unresolved");
  assert.equal(blockingDecision.runId, "run_attempt_1");
  assert.equal(blockingDecision.blockingRunId, "run_blocking_no_engine");

  const adoption = summaries.find((summary) => summary.kind === "pending_adoption_reconciliation");
  assert.equal(adoption.workspaceId, null);
  assert.deepEqual({
    pendingState: adoption.pendingState,
    eligibility: adoption.eligibility,
    result: adoption.result,
    matchKind: adoption.matchKind,
    candidateCount: adoption.candidateCount,
    unresolvedReason: adoption.unresolvedReason,
  }, {
    pendingState: "outcome-unknown",
    eligibility: "outcome-unknown",
    result: "unresolved",
    matchKind: null,
    candidateCount: 0,
    unresolvedReason: "no-match",
  });

  const output = formatReport({
    feedback: { id: "fb_fixture", status: "stored", submittedAt: null, screenshotStatus: "captured" },
    diagnostics: {
      eventCount: rows.length - 1, payloadBytes: 1, firstEventAt: null, lastEventAt: null, sources: {},
      signals: Object.fromEntries(summaries.map((summary) => [summary.kind, 1])),
      runs: [{ runId: "run_attempt_1", finalStatus: null }], runsTruncated: false, operations: [], anomalies: summaries,
      malformedTraceEnvelopeEvents: 1,
      scope: { status: "scoped_from_user_capture", primaryWorkspaceId: "workspace_fixture", primaryWorkspaceEventCount: 5, outOfScopeEventCount: 0, unscopedEventCount: 1 },
    },
  }, false);
  assert.match(output, /workspace workspace_fixture/);
  assert.match(output, /run=run_attempt_1/);
  assert.match(output, /reason=no_current_engine/);
  assert.match(output, /unavailable=no_current_engine/);
  assert.match(output, /decision=blocked_terminal_handoff_unresolved/);
  assert.match(output, /Malformed trace envelopes: 1/);
  assert.doesNotMatch(output, /C:\\/);
});

test("feedback diagnostic report drops non-allowlisted OTel attributes", () => {
  const summary = summarizeDiagnosticLine(JSON.stringify({
    body: "server:conversation-run:admission-decision",
    attributes: {
      workspaceId: "workspace_safe",
      runId: "run_safe",
      decision: "blocked_terminal_handoff_unresolved",
      reason: "no_current_engine",
      prompt: "private_prompt",
      transcript: "private_transcript",
      filename: "private_filename",
      path: "private_path",
      token: "private_token",
      credential: "private_credential",
    },
  }));
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /private_(prompt|transcript|filename|path|token|credential)/);
});
test("feedback diagnostic report accepts only the versioned allowlisted operation correlation", () => {
  assert.deepEqual(normalizeOperationCorrelation({
    version: 1,
    authoritativeOperation: { kind: "conversation-run", id: "run_1" },
    causation: { clientMessageId: "msg_1", queueItemId: "queue_1", captureId: "capture_1" },
    scope: { workspaceId: "workspace_1", conversationId: "conversation_1" },
    phase: "admitted",
    outcome: "accepted",
    reason: null,
  }), {
    version: 1,
    authoritativeOperation: { kind: "conversation-run", id: "run_1" },
    causation: { clientMessageId: "msg_1", queueItemId: "queue_1", captureId: "capture_1" },
    scope: { workspaceId: "workspace_1", conversationId: "conversation_1" },
    phase: "admitted",
    outcome: "accepted",
    reason: null,
  });
  assert.equal(normalizeOperationCorrelation({ version: 1, authoritativeOperation: { kind: "feedback", id: "fb_1" } }), null);
});

test("feedback diagnostic report uses one constrained Den read command", () => {
  const command = buildRemoteCommand({
    feedbackId: null,
    includeFeedbackText: false,
    json: false,
    maxAnomalies: 30,
  });
  assert.match(command, /docker compose/);
  assert.match(command, /exec -T den node -e/);
  assert.doesNotMatch(command, /INSERT|UPDATE|DELETE|DROP/i);
});

test("feedback diagnostic report hides feedback text unless explicitly requested", () => {
  const report = {
    feedback: {
      id: "fb_1",
      status: "stored",
      submittedAt: "2026-08-01T14:19:19.000Z",
      screenshotStatus: "captured",
      title: "private title",
      description: "private description",
    },
    diagnostics: null,
  };
  const defaultOutput = formatReport(report, false);
  assert.doesNotMatch(defaultOutput, /private title|private description/);
  assert.match(formatReport(report, true), /private title[\s\S]*private description/);
});

test("feedback diagnostic report prints authoritative operation groups when present", () => {
  const output = formatReport({
    feedback: { id: "fb_1", status: "stored", submittedAt: null, screenshotStatus: "captured" },
    diagnostics: {
      eventCount: 1, payloadBytes: 1, firstEventAt: null, lastEventAt: null, sources: {}, signals: {}, runs: [], runsTruncated: false,
      operations: [{ operation: { kind: "feedback", id: "fb_1" }, events: 1 }], anomalies: [],
    },
  }, false);
  assert.match(output, /Operations: feedback:fb_1=1\./);
});

test("feedback diagnostic report labels a capture-scoped incident without mixing other workspaces", () => {
  const output = formatReport({
    feedback: { id: "fb_1", status: "stored", submittedAt: null, screenshotStatus: "captured" },
    diagnostics: {
      eventCount: 4, payloadBytes: 1, firstEventAt: null, lastEventAt: null, sources: {}, signals: {}, runs: [], runsTruncated: false,
      operations: [], anomalies: [],
      scope: {
        status: "scoped_from_user_capture",
        primaryWorkspaceId: "workspace_feedback",
        primaryWorkspaceEventCount: 2,
        outOfScopeEventCount: 1,
        unscopedEventCount: 1,
      },
    },
  }, false);
  assert.match(output, /workspace workspace_feedback; 2 scoped events, 1 out-of-scope events, 1 unscoped events/);
});

test("feedback diagnostic report keeps primary-workspace anomalies after the capture-wide cap is full", () => {
  const diagnostics = { anomalies: [{ kind: "outside" }] };
  const primaryWorkspace = { anomalies: [] };

  appendDiagnosticAnomaly(diagnostics, primaryWorkspace, { kind: "primary" }, 1);

  assert.deepEqual(diagnostics.anomalies, [{ kind: "outside" }]);
  assert.deepEqual(primaryWorkspace.anomalies, [{ kind: "primary" }]);
});

test("feedback diagnostic report writes to an explicit path and creates its parent directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "veslo-feedback-diagnostics-"));
  try {
    const outputPath = await writeReportOutput(join(directory, "nested", "report.txt"), "diagnostic summary\n");
    assert.equal(await readFile(outputPath, "utf8"), "diagnostic summary\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("feedback diagnostic report never overwrites an explicit output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "veslo-feedback-diagnostics-"));
  try {
    const outputPath = join(directory, "report.txt");
    await writeReportOutput(outputPath, "first\n");
    await assert.rejects(() => writeReportOutput(outputPath, "second\n"), { code: "EEXIST" });
    assert.equal(await readFile(outputPath, "utf8"), "first\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("feedback diagnostic report names generated artifacts by feedback, timestamp, and kind", () => {
  assert.equal(
    feedbackDiagnosticArtifactName(
      { feedbackId: "fb_123", includeEvents: true, json: false },
      new Date("2026-08-01T14:19:19.919Z"),
      "a1b2c3d4",
    ),
    "feedback-diagnostics-fb_123-20260801T141919Z-a1b2c3d4-events.ndjson",
  );
});

test("feedback diagnostic report enables full events only as an explicit option", () => {
  const options = parseArgs(["--include-events", "--output-dir", ".tmp/feedback-diagnostics"]);
  assert.equal(options.includeEvents, true);
  assert.equal(options.outputDirectory, ".tmp/feedback-diagnostics");
  assert.match(buildRemoteProgram(options), /recordType: "event"/);
});

test("feedback diagnostic report streams full event rows instead of retaining the capture array", () => {
  const remoteProgram = buildRemoteProgram(parseArgs(["--include-events", "--output", "report.ndjson"]));
  assert.match(remoteProgram, /function streamRows/);
  assert.match(remoteProgram, /await streamRows\(connection, "SELECT event_timestamp/);
  assert.doesNotMatch(remoteProgram, /const rows = await query\(connection, "SELECT event_timestamp/);
  assert.match(remoteProgram, /diagnostics\.runs\.size >= 2000/);
  assert.match(remoteProgram, /runsTruncated: diagnostics\.omittedRunObservations > 0/);
  assert.match(remoteProgram, /malformedCorrelationEvents/);
  assert.match(remoteProgram, /correlation_malformed/);
  assert.equal(remoteProgram.match(/function normalizeTraceLine/g)?.length, 1);
  assert.doesNotMatch(remoteProgram, /function traceSummary/);
  assert.match(remoteProgram, /malformedTraceEnvelopeEvents/);
  assert.match(remoteProgram, /trace_envelope_malformed/);
  assert.match(remoteProgram, /scoped_from_user_capture/);
  assert.match(remoteProgram, /outOfScopeEventCount/);
});
