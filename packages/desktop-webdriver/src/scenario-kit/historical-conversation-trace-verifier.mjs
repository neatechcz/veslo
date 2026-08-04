import { basename, dirname, extname, join, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const CONTINUATION_STEP = "historical.continuation.submit";
const SERVER_TRACE_FILE = "send-workflow-trace.server.ndjson";
const HISTORICAL_SCENARIOS = new Set([
  "historical-conversation-roundtrip",
  "historical-existing-conversation-continuation",
  "historical-idle-suspend-continuation",
]);
// The visible assistant turn can settle shortly before the server's next
// lifecycle reconcile records runtimeReadyForSuccessor. Keep that durable
// handoff evidence in the same bounded operation window without turning the
// verifier into an unbounded log scan.
const SERVER_SETTLEMENT_GRACE_MS = 10_000;

const asText = (value) => typeof value === "string" ? value.trim() : "";

const asTimestamp = (value) => {
  const parsed = Date.parse(asText(value));
  return Number.isFinite(parsed) ? parsed : null;
};

export function serverTraceSettlementWaitMs(artifact, nowMs = Date.now()) {
  const finishedAtMs = asTimestamp(artifact?.finishedAt);
  if (finishedAtMs === null || !Number.isFinite(nowMs)) return 0;
  // The verifier's causal window explicitly includes a short post-UI grace for
  // the next server reconcile. Reading an append-only NDJSON trace before that
  // window has elapsed turns a healthy terminal handoff into a false failure.
  // Keep the wait bounded by exactly the documented window, never by a retry.
  return Math.max(0, Math.min(SERVER_SETTLEMENT_GRACE_MS, finishedAtMs + SERVER_SETTLEMENT_GRACE_MS - nowMs));
}

const waitForServerTraceSettlement = async (artifact) => {
  const delayMs = serverTraceSettlementWaitMs(artifact);
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
};

const causalSummaryPath = (artifactPath) => {
  const extension = extname(artifactPath);
  const base = extension ? artifactPath.slice(0, -extension.length) : artifactPath;
  return `${base}.causal-summary.json`;
};

const failureRecord = (code, detail = {}) => ({ code, ...detail });

const isServerFailure = (entry) => {
  const event = asText(entry?.event);
  const outcome = asText(entry?.outcome);
  const status = asText(entry?.status);
  return /(?:^|[:_-])(?:error|failed)(?:$|[:_-])/i.test(event) ||
    outcome === "failed" ||
    status === "failed";
};

const summarizeFailure = (entry) => ({
  at: asText(entry?.at) || null,
  event: asText(entry?.event) || null,
  outcome: asText(entry?.outcome) || null,
  status: asText(entry?.status) || null,
});

const eventForRun = (entry, scope) =>
  asText(entry?.runId) === scope.runId ||
  (asText(entry?.workspaceId) === scope.workspaceId &&
    asText(entry?.conversationId) === scope.conversationId);

const sortedWorkspaceCounts = (entries) => {
  const counts = new Map();
  for (const entry of entries) {
    if (!isServerFailure(entry)) continue;
    const workspaceId = asText(entry?.workspaceId) || "unknown";
    counts.set(workspaceId, (counts.get(workspaceId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([workspaceId, count]) => ({ workspaceId, count }))
    .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
};

export function verifyHistoricalConversationTrace({ artifact, traceEntries, traceReadError = false }) {
  const failures = [];
  if (!HISTORICAL_SCENARIOS.has(artifact?.scenario)) {
    failures.push(failureRecord("unexpected_scenario"));
  }
  const startedAtMs = asTimestamp(artifact?.startedAt);
  const finishedAtMs = asTimestamp(artifact?.finishedAt);
  const timelineSteps = Array.isArray(artifact?.timeline?.steps) ? artifact.timeline.steps : [];
  const continuationStep = timelineSteps.find((step) => step?.name === CONTINUATION_STEP);
  const continuationOffsetMs = Number.isFinite(continuationStep?.startedOffsetMs)
    ? continuationStep.startedOffsetMs
    : null;
  const seedSessionId = asText(artifact?.result?.seedSessionId) || asText(artifact?.result?.historicalSessionId);
  const interludeSessionId = asText(artifact?.result?.interludeSessionId);
  if (startedAtMs === null || finishedAtMs === null || finishedAtMs < startedAtMs) {
    failures.push(failureRecord("invalid_scenario_window"));
  }
  if (!continuationStep || continuationStep.status !== "passed" || continuationOffsetMs === null) {
    failures.push(failureRecord("missing_continuation_submit_step"));
  }
  if (!seedSessionId || (artifact?.scenario === "historical-conversation-roundtrip" &&
    (!interludeSessionId || seedSessionId === interludeSessionId))) {
    failures.push(failureRecord("invalid_scenario_session_identity"));
  }
  const idleSuspendScenario = artifact?.scenario === "historical-idle-suspend-continuation";
  if (idleSuspendScenario && artifact?.result?.suspendedChildKind !== "direct") {
    failures.push(failureRecord("idle_suspend_child_was_not_direct"));
  }
  if (idleSuspendScenario && artifact?.result?.suspendedChildExitObserved !== true) {
    failures.push(failureRecord("idle_suspend_child_exit_not_observed"));
  }
  if (idleSuspendScenario && artifact?.result?.continuationSubmitCount !== 1) {
    failures.push(failureRecord("idle_suspend_ui_submit_not_unique", {
      count: artifact?.result?.continuationSubmitCount ?? null,
    }));
  }
  if (idleSuspendScenario && artifact?.result?.continuationOutputCount !== 1) {
    failures.push(failureRecord("idle_suspend_ui_turn_not_unique", {
      count: artifact?.result?.continuationOutputCount ?? null,
    }));
  }
  if (!Array.isArray(traceEntries)) {
    failures.push(failureRecord("invalid_server_trace"));
  }
  if (traceReadError) failures.push(failureRecord("server_trace_unavailable"));

  const continuationStartMs = startedAtMs !== null && continuationOffsetMs !== null
    ? startedAtMs + continuationOffsetMs
    : null;
  const serverSettledThroughMs = finishedAtMs === null ? null : finishedAtMs + SERVER_SETTLEMENT_GRACE_MS;
  const boundedEntries = Array.isArray(traceEntries) && continuationStartMs !== null && serverSettledThroughMs !== null
    ? traceEntries.filter((entry) => {
      const timestamp = asTimestamp(entry?.at);
      return timestamp !== null && timestamp >= continuationStartMs && timestamp <= serverSettledThroughMs;
    })
    : [];
  const continuationStarts = boundedEntries.filter((entry) =>
    entry?.event === "server:conversation-submit-run:start" &&
    asText(entry?.opencodeSessionId) === seedSessionId,
  );
  if (continuationStarts.length !== 1) {
    failures.push(failureRecord("continuation_submit_not_unique", { count: continuationStarts.length }));
  }
  const continuationStart = continuationStarts[0] ?? null;
  const scope = continuationStart
    ? {
      workspaceId: asText(continuationStart.workspaceId),
      conversationId: asText(continuationStart.conversationId),
      opencodeSessionId: seedSessionId,
      traceId: asText(continuationStart.traceId),
      runId: "",
    }
    : null;
  if (!scope?.workspaceId || !scope?.conversationId || !scope?.traceId) {
    failures.push(failureRecord("continuation_scope_incomplete"));
  }

  const admissions = scope
    ? boundedEntries.filter((entry) =>
      entry?.event === "server:conversation-run:admitted" &&
      asText(entry?.traceId) === scope.traceId &&
      asText(entry?.workspaceId) === scope.workspaceId &&
      asText(entry?.conversationId) === scope.conversationId,
    )
    : [];
  if (admissions.length !== 1) {
    failures.push(failureRecord("continuation_admission_not_unique", { count: admissions.length }));
  }
  const admission = admissions[0] ?? null;
  if (scope && admission) scope.runId = asText(admission.runId);
  if (!scope?.runId) failures.push(failureRecord("continuation_run_missing"));
  if (admission?.correlation?.causation?.queueItemId !== null) {
    failures.push(failureRecord("continuation_was_not_directly_admitted"));
  }

  const successfulSubmits = scope?.runId
    ? boundedEntries.filter((entry) =>
      entry?.event === "server:conversation-run:opencode-submit" &&
      asText(entry?.runId) === scope.runId &&
      asText(entry?.outcome) === "ok",
    )
    : [];
  if (successfulSubmits.length !== 1) {
    failures.push(failureRecord("continuation_submit_not_unique_or_successful", { count: successfulSubmits.length }));
  }

  const completedReconciles = scope?.runId
    ? boundedEntries.filter((entry) =>
      entry?.event === "server:conversation-run:lifecycle-reconcile" &&
      asText(entry?.runId) === scope.runId &&
      asText(entry?.status) === "completed" &&
      entry?.runtimeReadyForSuccessor === true,
    )
    : [];
  if (completedReconciles.length !== 1) {
    failures.push(failureRecord("continuation_terminal_handoff_not_proven", { count: completedReconciles.length }));
  }

  const queueRecords = scope
    ? boundedEntries.filter((entry) =>
      entry?.event === "server:conversation-run:queued" &&
      asText(entry?.workspaceId) === scope.workspaceId &&
      asText(entry?.conversationId) === scope.conversationId &&
      asText(entry?.opencodeSessionId) === scope.opencodeSessionId,
    )
    : [];
  if (queueRecords.length > 0) {
    failures.push(failureRecord("continuation_was_queued", { count: queueRecords.length }));
  }

  const terminalHandoffRecoveryStarts = idleSuspendScenario && scope
    ? boundedEntries.filter((entry) =>
      entry?.event === "server:conversation-run:terminal-handoff-recovery:start" &&
      asText(entry?.workspaceId) === scope.workspaceId &&
      asText(entry?.conversationId) === scope.conversationId &&
      asText(entry?.unavailableReason) === "no_current_engine")
    : [];
  const terminalHandoffRecoveryProofs = idleSuspendScenario && scope
    ? boundedEntries.filter((entry) =>
      entry?.event === "server:conversation-run:terminal-handoff-recovery:result" &&
      asText(entry?.workspaceId) === scope.workspaceId &&
      asText(entry?.conversationId) === scope.conversationId &&
      asText(entry?.outcome) === "lost_proven")
    : [];
  // The successor may be admitted through either shape. A plain `registered`
  // decision is the clean path, where predecessor classification already
  // resolved the lost owner; `registered-after-proven-handoff-recovery` is the
  // conflict path, where registration first collided with the stale owner.
  // Both are valid proof as long as the admission follows the proven recovery,
  // which the ordering check below still enforces.
  const recoveredAdmissionDecisions = new Set([
    "registered",
    "registered-after-proven-handoff-recovery",
  ]);
  const recoveredAdmissions = idleSuspendScenario && scope
    ? boundedEntries.filter((entry) =>
      entry?.event === "server:conversation-run:admission-decision" &&
      asText(entry?.workspaceId) === scope.workspaceId &&
      asText(entry?.conversationId) === scope.conversationId &&
      asText(entry?.runId) === scope.runId &&
      recoveredAdmissionDecisions.has(asText(entry?.decision)))
    : [];
  const recoveryStartAt = asTimestamp(terminalHandoffRecoveryStarts[0]?.at);
  const recoveryProofAt = asTimestamp(terminalHandoffRecoveryProofs[0]?.at);
  const recoveredAdmissionAt = asTimestamp(recoveredAdmissions[0]?.at);
  // Recovery only engages when the suspended generation still owned a stale
  // terminal run. A completed seed run can release its owner before the
  // follow-up, and then the successor is admitted without any recovery at all.
  // That is a healthier outcome, not a regression, so recovery evidence is
  // asserted strictly but only once recovery actually started. The scenario
  // separately proves the engine really was stopped with an observed direct
  // child exit, so this cannot silently degrade into "nothing was suspended".
  const recoveryAttempted = terminalHandoffRecoveryStarts.length > 0;
  const recoverySequenceProven = recoveryStartAt !== null &&
    recoveryProofAt !== null &&
    recoveredAdmissionAt !== null &&
    recoveryStartAt < recoveryProofAt &&
    recoveryProofAt < recoveredAdmissionAt;
  if (idleSuspendScenario && terminalHandoffRecoveryStarts.length > 1) {
    failures.push(failureRecord("no_current_engine_recovery_not_unique", { count: terminalHandoffRecoveryStarts.length }));
  }
  if (idleSuspendScenario && recoveryAttempted && terminalHandoffRecoveryProofs.length !== 1) {
    failures.push(failureRecord("terminal_handoff_recovery_not_proven", { count: terminalHandoffRecoveryProofs.length }));
  }
  if (idleSuspendScenario && recoveredAdmissions.length !== 1) {
    failures.push(failureRecord("recovered_admission_not_unique", { count: recoveredAdmissions.length }));
  }
  if (idleSuspendScenario && recoveryAttempted && !recoverySequenceProven) {
    failures.push(failureRecord("no_current_engine_recovery_sequence_not_proven"));
  }

  const inScopeFailures = scope
    ? boundedEntries.filter((entry) => isServerFailure(entry) && eventForRun(entry, scope))
    : [];
  if (inScopeFailures.length > 0) {
    failures.push(failureRecord("continuation_server_failure", { count: inScopeFailures.length }));
  }
  const outOfScopeFailureCounts = sortedWorkspaceCounts(
    scope
      ? boundedEntries.filter((entry) => !eventForRun(entry, scope))
      : boundedEntries,
  );

  return {
    schema: "veslo-historical-conversation-causal-summary/v1",
    scenario: artifact?.scenario ?? "historical-conversation-roundtrip",
    outcome: failures.length === 0 ? "passed" : "failed",
    window: {
      startedAt: artifact?.startedAt ?? null,
      continuationStartedAt: continuationStartMs === null ? null : new Date(continuationStartMs).toISOString(),
      finishedAt: artifact?.finishedAt ?? null,
      serverSettledThrough: serverSettledThroughMs === null ? null : new Date(serverSettledThroughMs).toISOString(),
    },
    scope: scope && scope.workspaceId && scope.conversationId && scope.runId
      ? scope
      : null,
    evidence: {
      continuationSubmitStarts: continuationStarts.length,
      directAdmissions: admissions.length,
      successfulOpenCodeSubmits: successfulSubmits.length,
      completedReadyReconciles: completedReconciles.length,
      queuedRecords: queueRecords.length,
      noCurrentEngineRecoveryStarts: terminalHandoffRecoveryStarts.length,
      lostProvenRecoveryResults: terminalHandoffRecoveryProofs.length,
      recoveredAdmissions: recoveredAdmissions.length,
      recoveryAttempted: idleSuspendScenario ? recoveryAttempted : null,
      recoverySequenceProven: idleSuspendScenario ? recoverySequenceProven : null,
      inScopeFailures: inScopeFailures.map(summarizeFailure),
      outOfScopeFailureCounts,
    },
    failures,
  };
}

export async function readNdjson(path) {
  const text = await readFile(path, "utf8");
  const entries = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      throw new Error(`Server trace contains invalid NDJSON at line ${index + 1}.`);
    }
  }
  return entries;
}

export async function verifyHistoricalConversationArtifact(artifactPath, { traceLogDir } = {}) {
  const resolvedArtifactPath = resolve(artifactPath);
  const artifact = JSON.parse(await readFile(resolvedArtifactPath, "utf8"));
  const resolvedTraceLogDir = asText(traceLogDir) || asText(artifact?.runtime?.traceLogDir);
  if (!resolvedTraceLogDir) throw new Error("Scenario artifact has no server trace log directory.");
  const tracePath = join(resolvedTraceLogDir, SERVER_TRACE_FILE);
  let traceEntries = [];
  let traceReadError = false;
  try {
    await waitForServerTraceSettlement(artifact);
    traceEntries = await readNdjson(tracePath);
  } catch {
    // A missing, locked, or malformed trace is evidence that cannot prove a
    // continuation safe. Still write the companion summary so the failed run
    // is diagnosable without reproducing or searching the whole profile.
    traceReadError = true;
  }
  const summary = verifyHistoricalConversationTrace({ artifact, traceEntries, traceReadError });
  const outputPath = causalSummaryPath(resolvedArtifactPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({
    ...summary,
    artifact: basename(resolvedArtifactPath),
    serverTrace: SERVER_TRACE_FILE,
  }, null, 2)}\n`, "utf8");
  return { summary, outputPath };
}
