import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { fail } from "./attach-smoke.mjs";
import { runLiveScenario } from "./scenario-kit/runner.mjs";
import { assertMutationAuthorized } from "./scenario-kit/safety.mjs";
import { executeHistoricalConversationRoundtripScenario } from "./scenarios/historical-conversation-roundtrip.mjs";
import { verifyHistoricalConversationArtifact } from "./scenario-kit/historical-conversation-trace-verifier.mjs";

function normalize(value) {
  return String(value ?? "").trim();
}

function requiredOption(options, name) {
  const value = normalize(options[name]);
  if (!value) fail(`Missing required ${name}.`);
  if (/\r|\n/.test(value)) fail(`${name} must be single-line.`);
  return value;
}

export function parseHistoricalConversationRoundtripArguments(argv) {
  const [runtimeInfoPath, ...tokens] = argv;
  if (!normalize(runtimeInfoPath)) {
    fail("Usage: pnpm test:webdriver:historical-conversation-roundtrip -- <runtime-info.json> --workspace <exact label> --seed-message <text> --interlude-message <text> --continuation-message <text>");
  }
  const options = {};
  const allowed = new Set([
    "--workspace",
    "--seed-message",
    "--interlude-message",
    "--continuation-message",
  ]);
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (!allowed.has(name) || value === undefined || options[name]) {
      fail("Use only the documented historical-conversation roundtrip options.");
    }
    options[name] = value;
  }
  return {
    runtimeInfoPath: resolve(runtimeInfoPath),
    workspace: requiredOption(options, "--workspace"),
    seedMessage: requiredOption(options, "--seed-message"),
    interludeMessage: requiredOption(options, "--interlude-message"),
    continuationMessage: requiredOption(options, "--continuation-message"),
  };
}

async function main() {
  const input = parseHistoricalConversationRoundtripArguments(process.argv.slice(2));
  assertMutationAuthorized();
  const result = await runLiveScenario({
    scenarioName: "historical-conversation-roundtrip",
    runtimeInfoPath: input.runtimeInfoPath,
    mutations: true,
    execute: (context) => executeHistoricalConversationRoundtripScenario(context, input),
  });
  const causal = await verifyHistoricalConversationArtifact(result.artifactPath);
  if (causal.summary.outcome !== "passed") {
    throw new Error(`Historical continuation causal proof failed; see ${causal.outputPath}.`);
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
