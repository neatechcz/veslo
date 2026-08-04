import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { parseDocumentFollowUpArguments } from "./document-follow-up-arguments.mjs";
import { runLiveScenario } from "./scenario-kit/runner.mjs";
import { assertMutationAuthorized } from "./scenario-kit/safety.mjs";
import { verifyDocumentContinuationArtifact } from "./scenario-kit/document-continuation-trace-verifier.mjs";
import { executeExistingSessionDocumentFollowUpScenario } from "./scenarios/document-follow-up.mjs";

export function parseExistingSessionDocumentFollowUpArguments(argv) {
  return parseDocumentFollowUpArguments(argv, { existingSession: true });
}

async function main() {
  const input = parseExistingSessionDocumentFollowUpArguments(process.argv.slice(2));
  assertMutationAuthorized();
  const result = await runLiveScenario({
    scenarioName: "existing-session-document-follow-up",
    runtimeInfoPath: input.runtimeInfoPath,
    mutations: true,
    execute: (context) => executeExistingSessionDocumentFollowUpScenario(context, input),
  });
  const causal = await verifyDocumentContinuationArtifact(result.artifactPath);
  if (causal.summary.outcome !== "passed") {
    throw new Error(`Existing-session document follow-up causal proof failed; see ${causal.outputPath}.`);
  }
  console.info(JSON.stringify({
    completed: true,
    mode: "live-dev-webdriver",
    mutations: true,
    ...result,
    causalSummaryPath: causal.outputPath,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
