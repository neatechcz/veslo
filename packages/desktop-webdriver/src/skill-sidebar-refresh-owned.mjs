import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { fail } from "./attach-smoke.mjs";
import { withOwnedLiveWebDriverRuntime } from "./scenario-kit/owned-runtime.mjs";
import { assertMutationAuthorized } from "./scenario-kit/safety.mjs";
import { parseSkillSidebarRefreshOptions, runSkillSidebarRefresh } from "./skill-sidebar-refresh.mjs";

function ownedRunDirectory() {
  const safeTimestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  return resolve(repoRoot, ".tmp", "webdriver-owned-runs", `skill-sidebar-refresh-${safeTimestamp}`);
}

export function parseOwnedSkillSidebarRefreshArguments(argv) {
  if (argv.some((value) => value === "--runtime-info" || value.endsWith("runtime-info.json"))) {
    fail("The owned scenario starts its own runtime; pass only workspace options.");
  }
  return parseSkillSidebarRefreshOptions(argv);
}

export async function runOwnedSkillSidebarRefresh(input, { env = process.env } = {}) {
  assertMutationAuthorized(env);
  const runDirectory = ownedRunDirectory();
  await mkdir(runDirectory, { recursive: true });
  return withOwnedLiveWebDriverRuntime({
    runDirectory,
    env,
    execute: ({ runtimeInfoPath }) => runSkillSidebarRefresh({ ...input, runtimeInfoPath }),
  });
}

async function main() {
  const input = parseOwnedSkillSidebarRefreshArguments(process.argv.slice(2));
  const result = await runOwnedSkillSidebarRefresh(input);
  console.info(JSON.stringify({ completed: true, mode: "owned-live-dev-webdriver", mutations: true, ...result }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
