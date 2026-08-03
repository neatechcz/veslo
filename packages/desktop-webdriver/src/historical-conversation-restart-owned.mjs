import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { fail } from "./attach-smoke.mjs";
import { parseHistoricalConversationOptions } from "./historical-conversation-roundtrip.mjs";
import {
  startOwnedLiveWebDriverRuntime,
  stopOwnedLiveWebDriverRuntime,
} from "./scenario-kit/owned-runtime.mjs";
import { runLiveScenario } from "./scenario-kit/runner.mjs";
import { assertMutationAuthorized } from "./scenario-kit/safety.mjs";
import {
  continueHistoricalConversationScenario,
  seedHistoricalConversationScenario,
} from "./scenarios/historical-conversation-roundtrip.mjs";
import { verifyHistoricalConversationArtifact } from "./scenario-kit/historical-conversation-trace-verifier.mjs";

function ownedRunDirectory() {
  const safeTimestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  return resolve(repoRoot, ".tmp", "webdriver-owned-runs", `historical-conversation-restart-${safeTimestamp}`);
}

export function parseOwnedHistoricalConversationRestartArguments(argv) {
  if (argv.some((value) => value === "--runtime-info" || value.endsWith("runtime-info.json"))) {
    fail("The owned restart scenario starts both desktop runtimes; pass only historical conversation options.");
  }
  return parseHistoricalConversationOptions(argv);
}

async function seedFirstRuntime(runtimeInfoPath, input, env) {
  return runLiveScenario({
    scenarioName: "historical-conversation-restart-seed",
    runtimeInfoPath,
    mutations: true,
    env,
    execute: (context) => seedHistoricalConversationScenario(context, input),
  });
}

async function continueSecondRuntime(runtimeInfoPath, input, sessions, env) {
  return runLiveScenario({
    // The causal verifier deliberately accepts this continuation artifact only
    // when the server directly admits it after the prior desktop has exited.
    scenarioName: "historical-conversation-roundtrip",
    runtimeInfoPath,
    mutations: true,
    env,
    execute: (context) => continueHistoricalConversationScenario(context, input, sessions),
  });
}

export async function runOwnedHistoricalConversationRestart(input, { env = process.env } = {}) {
  assertMutationAuthorized(env);
  const runDirectory = ownedRunDirectory();
  await mkdir(runDirectory, { recursive: true });
  const firstDirectory = resolve(runDirectory, "first-runtime");
  const secondDirectory = resolve(runDirectory, "second-runtime");
  let firstRuntime;
  let secondRuntime;
  let firstShutdown = "not-started";
  let secondShutdown = "not-started";
  let result;
  try {
    firstRuntime = await startOwnedLiveWebDriverRuntime({ runDirectory: firstDirectory, env });
    const seed = await seedFirstRuntime(firstRuntime.runtimeInfoPath, input, env);
    firstShutdown = await stopOwnedLiveWebDriverRuntime(firstRuntime);
    firstRuntime = null;

    secondRuntime = await startOwnedLiveWebDriverRuntime({ runDirectory: secondDirectory, env });
    const continuation = await continueSecondRuntime(secondRuntime.runtimeInfoPath, input, seed, env);
    const causal = await verifyHistoricalConversationArtifact(continuation.artifactPath);
    if (causal.summary.outcome !== "passed") {
      throw new Error(`Historical restart continuation causal proof failed; see ${causal.outputPath}.`);
    }
    result = {
      runDirectory,
      seedArtifactPath: seed.artifactPath,
      continuationArtifactPath: continuation.artifactPath,
      causalSummaryPath: causal.outputPath,
      seedSessionId: seed.seedSessionId,
      interludeSessionId: seed.interludeSessionId,
      firstShutdown,
    };
  } finally {
    if (firstRuntime) firstShutdown = await stopOwnedLiveWebDriverRuntime(firstRuntime).catch(() => "failed");
    if (secondRuntime) secondShutdown = await stopOwnedLiveWebDriverRuntime(secondRuntime).catch(() => "failed");
  }
  return { ...result, firstShutdown, secondShutdown };
}

async function main() {
  const input = parseOwnedHistoricalConversationRestartArguments(process.argv.slice(2));
  const result = await runOwnedHistoricalConversationRestart(input);
  console.info(JSON.stringify({ completed: true, mode: "owned-live-dev-webdriver-restart", mutations: true, ...result }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
