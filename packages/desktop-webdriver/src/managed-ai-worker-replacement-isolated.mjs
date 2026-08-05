import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fail } from "./attach-smoke.mjs";
import { startControlledManagedAiGatewayFixture } from "./scenario-kit/managed-ai-gateway-fixture.mjs";
import { withOwnedIsolatedWebDriverRuntime } from "./scenario-kit/owned-runtime.mjs";
import { runIsolatedScenario } from "./scenario-kit/runner.mjs";
import { executeIsolatedManagedAiWorkerReplacementScenario } from "./scenarios/managed-ai-worker-replacement-isolated.mjs";

const DEFAULT_WORKSPACE = "WebDriver Managed AI Workspace";
const DEFAULT_WARMUP = "Reply with exactly: managed AI fixture warmup.";
const DEFAULT_RECOVERY = "Reply with exactly: managed AI worker replacement recovery.";

function ownedRunDirectory() {
  const safeTimestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  return resolve(repoRoot, ".tmp", "webdriver-owned-runs", `managed-ai-worker-replacement-${safeTimestamp}`);
}

export function parseIsolatedManagedAiWorkerReplacementArguments(argv) {
  if (argv.length !== 0) {
    fail("The isolated worker-replacement scenario owns its fixture, workspace, and desktop runtime; pass no arguments.");
  }
  return {
    workspace: DEFAULT_WORKSPACE,
    warmupMessage: DEFAULT_WARMUP,
    recoveryMessage: DEFAULT_RECOVERY,
  };
}

export async function runIsolatedManagedAiWorkerReplacement(input = parseIsolatedManagedAiWorkerReplacementArguments([])) {
  const runDirectory = ownedRunDirectory();
  await mkdir(runDirectory, { recursive: true });
  const fixture = await startControlledManagedAiGatewayFixture();
  try {
    return await withOwnedIsolatedWebDriverRuntime({
      runDirectory,
      gatewayBaseUrl: fixture.baseUrl,
      workspaceName: input.workspace,
      execute: ({ runtimeInfoPath }) => runIsolatedScenario({
        scenarioName: "managed-ai-worker-replacement-isolated",
        runtimeInfoPath,
        mutations: true,
        env: { WEBDRIVER_ALLOW_MUTATION: "1" },
        execute: (context) => executeIsolatedManagedAiWorkerReplacementScenario(context, { ...input, fixture }),
      }),
    });
  } finally {
    await fixture.close();
  }
}

async function main() {
  const input = parseIsolatedManagedAiWorkerReplacementArguments(process.argv.slice(2));
  const result = await runIsolatedManagedAiWorkerReplacement(input);
  console.info(JSON.stringify({
    completed: true,
    mode: "owned-isolated-dev-webdriver",
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
