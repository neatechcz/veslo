import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CLEARED_ENV_KEYS = [
  "VESLO_DEV_SERVER_URL",
  "VESLO_DESKTOP_ALLOW_EXTERNAL_RUNTIME_BINARIES",
  "OPENCODE_BIN_PATH",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "VESLO_DEN_API_BASE",
  "VESLO_DEN_AUTH_SNAPSHOT_PATH",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "VESLO_AI_GATEWAY_BASE_URL",
  "VESLO_MANAGED_AI_BASE_URL",
  "VESLO_MANAGED_AI_GATEWAY_BASE_URL",
  "VESLO_SHARED_OPENCODE_ENGINE",
];

const CLEARED_ENV_PREFIXES = ["E2E_", "VESLO_", "VITE_", "OPENCODE_"];
const CLEARED_PROVIDER_ENV_PREFIXES = [
  "ANTHROPIC_",
  "AZURE_OPENAI_",
  "COHERE_",
  "GOOGLE_",
  "GROQ_",
  "MISTRAL_",
  "OPENAI_",
  "OPENROUTER_",
  "PERPLEXITY_",
  "XAI_",
];
const CREDENTIAL_ENV_NAME =
  /(?:^|_)(?:API_KEY|TOKENS?|SECRETS?|PASSWORDS?|CREDENTIALS?|AUTH(?:ORIZATION)?)(?:_|$)/i;

export function createPackagedSmokeEnvironment(source = process.env) {
  const environment = { ...source };
  const pilotBinary = source.E2E_TAURI_PILOT_BIN;

  for (const key of Object.keys(environment)) {
    if (
      CLEARED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
      CLEARED_PROVIDER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
      CREDENTIAL_ENV_NAME.test(key)
    ) {
      delete environment[key];
    }
  }

  for (const key of CLEARED_ENV_KEYS) {
    delete environment[key];
  }

  if (pilotBinary?.trim()) {
    environment.E2E_TAURI_PILOT_BIN = pilotBinary;
  }

  environment.VESLO_PACKAGED_SMOKE = "1";
  environment.VESLO_SIDECAR_FORCE_BUILD = "1";
  return environment;
}

export function packagedSmokeBuildArgs() {
  return [
    "--filter",
    "@neatech/veslo",
    "exec",
    "tauri",
    "build",
    "--debug",
    "--no-bundle",
    "--config",
    "src-tauri/tauri.windows.conf.json",
    "--config",
    "src-tauri/tauri.windows.release.conf.json",
    "--config",
    "src-tauri/tauri.e2e.conf.json",
    "--",
    "--features",
    "e2e",
  ];
}

export function packagedSmokePilotArgs() {
  return ["--filter", "@neatech/veslo-e2e", "test:pilot:packaged-smoke"];
}

export function quoteWindowsCommandArgument(value) {
  return /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(value)
    ? value
    : `"${value.replaceAll('"', '""')}"`;
}

export function resolveCommandInvocation(
  command,
  args,
  platform = process.platform,
) {
  if (platform !== "win32") {
    return { command, args };
  }
  return {
    command: process.env.ComSpec?.trim() || "cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      [command, ...args].map(quoteWindowsCommandArgument).join(" "),
    ],
  };
}

export async function runCommand(command, args, options) {
  const invocation = resolveCommandInvocation(command, args);
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
      windowsHide: true,
    });

    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      const reason = signal ? "signal " + signal : "exit code " + code;
      rejectPromise(
        new Error(command + " " + args.join(" ") + " failed with " + reason),
      );
    });
  });
}

export async function runPackagedSmoke({
  platform = process.platform,
  environment = process.env,
  run = runCommand,
} = {}) {
  if (platform !== "win32") {
    throw new Error("desktop:smoke-packaged is supported on Windows only");
  }

  const env = createPackagedSmokeEnvironment(environment);
  const options = { cwd: repoRoot, env };

  await run("pnpm", packagedSmokeBuildArgs(), options);
  await run("pnpm", packagedSmokePilotArgs(), options);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runPackagedSmoke().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
