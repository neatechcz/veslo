import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { parseDocumentFollowUpArguments } from "./document-follow-up-arguments.mjs";
import { runLiveScenario } from "./scenario-kit/runner.mjs";
import { assertMutationAuthorized } from "./scenario-kit/safety.mjs";
import { verifyDocumentContinuationArtifact } from "./scenario-kit/document-continuation-trace-verifier.mjs";
import { executeFirstSessionDocumentFollowUpScenario } from "./scenarios/document-follow-up.mjs";

export function parseFirstSessionDocumentFollowUpArguments(argv) {
  return parseDocumentFollowUpArguments(argv, { existingSession: false });
}

async function main() {
  const input = parseFirstSessionDocumentFollowUpArguments(process.argv.slice(2));
  assertMutationAuthorized();
  const result = await runLiveScenario({
    scenarioName: "first-session-document-follow-up",
    runtimeInfoPath: input.runtimeInfoPath,
    mutations: true,
    execute: (context) => executeFirstSessionDocumentFollowUpScenario(context, input),
  });
  const causal = await verifyDocumentContinuationArtifact(result.artifactPath);
  if (causal.summary.outcome !== "passed") {
    throw new Error(`First-session document follow-up causal proof failed; see ${causal.outputPath}.`);
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
