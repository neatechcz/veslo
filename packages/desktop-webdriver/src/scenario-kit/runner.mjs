import { connectIsolatedWebDriver, connectLiveWebDriver } from "../attach-smoke.mjs";
import { beginConsoleCapture, collectDevConsoleLogs, writeScenarioArtifact } from "./artifacts.mjs";
import { expectNoVisibleRuntimeError, expectRunCompleted } from "./assertions.mjs";
import { assertMutationAuthorized } from "./safety.mjs";
import { captureUiState } from "./snapshots.mjs";
import { createScenarioTimeline } from "./timeline.mjs";
import { collectSendWorkflowTrace, collectTranscriptTraceSummary } from "./transcript-trace-summary.mjs";
import { collectDiagnosticLogManifest } from "./diagnostic-log-manifest.mjs";

async function runWebDriverScenario({ scenarioName, runtimeInfoPath, mutations = false, execute, env = process.env, connect }) {
  if (mutations) assertMutationAuthorized(env);
  const startedAt = new Date().toISOString();
  let connection;
  let result;
  let thrown;
  let artifactPath;
  const timeline = createScenarioTimeline();
  const snapshots = [];
  const snapshot = async (label) => {
    const state = await captureUiState(connection.browser, label);
    snapshots.push(state);
    return state;
  };
  try {
    connection = await connect(runtimeInfoPath, { env });
    await beginConsoleCapture(connection.browser);
    await snapshot("initial");
    result = await execute({
      browser: connection.browser,
      runtimeInfo: connection.runtimeInfo,
      nativeDescriptor: connection.nativeDescriptor,
      step: timeline.step,
      snapshot,
      expectNoVisibleRuntimeError: () => expectNoVisibleRuntimeError(connection.browser),
      expectRunCompleted: (workspaceLabel, timeout) => expectRunCompleted(connection.browser, workspaceLabel, timeout),
      transcriptTraceSummary: () => collectTranscriptTraceSummary(connection.browser, startedAt),
      sendWorkflowTrace: () => collectSendWorkflowTrace(connection.browser),
    });
    await snapshot("final");
  } catch (error) {
    thrown = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (connection?.browser) {
      if (snapshots.at(-1)?.label !== "final") {
        await snapshot("final").catch(() => {});
      }
      const consoleLogs = await collectDevConsoleLogs(connection.browser).catch((error) => ({ collectionError: String(error) }));
      const transcriptTrace = await collectTranscriptTraceSummary(connection.browser, startedAt)
        .catch((error) => ({ collectionError: String(error) }));
      const diagnosticLogs = await collectDiagnosticLogManifest(connection.runtimeInfo)
        .catch((error) => ({ collectionError: String(error) }));
      artifactPath = await writeScenarioArtifact({
        scenarioName,
        startedAt,
        finishedAt: new Date().toISOString(),
        runtimeInfo: connection.runtimeInfo,
        nativeDescriptor: connection.nativeDescriptor,
        mutations,
        result,
        error: thrown,
        consoleLogs,
        transcriptTrace,
        diagnosticLogs,
        timeline: timeline.summary(),
        snapshots,
      });
      await connection.browser.deleteSession();
    }
  }
  if (thrown) {
    if (artifactPath) thrown.artifactPath = artifactPath;
    throw thrown;
  }
  return { ...result, artifactPath };
}

export async function runLiveScenario(input) {
  return runWebDriverScenario({ ...input, connect: connectLiveWebDriver });
}

export async function runIsolatedScenario(input) {
  return runWebDriverScenario({ ...input, connect: connectIsolatedWebDriver });
}
