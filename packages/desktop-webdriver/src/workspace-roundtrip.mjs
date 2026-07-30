import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { fail } from "./attach-smoke.mjs";
import { runLiveScenario } from "./scenario-kit/runner.mjs";
import { assertMutationAuthorized } from "./scenario-kit/safety.mjs";
import { executeWorkspaceRoundtripScenario } from "./scenarios/workspace-roundtrip.mjs";
import { selectWorkspaceForNewConversation, sendComposerMessage, waitForSubmittedRunToSettle } from "./scenario-kit/ui.mjs";

export { assertMutationAuthorized, sendComposerMessage, waitForSubmittedRunToSettle };
export const openNewConversationInWorkspace = selectWorkspaceForNewConversation;

function normalize(value) {
  return String(value ?? "").trim();
}

function requiredOption(options, name) {
  const value = normalize(options[name]);
  if (!value) fail(`Missing required ${name}.`);
  return value;
}

export function parseWorkspaceRoundtripArguments(argv) {
  const [runtimeInfoPath, ...tokens] = argv;
  if (!normalize(runtimeInfoPath)) {
    fail("Usage: pnpm test:webdriver:workspace-roundtrip -- <runtime-info.json> --initial-workspace <exact label> --second-workspace <exact label> --first-message <text> --second-message <text>");
  }
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (!name?.startsWith("--") || value === undefined || !(name in {
      "--initial-workspace": true,
      "--second-workspace": true,
      "--first-message": true,
      "--second-message": true,
    })) {
      fail("Use only explicit --initial-workspace, --second-workspace, --first-message, and --second-message options.");
    }
    if (options[name]) fail(`Duplicate ${name}.`);
    options[name] = value;
  }
  const initialWorkspace = requiredOption(options, "--initial-workspace");
  const secondWorkspace = requiredOption(options, "--second-workspace");
  const firstMessage = requiredOption(options, "--first-message");
  const secondMessage = requiredOption(options, "--second-message");
  if (initialWorkspace === secondWorkspace) {
    fail("The two workspace labels must differ.");
  }
  if (/[\r\n]/.test(firstMessage) || /[\r\n]/.test(secondMessage)) {
    fail("Messages must be single-line so WebDriver cannot submit an unintended extra prompt.");
  }
  return {
    runtimeInfoPath: resolve(runtimeInfoPath),
    initialWorkspace,
    secondWorkspace,
    firstMessage,
    secondMessage,
  };
}

async function main() {
  const input = parseWorkspaceRoundtripArguments(process.argv.slice(2));
  const result = await runLiveScenario({
    scenarioName: "workspace-roundtrip",
    runtimeInfoPath: input.runtimeInfoPath,
    mutations: true,
    async execute(context) {
      return executeWorkspaceRoundtripScenario(context, input);
    },
  });
  console.info(JSON.stringify({
      completed: true,
      mode: "live-dev-webdriver",
      ...result,
      mutations: true,
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
