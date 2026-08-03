import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { fail } from "./attach-smoke.mjs";
import { runLiveScenario } from "./scenario-kit/runner.mjs";
import { assertMutationAuthorized } from "./scenario-kit/safety.mjs";
import { executeExistingHistoricalContinuationScenario } from "./scenarios/historical-conversation-roundtrip.mjs";
import { verifyHistoricalConversationArtifact } from "./scenario-kit/historical-conversation-trace-verifier.mjs";

const normalize = (value) => String(value ?? "").trim();

function requiredOption(options, name) {
  const value = normalize(options[name]);
  if (!value) fail(`Missing required ${name}.`);
  if (/\r|\n/.test(value)) fail(`${name} must be single-line.`);
  return value;
}

export function parseHistoricalExistingContinuationArguments(argv) {
  const [runtimeInfoPath, ...tokens] = argv;
  if (!normalize(runtimeInfoPath)) {
    fail("Usage: pnpm test:webdriver:historical-existing-continuation -- <runtime-info.json> --workspace <exact label> --session-id <visible sidebar id> --continuation-message <text>");
  }
  const options = {};
  const allowed = new Set(["--workspace", "--session-id", "--continuation-message"]);
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (!allowed.has(name) || value === undefined || options[name]) {
      fail("Use only the documented historical existing-conversation options.");
    }
    options[name] = value;
  }
  return {
    runtimeInfoPath: resolve(runtimeInfoPath),
    workspace: requiredOption(options, "--workspace"),
    sessionId: requiredOption(options, "--session-id"),
    continuationMessage: requiredOption(options, "--continuation-message"),
  };
}

async function main() {
  const input = parseHistoricalExistingContinuationArguments(process.argv.slice(2));
  assertMutationAuthorized();
  const result = await runLiveScenario({
    scenarioName: "historical-existing-conversation-continuation",
    runtimeInfoPath: input.runtimeInfoPath,
    mutations: true,
    execute: (context) => executeExistingHistoricalContinuationScenario(context, input),
  });
  const causal = await verifyHistoricalConversationArtifact(result.artifactPath);
  if (causal.summary.outcome !== "passed") {
    throw new Error(`Historical existing conversation causal proof failed; see ${causal.outputPath}.`);
  }
  console.info(JSON.stringify({ completed: true, mode: "live-dev-webdriver", mutations: true, ...result, causalSummaryPath: causal.outputPath }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
