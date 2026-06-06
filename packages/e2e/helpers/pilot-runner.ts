import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveLaunchTimeout,
  resolvePilotRuntimeDir,
  resolvePilotSocketPath,
  startApp,
  stopApp,
} from './app-launcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_READY_POLL_INTERVAL = 250;
const DEFAULT_PILOT_SCENARIO_NAMES = ['smoke', 'navigation'] as const;

type BuildPilotCommandOptions = {
  binary: string;
  socket: string;
  args: string[];
};

type RunPilotCommandOptions = {
  binary?: string;
  socket?: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  inheritStdio?: boolean;
};

type ResolvePilotScenarioSelectionOptions = {
  scenario?: string[];
};

type RunPilotScenariosOptions = ResolvePilotScenarioSelectionOptions & {
  e2eRoot?: string;
  binary?: string;
  socket?: string;
  timeoutMs?: number;
};

export function resolvePilotBinary(env: Record<string, string | undefined> = process.env): string {
  return env.E2E_TAURI_PILOT_BIN?.trim() || 'tauri-pilot';
}

export function buildPilotCommand(options: BuildPilotCommandOptions): { command: string; args: string[] } {
  return {
    command: options.binary,
    args: ['--socket', options.socket, ...options.args],
  };
}

export function defaultPilotScenarios(e2eRoot = resolve(__dirname, '..')): string[] {
  return DEFAULT_PILOT_SCENARIO_NAMES.map((name) => join(e2eRoot, 'pilot-scenarios', `${name}.toml`));
}

export function pilotReadinessProbeCommands(): string[][] {
  return [['ping'], ['state']];
}

export function resolvePilotScenarioSelection(
  options: ResolvePilotScenarioSelectionOptions = {},
  e2eRoot = resolve(__dirname, '..'),
): string[] {
  const requested = options.scenario?.map((value) => value.trim()).filter(Boolean) ?? [];
  if (requested.length === 0) return defaultPilotScenarios(e2eRoot);

  return requested.map((value) => {
    if (value.endsWith('.toml') || value.includes('/') || value.includes('\\')) {
      return isAbsolute(value) ? value : resolve(e2eRoot, value);
    }
    return join(e2eRoot, 'pilot-scenarios', `${value}.toml`);
  });
}

export function scenarioSelectionNeedsAutomationSecondaryWorkspace(scenarios: string[]): boolean {
  return scenarios.some((scenario) => scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/automations.toml'));
}

export async function runPilotCommand(options: RunPilotCommandOptions): Promise<void> {
  const binary = options.binary ?? resolvePilotBinary(options.env);
  const socket = options.socket ?? resolvePilotSocketPath({ runtimeDir: resolvePilotRuntimeDir() });
  const { command, args } = buildPilotCommand({ binary, socket, args: options.args });

  await new Promise<void>((resolveCommand, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.inheritStdio ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    const output: Uint8Array[] = [];
    const errors: Uint8Array[] = [];
    let timeout: NodeJS.Timeout | null = null;

    child.stdout?.on('data', (chunk: Uint8Array) => output.push(chunk));
    child.stderr?.on('data', (chunk: Uint8Array) => errors.push(chunk));

    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
        reject(new Error(`tauri-pilot command timed out after ${options.timeoutMs}ms: ${args.join(' ')}`));
      }, options.timeoutMs);
    }

    child.on('error', (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });

    child.on('exit', (code, signal) => {
      if (timeout) clearTimeout(timeout);
      if (code === 0) {
        resolveCommand();
        return;
      }

      const stderr = Buffer.concat(errors).toString().trim();
      const stdout = Buffer.concat(output).toString().trim();
      const detail = [stderr, stdout].filter(Boolean).join('\n');
      reject(new Error(`tauri-pilot exited with ${code ?? signal}: ${args.join(' ')}${detail ? `\n${detail}` : ''}`));
    });
  });
}

export async function ensurePilotReady(options: Omit<RunPilotCommandOptions, 'args'> = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? Math.min(10_000, resolveLaunchTimeout());
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      for (const args of pilotReadinessProbeCommands()) {
        await runPilotCommand({
          ...options,
          args,
          timeoutMs: Math.min(1_000, Math.max(1, deadline - Date.now())),
        });
      }
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, DEFAULT_READY_POLL_INTERVAL));
    }
  }

  const message = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(`tauri-pilot did not become ready within ${timeoutMs}ms.${message}`);
}

export async function runPilotScenarios(options: RunPilotScenariosOptions = {}): Promise<void> {
  const e2eRoot = options.e2eRoot ?? resolve(__dirname, '..');
  const scenarios = resolvePilotScenarioSelection(options, e2eRoot);
  const binary = options.binary ?? resolvePilotBinary();
  const socket = options.socket ?? resolvePilotSocketPath({ runtimeDir: resolvePilotRuntimeDir() });
  const timeoutMs = options.timeoutMs ?? resolveLaunchTimeout();

  for (const scenario of scenarios) {
    if (!existsSync(scenario)) {
      throw new Error(`tauri-pilot scenario not found: ${scenario}`);
    }
  }

  if (scenarioSelectionNeedsAutomationSecondaryWorkspace(scenarios)) {
    process.env.E2E_SEED_AUTOMATIONS_SECONDARY_WORKSPACE ||= '1';
  }

  await startApp();
  try {
    await ensurePilotReady({ binary, socket, cwd: e2eRoot, timeoutMs });
    for (const scenario of scenarios) {
      console.log(`[e2e] Running tauri-pilot scenario: ${scenario}`);
      await runPilotCommand({
        binary,
        socket,
        args: ['run', scenario],
        cwd: e2eRoot,
        inheritStdio: true,
      });
    }
  } finally {
    await stopApp();
  }
}

export function parsePilotRunnerArgs(argv: string[]): ResolvePilotScenarioSelectionOptions {
  const scenario: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--scenario' || arg === '-s') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a scenario name or path`);
      scenario.push(value);
      index += 1;
    } else if (arg.startsWith('--scenario=')) {
      scenario.push(arg.slice('--scenario='.length));
    }
  }
  return { scenario };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === __filename) {
  runPilotScenarios(parsePilotRunnerArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
