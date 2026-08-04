import { basename, dirname, extname, join, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import {
  readNdjson,
  serverTraceSettlementWaitMs,
} from "./historical-conversation-trace-verifier.mjs";

const SERVER_TRACE_FILE = "send-workflow-trace.server.ndjson";
const FOLLOW_UP_STEP = "document.follow-up.submit";
const DOCUMENT_SCENARIOS = new Set([
  "first-session-document-follow-up",
  "existing-session-document-follow-up",
]);

const asText = (value) => typeof value === "string" ? value.trim() : "";
const asTimestamp = (value) => {
  const parsed = Date.parse(asText(value));
  return Number.isFinite(parsed) ? parsed : null;
};
const failureRecord = (code, detail = {}) => ({ code, ...detail });

const causalSummaryPath = (artifactPath) => {
  const extension = extname(artifactPath);
  const base = extension ? artifactPath.slice(0, -extension.length) : artifactPath;
  return `${base}.causal-summary.json`;
};

export function verifyDocumentContinuationTrace({ artifact, traceEntries, traceReadError = false }) {
  const failures = [];
  if (!DOCUMENT_SCENARIOS.has(artifact?.scenario)) failures.push(failureRecord("unexpected_scenario"));
  const startedAtMs = asTimestamp(artifact?.startedAt);
  const finishedAtMs = asTimestamp(artifact?.finishedAt);
  if (startedAtMs === null || finishedAtMs === null || finishedAtMs < startedAtMs) {
    failures.push(failureRecord("invalid_scenario_window"));
  }
  const steps = Array.isArray(artifact?.timeline?.steps) ? artifact.timeline.steps : [];
  const followUpStep = steps.find((step) => step?.name === FOLLOW_UP_STEP);
  const followUpOffsetMs = Number.isFinite(followUpStep?.startedOffsetMs)
    ? followUpStep.startedOffsetMs
    : null;
  if (!followUpStep || followUpStep.status !== "passed" || followUpOffsetMs === null) {
    failures.push(failureRecord("missing_follow_up_submit_step"));
  }
  const sessionId = asText(artifact?.result?.sessionId);
  if (!sessionId) failures.push(failureRecord("missing_session_identity"));
  if (artifact?.result?.identityAdoptionMatch !== "identity") {
    failures.push(failureRecord("canonical_identity_adoption_missing"));
  }
  if (!asText(artifact?.result?.canonicalUserMessageId)) {
    failures.push(failureRecord("canonical_user_row_missing"));
  }
  if (artifact?.result?.followUpSubmitCount !== 1) {
    failures.push(failureRecord("ui_follow_up_submit_not_unique", { count: artifact?.result?.followUpSubmitCount ?? null }));
  }
  if (artifact?.result?.followUpAssistantTurnCount !== 1) {
    failures.push(failureRecord("ui_follow_up_turn_not_unique", { count: artifact?.result?.followUpAssistantTurnCount ?? null }));
  }
  if (!Array.isArray(traceEntries)) failures.push(failureRecord("invalid_server_trace"));
  if (traceReadError) failures.push(failureRecord("server_trace_unavailable"));

  const followUpStartMs = startedAtMs !== null && followUpOffsetMs !== null
    ? startedAtMs + followUpOffsetMs
    : null;
  const settledThroughMs = finishedAtMs === null ? null : finishedAtMs + 10_000;
  const boundedEntries = Array.isArray(traceEntries) && followUpStartMs !== null && settledThroughMs !== null
    ? traceEntries.filter((entry) => {
      const timestamp = asTimestamp(entry?.at);
      return timestamp !== null && timestamp >= followUpStartMs && timestamp <= settledThroughMs;
    })
    : [];

  const starts = boundedEntries.filter((entry) =>
    entry?.event === "server:conversation-submit-run:start" &&
    asText(entry?.opencodeSessionId) === sessionId);
  if (starts.length !== 1) {
    failures.push(failureRecord("server_follow_up_submit_not_unique", { count: starts.length }));
  }
  const start = starts[0] ?? null;
  const scope = start
    ? {
      workspaceId: asText(start.workspaceId),
      conversationId: asText(start.conversationId),
      opencodeSessionId: sessionId,
      traceId: asText(start.traceId),
      runId: "",
    }
    : null;
  if (!scope?.workspaceId || !scope?.conversationId || !scope?.traceId) {
    failures.push(failureRecord("follow_up_scope_incomplete"));
  }

  const admissions = scope
    ? boundedEntries.filter((entry) =>
      entry?.event === "server:conversation-run:admitted" &&
      asText(entry?.traceId) === scope.traceId &&
      asText(entry?.workspaceId) === scope.workspaceId &&
      asText(entry?.conversationId) === scope.conversationId)
    : [];
  if (admissions.length !== 1) {
    failures.push(failureRecord("follow_up_admission_not_unique", { count: admissions.length }));
  }
  const admission = admissions[0] ?? null;
  if (scope && admission) scope.runId = asText(admission.runId);
  if (!scope?.runId) failures.push(failureRecord("follow_up_run_missing"));
  if (admission?.correlation?.causation?.queueItemId !== null) {
    failures.push(failureRecord("follow_up_was_not_directly_admitted"));
  }

  const successfulSubmits = scope?.runId
    ? boundedEntries.filter((entry) =>
      entry?.event === "server:conversation-run:opencode-submit" &&
      asText(entry?.runId) === scope.runId &&
      asText(entry?.outcome) === "ok")
    : [];
  if (successfulSubmits.length !== 1) {
    failures.push(failureRecord("follow_up_opencode_submit_not_unique", { count: successfulSubmits.length }));
  }
  const queued = scope
    ? boundedEntries.filter((entry) =>
      entry?.event === "server:conversation-run:queued" &&
      asText(entry?.workspaceId) === scope.workspaceId &&
      asText(entry?.conversationId) === scope.conversationId &&
      asText(entry?.opencodeSessionId) === scope.opencodeSessionId)
    : [];
  if (queued.length > 0) failures.push(failureRecord("follow_up_was_queued", { count: queued.length }));

  return {
    schema: "veslo-document-continuation-causal-summary/v1",
    scenario: artifact?.scenario ?? null,
    outcome: failures.length === 0 ? "passed" : "failed",
    scope: scope?.workspaceId && scope?.conversationId && scope?.runId ? scope : null,
    evidence: {
      serverFollowUpStarts: starts.length,
      directAdmissions: admissions.length,
      successfulOpenCodeSubmits: successfulSubmits.length,
      queuedRecords: queued.length,
      canonicalIdentityAdoption: artifact?.result?.identityAdoptionMatch ?? null,
      visibleAssistantTurns: artifact?.result?.followUpAssistantTurnCount ?? null,
    },
    failures,
  };
}

export async function verifyDocumentContinuationArtifact(artifactPath, { traceLogDir } = {}) {
  const resolvedArtifactPath = resolve(artifactPath);
  const artifact = JSON.parse(await readFile(resolvedArtifactPath, "utf8"));
  const resolvedTraceLogDir = asText(traceLogDir) || asText(artifact?.runtime?.traceLogDir);
  if (!resolvedTraceLogDir) throw new Error("Scenario artifact has no server trace log directory.");
  const tracePath = join(resolvedTraceLogDir, SERVER_TRACE_FILE);
  let traceEntries = [];
  let traceReadError = false;
  try {
    const waitMs = serverTraceSettlementWaitMs(artifact);
    if (waitMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
    traceEntries = await readNdjson(tracePath);
  } catch {
    traceReadError = true;
  }
  const summary = verifyDocumentContinuationTrace({ artifact, traceEntries, traceReadError });
  const outputPath = causalSummaryPath(resolvedArtifactPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({
    ...summary,
    artifact: basename(resolvedArtifactPath),
    serverTrace: SERVER_TRACE_FILE,
  }, null, 2)}\n`, "utf8");
  return { summary, outputPath };
}
