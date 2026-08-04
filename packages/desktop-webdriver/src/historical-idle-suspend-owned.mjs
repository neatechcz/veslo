import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { fail } from "./attach-smoke.mjs";
import {
  startOwnedLiveWebDriverRuntime,
  stopOwnedLiveWebDriverRuntime,
} from "./scenario-kit/owned-runtime.mjs";
import { runLiveScenario } from "./scenario-kit/runner.mjs";
import { assertMutationAuthorized } from "./scenario-kit/safety.mjs";
import { verifyHistoricalConversationArtifact } from "./scenario-kit/historical-conversation-trace-verifier.mjs";
import { executeIdleSuspendHistoricalContinuationScenario } from "./scenarios/historical-conversation-roundtrip.mjs";

const normalize = (value) => String(value ?? "").trim();

function requiredOption(options, name) {
  const value = normalize(options[name]);
  if (!value) fail(`Missing required ${name}.`);
  if (/\r|\n/.test(value)) fail(`${name} must be single-line.`);
  return value;
}

export function parseHistoricalIdleSuspendArguments(tokens) {
  if (tokens.some((value) => value === "--runtime-info" || value.endsWith("runtime-info.json"))) {
    fail("The idle-suspend scenario owns its desktop runtime; do not pass runtime-info.json.");
  }
  const options = {};
  const allowed = new Set(["--workspace", "--seed-message", "--continuation-message"]);
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (!allowed.has(name) || value === undefined || options[name]) {
      fail("Use only the documented historical idle-suspend options.");
    }
    options[name] = value;
  }
  return {
    workspace: requiredOption(options, "--workspace"),
    seedMessage: requiredOption(options, "--seed-message"),
    continuationMessage: requiredOption(options, "--continuation-message"),
  };
}

function ownedRunDirectory() {
  const safeTimestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  return resolve(repoRoot, ".tmp", "webdriver-owned-runs", `historical-idle-suspend-${safeTimestamp}`);
}

export async function runOwnedHistoricalIdleSuspend(input, { env = process.env } = {}) {
  assertMutationAuthorized(env);
  const runDirectory = ownedRunDirectory();
  await mkdir(runDirectory, { recursive: true });
  let runtime;
  let shutdown = "not-started";
  let result;
  try {
    runtime = await startOwnedLiveWebDriverRuntime({ runDirectory, env });
    const scenario = await runLiveScenario({
      scenarioName: "historical-idle-suspend-continuation",
      runtimeInfoPath: runtime.runtimeInfoPath,
      mutations: true,
      env,
      execute: (context) => executeIdleSuspendHistoricalContinuationScenario(context, input),
    });
    const causal = await verifyHistoricalConversationArtifact(scenario.artifactPath);
    if (causal.summary.outcome !== "passed") {
      throw new Error(`Idle-suspend continuation causal proof failed; see ${causal.outputPath}.`);
    }
    result = {
      runDirectory,
      artifactPath: scenario.artifactPath,
      causalSummaryPath: causal.outputPath,
      seedSessionId: scenario.seedSessionId,
      suspendedChildKind: scenario.suspendedChildKind,
      suspendedChildExitObserved: scenario.suspendedChildExitObserved,
    };
  } finally {
    if (runtime) shutdown = await stopOwnedLiveWebDriverRuntime(runtime).catch(() => "failed");
  }
  return { ...result, shutdown };
}

async function main() {
  const input = parseHistoricalIdleSuspendArguments(process.argv.slice(2));
  const result = await runOwnedHistoricalIdleSuspend(input);
  console.info(JSON.stringify({
    completed: true,
    mode: "owned-live-dev-webdriver-idle-suspend",
    mutations: true,
    ...result,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
