import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { fail } from "./attach-smoke.mjs";
import { runLiveScenario } from "./scenario-kit/runner.mjs";
import { assertMutationAuthorized } from "./scenario-kit/safety.mjs";
import { executeManagedAiWorkerReplacementScenario } from "./scenarios/managed-ai-worker-replacement.mjs";

function required(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) fail(`Missing ${name}.`);
  return normalized;
}

export function parseManagedAiWorkerReplacementArguments(argv) {
  const [runtimeInfoPath, ...tokens] = argv;
  if (tokens.length !== 4 || tokens[0] !== "--workspace" || tokens[2] !== "--message") {
    fail("Usage: pnpm test:managed-ai-worker-replacement -- <runtime-info.json> --workspace <exact label> --message <single-line prompt>");
  }
  const message = required(tokens[3], "--message");
  if (/\r|\n/.test(message)) fail("--message must be single-line.");
  return {
    runtimeInfoPath: resolve(required(runtimeInfoPath, "runtime-info.json")),
    workspace: required(tokens[1], "--workspace"),
    message,
  };
}

async function main() {
  const input = parseManagedAiWorkerReplacementArguments(process.argv.slice(2));
  assertMutationAuthorized();
  const result = await runLiveScenario({
    scenarioName: "managed-ai-worker-replacement",
    runtimeInfoPath: input.runtimeInfoPath,
    mutations: true,
    execute: (context) => executeManagedAiWorkerReplacementScenario(context, input),
  });
  console.info(JSON.stringify({ completed: true, mode: "live-dev-webdriver", mutations: true, ...result }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
