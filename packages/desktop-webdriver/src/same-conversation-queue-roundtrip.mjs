import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { fail } from "./attach-smoke.mjs";
import { runLiveScenario } from "./scenario-kit/runner.mjs";
import { assertMutationAuthorized } from "./scenario-kit/safety.mjs";
import { executeSameConversationQueueRoundtripScenario } from "./scenarios/same-conversation-queue-roundtrip.mjs";

function normalize(value) {
  return String(value ?? "").trim();
}

function requiredOption(options, name) {
  const value = normalize(options[name]);
  if (!value) fail(`Missing required ${name}.`);
  return value;
}

function optionalDelayMs(options, name) {
  const value = normalize(options[name]);
  if (!value) return null;
  if (!/^\d+$/.test(value)) fail(`${name} must be a whole number of milliseconds.`);
  const delayMs = Number(value);
  if (delayMs > 10_000) fail(`${name} must not exceed 10000ms.`);
  return delayMs;
}

function optionalBoolean(options, name) {
  const value = normalize(options[name]).toLowerCase();
  if (!value) return false;
  if (value !== "true" && value !== "false") fail(`${name} must be true or false.`);
  return value === "true";
}

export function parseSameConversationQueueRoundtripArguments(argv) {
  const [runtimeInfoPath, ...tokens] = argv;
  if (!normalize(runtimeInfoPath)) {
    fail("Usage: pnpm test:webdriver:same-conversation-queue-roundtrip -- <runtime-info.json> --workspace <exact label> --first-message <text> --second-message <text> [--event-stream-gate true|false] [--third-message <text> --third-after-settle-ms <0..10000>]");
  }
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (!name?.startsWith("--") || value === undefined || !(name in {
      "--workspace": true,
      "--first-message": true,
      "--second-message": true,
      "--third-message": true,
      "--third-after-settle-ms": true,
      "--event-stream-gate": true,
    })) {
      fail("Use only the documented same-conversation queue options.");
    }
    if (options[name]) fail(`Duplicate ${name}.`);
    options[name] = value;
  }
  const workspace = requiredOption(options, "--workspace");
  const firstMessage = requiredOption(options, "--first-message");
  const secondMessage = requiredOption(options, "--second-message");
  const thirdMessage = normalize(options["--third-message"]);
  const thirdAfterSettleMs = optionalDelayMs(options, "--third-after-settle-ms");
  if (thirdAfterSettleMs !== null && !thirdMessage) {
    fail("--third-after-settle-ms requires --third-message.");
  }
  if (/\r|\n/.test(firstMessage) || /\r|\n/.test(secondMessage) || /\r|\n/.test(thirdMessage)) {
    fail("Messages must be single-line so WebDriver cannot submit an unintended extra prompt.");
  }
  return {
    runtimeInfoPath: resolve(runtimeInfoPath),
    workspace,
    firstMessage,
    secondMessage,
    thirdMessage: thirdMessage || null,
    thirdAfterSettleMs,
    eventStreamGate: optionalBoolean(options, "--event-stream-gate"),
  };
}

async function main() {
  const input = parseSameConversationQueueRoundtripArguments(process.argv.slice(2));
  assertMutationAuthorized();
  const result = await runLiveScenario({
    scenarioName: "same-conversation-queue-roundtrip",
    runtimeInfoPath: input.runtimeInfoPath,
    mutations: true,
    execute: (context) => executeSameConversationQueueRoundtripScenario(context, input),
  });
  console.info(JSON.stringify({ completed: true, mode: "live-dev-webdriver", mutations: true, ...result }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
