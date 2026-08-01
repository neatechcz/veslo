import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildRemoteCommand, buildRemoteProgram, feedbackDiagnosticArtifactName, formatReport, parseArgs, summarizeDiagnosticLine, writeReportOutput } from "./feedback-diagnostic-report.mjs";

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
    runId: "run_1",
    conversationId: "conv_1",
    clientMessageId: "msg_1",
    status: null,
    code: null,
    reason: null,
    terminalError: null,
  });
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
});
