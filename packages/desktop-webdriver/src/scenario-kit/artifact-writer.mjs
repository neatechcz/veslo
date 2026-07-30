import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeScenarioArtifactValue } from "./redaction.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");

function safeTimestamp(now) {
  return now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export function scenarioArtifactPath(scenarioName, now = new Date()) {
  const safeName = scenarioName.replaceAll(/[^a-z0-9-]+/gi, "-").replaceAll(/^-+|-+$/g, "") || "scenario";
  return join(repoRoot, ".tmp", "webdriver-scenarios", `${safeTimestamp(now)}-${safeName}.json`);
}

export async function writeScenarioArtifact({ scenarioName, startedAt, finishedAt, runtimeInfo, nativeDescriptor, mutations, result, error, consoleLogs, transcriptTrace, diagnosticLogs, timeline, snapshots }) {
  const path = scenarioArtifactPath(scenarioName);
  await mkdir(dirname(path), { recursive: true });
  const artifact = sanitizeScenarioArtifactValue({
    schema: "veslo-live-webdriver-scenario/v1",
    scenario: scenarioName,
    startedAt,
    finishedAt,
    mutations,
    runtime: {
      mode: runtimeInfo?.mode ?? null,
      appPid: nativeDescriptor?.appPid ?? null,
      traceLogDir: runtimeInfo?.traces?.logDir ?? null,
    },
    timeline,
    snapshots,
    result: result ?? null,
    error: error ? { name: error.name ?? "Error", message: error.message ?? String(error) } : null,
    consoleLogs,
    transcriptTrace,
    diagnosticLogs,
  });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return path;
}
