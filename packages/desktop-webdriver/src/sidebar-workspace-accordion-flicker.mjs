import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { fail } from "./attach-smoke.mjs";
import { runLiveScenario } from "./scenario-kit/runner.mjs";
import { executeSidebarWorkspaceAccordionFlickerScenario } from "./scenarios/sidebar-workspace-accordion-flicker.mjs";

function normalize(value) {
  return String(value ?? "").trim();
}

export function parseSidebarWorkspaceAccordionFlickerArguments(argv) {
  const [runtimeInfoPath, ...tokens] = argv;
  if (!normalize(runtimeInfoPath)) {
    fail("Usage: pnpm test:webdriver:sidebar-flicker -- <runtime-info.json> --initial-workspace <exact label> --second-workspace <exact label> [--observe-ms <200-10000>]");
  }
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (!name?.startsWith("--") || value === undefined || !(name in {
      "--initial-workspace": true,
      "--second-workspace": true,
      "--observe-ms": true,
    })) {
      fail("Use only --initial-workspace, --second-workspace, and optional --observe-ms.");
    }
    if (options[name]) fail(`Duplicate ${name}.`);
    options[name] = value;
  }
  const initialWorkspace = normalize(options["--initial-workspace"]);
  const secondWorkspace = normalize(options["--second-workspace"]);
  if (!initialWorkspace || !secondWorkspace) fail("Both workspace labels are required.");
  if (initialWorkspace === secondWorkspace) fail("The two workspace labels must differ.");
  const observeMs = options["--observe-ms"] === undefined ? 1_500 : Number(options["--observe-ms"]);
  if (!Number.isInteger(observeMs) || observeMs < 200 || observeMs > 10_000) {
    fail("--observe-ms must be an integer between 200 and 10000.");
  }
  return { runtimeInfoPath: resolve(runtimeInfoPath), initialWorkspace, secondWorkspace, observeMs };
}

async function main() {
  const input = parseSidebarWorkspaceAccordionFlickerArguments(process.argv.slice(2));
  const result = await runLiveScenario({
    scenarioName: "sidebar-workspace-accordion-flicker",
    runtimeInfoPath: input.runtimeInfoPath,
    execute: (context) => executeSidebarWorkspaceAccordionFlickerScenario(context, input),
  });
  console.info(JSON.stringify({ completed: true, mode: "live-dev-webdriver", mutations: false, ...result }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
