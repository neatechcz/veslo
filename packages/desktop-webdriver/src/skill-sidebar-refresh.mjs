import process from "node:process";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";

import { fail } from "./attach-smoke.mjs";
import { runLiveScenario } from "./scenario-kit/runner.mjs";
import { executeSkillSidebarRefreshScenario } from "./scenarios/skill-sidebar-refresh.mjs";

function normalized(value) {
  return String(value ?? "").trim();
}

function required(options, name) {
  const value = normalized(options[name]);
  if (!value) fail(`Missing required ${name}.`);
  return value;
}

export function parseSkillSidebarRefreshOptions(tokens) {
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (!name?.startsWith("--") || value === undefined || !(name in {
      "--workspace": true,
      "--workspace-path": true,
      "--skill-name": true,
      "--timeout-ms": true,
    })) {
      fail("Use --workspace, --workspace-path, --skill-name, and optional --timeout-ms only.");
    }
    if (options[name]) fail(`Duplicate ${name}.`);
    options[name] = value;
  }
  const workspaceLabel = required(options, "--workspace");
  const rawWorkspacePath = required(options, "--workspace-path");
  if (!isAbsolute(rawWorkspacePath)) fail("--workspace-path must be absolute.");
  const skillName = required(options, "--skill-name");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
    fail("--skill-name must be kebab-case.");
  }
  const timeoutMs = options["--timeout-ms"] === undefined ? 120_000 : Number(options["--timeout-ms"]);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 300_000) {
    fail("--timeout-ms must be an integer between 10000 and 300000.");
  }
  return {
    workspaceLabel,
    workspacePath: resolve(rawWorkspacePath),
    skillName,
    timeoutMs,
  };
}

export function parseSkillSidebarRefreshArguments(argv) {
  const [runtimeInfoPath, ...tokens] = argv;
  if (!normalized(runtimeInfoPath)) {
    fail("Usage: pnpm test:webdriver:skill-sidebar-refresh -- <runtime-info.json> --workspace <exact label> --workspace-path <absolute disposable path> --skill-name <kebab-case>");
  }
  return { runtimeInfoPath: resolve(runtimeInfoPath), ...parseSkillSidebarRefreshOptions(tokens) };
}

export async function runSkillSidebarRefresh(input) {
  return runLiveScenario({
    scenarioName: "skill-sidebar-refresh",
    runtimeInfoPath: input.runtimeInfoPath,
    mutations: true,
    execute: (context) => executeSkillSidebarRefreshScenario(context, input),
  });
}

async function main() {
  const input = parseSkillSidebarRefreshArguments(process.argv.slice(2));
  const result = await runSkillSidebarRefresh(input);
  console.info(JSON.stringify({ completed: true, mode: "live-dev-webdriver", mutations: true, ...result }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
