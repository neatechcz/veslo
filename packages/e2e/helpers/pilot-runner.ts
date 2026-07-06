import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
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

type PortContentionFixture = {
  server: Server;
  previousE2ePort: string | undefined;
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

export function resolvePilotDenAuthJson(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.VESLO_E2E_DEN_AUTH_JSON?.trim() || env.E2E_DEN_AUTH_JSON?.trim() || '';
  return raw || null;
}

export function buildPilotDenAuthSeedScript(authJson: string): string {
  return `
const authJson = ${JSON.stringify(authJson)};
JSON.parse(authJson);
window.localStorage.setItem("veslo.den.auth", authJson);
window.localStorage.setItem("veslo.den.keepSignedIn", "1");
window.sessionStorage.removeItem("veslo.den.auth");
window.sessionStorage.removeItem("veslo.den.keepSignedIn");
const invoke = window.__TAURI_INTERNALS__?.invoke;
if (invoke) {
  await invoke("den_auth_snapshot_write", {
    authJson,
    keepSignedIn: true,
    language: "en",
    onboardingComplete: true,
  });
}
window.location.reload();
true;
`;
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

export function scenarioSelectionNeedsSkillRegistryAuthFixture(scenarios: string[]): boolean {
  return scenarios.some((scenario) =>
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/soul-dashboard.toml') ||
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/soul-den-local.toml'),
  );
}

export function scenarioSelectionNeedsLegacySoulRuntime(scenarios: string[]): boolean {
  return scenarios.some((scenario) => scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/soul-den-local.toml'));
}

export function scenarioSelectionNeedsSkillEnableInventoryFixture(scenarios: string[]): boolean {
  return scenarios.some((scenario) => scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/skills-enabled-state.toml'));
}

export function scenarioSelectionNeedsGoogleMcpCatalogFixture(scenarios: string[]): boolean {
  return scenarios.some((scenario) => scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/google-mcp-connectors.toml'));
}

export function scenarioSelectionNeedsSharePointMcpCatalogFixture(scenarios: string[]): boolean {
  return scenarios.some((scenario) => scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/sharepoint-mcp-connectors.toml'));
}

export function scenarioSelectionNeedsManagedAiGatewayFixture(scenarios: string[]): boolean {
  return scenarios.some((scenario) =>
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/message-send-registry-degraded.toml') ||
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/model-stream-retry-no-progress.toml') ||
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/vslo-270-stop-reload-reconnect.toml') ||
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/runtime-cold-start-session-handoff.toml') ||
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/sidebar-session-retention.toml') ||
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/global-unpublished-draft.toml'),
  );
}

export function scenarioSelectionNeedsModelStreamRetryFixture(scenarios: string[]): boolean {
  return scenarios.some((scenario) =>
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/model-stream-retry-no-progress.toml') ||
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/vslo-270-stop-reload-reconnect.toml'),
  );
}

export function scenarioSelectionDisablesDevAutostart(scenarios: string[]): boolean {
  return scenarios.some((scenario) =>
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/runtime-cold-start-session-handoff.toml') ||
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/vslo-270-stop-reload-reconnect.toml'),
  );
}

export function scenarioSelectionNeedsSkillRegistryWorkspaceEventFixture(scenarios: string[]): boolean {
  return scenarios.some((scenario) =>
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/vslo-270-stop-reload-reconnect.toml'),
  );
}

export function scenarioSelectionNeedsRelaunchReconnectCheck(scenarios: string[]): boolean {
  return scenarios.some((scenario) =>
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/vslo-270-stop-reload-reconnect.toml'),
  );
}

export function assertPilotScenarioSelectionIsolated(scenarios: string[]): void {
  if (scenarioSelectionNeedsModelStreamRetryFixture(scenarios) && scenarios.length > 1) {
    throw new Error(
      'model-stream-retry-no-progress must run as a focused pilot scenario because it enables a global orchestrator probe fixture.',
    );
  }
}

export function scenarioSelectionNeedsNoWorkspaceProfile(scenarios: string[]): boolean {
  return scenarios.some((scenario) =>
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/vslo-235-local-host-no-workspace.toml'),
  );
}

export function scenarioSelectionNeedsPortContentionFixture(scenarios: string[]): boolean {
  return scenarios.some((scenario) =>
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/vslo-235-local-host-port-contention.toml'),
  );
}

export function scenarioSelectionRequiresLiveManagedAiAuth(scenarios: string[]): boolean {
  return scenarios.some((scenario) =>
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/vslo-271-windows-idle-runtime-chain-recovery.toml'),
  );
}

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function resolveLiveDenAuthSnapshotPath(env: Record<string, string | undefined>): string | null {
  const snapshotPath = normalizeOptionalText(env.VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE)
    ?? normalizeOptionalText(env.E2E_DEN_AUTH_SNAPSHOT_FILE);
  return snapshotPath ? resolve(snapshotPath) : null;
}

function readDenAuthSummaryFromSnapshot(snapshotPath: string): { email: string | null; hasToken: boolean } {
  const raw = readFileSync(snapshotPath, 'utf8').replace(/^\uFEFF/, '');
  const snapshot = JSON.parse(raw) as { authJson?: unknown };
  const authRaw = typeof snapshot.authJson === 'string' ? snapshot.authJson : raw;
  const auth = JSON.parse(authRaw) as { token?: unknown; user?: { email?: unknown } };
  return {
    email: normalizeOptionalText(auth.user?.email),
    hasToken: Boolean(normalizeOptionalText(auth.token)),
  };
}

export function assertLiveManagedAiAuthForScenarioSelection(
  scenarios: string[],
  env: Record<string, string | undefined> = process.env,
): void {
  if (!scenarioSelectionRequiresLiveManagedAiAuth(scenarios)) return;

  if (env.E2E_MANAGED_AI_GATEWAY_FIXTURE?.trim() !== '0') {
    throw new Error(
      'VSLO-271 pilot must run the live managed-AI path. Set E2E_MANAGED_AI_GATEWAY_FIXTURE=0 before running it.',
    );
  }

  const snapshotPath = resolveLiveDenAuthSnapshotPath(env);
  if (!snapshotPath) {
    throw new Error(
      'VSLO-271 pilot requires live Den auth. Set VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE to a real user snapshot, for example C:\\Users\\jajse\\.veslo\\den-auth.json.',
    );
  }
  if (!existsSync(snapshotPath)) {
    throw new Error(`VSLO-271 live Den auth snapshot does not exist: ${snapshotPath}`);
  }

  const summary = readDenAuthSummaryFromSnapshot(snapshotPath);
  if (!summary.hasToken || !summary.email || summary.email.endsWith('@example.test')) {
    throw new Error(
      `VSLO-271 pilot requires a real Den user auth snapshot, got email=${summary.email ?? 'missing'} token=${summary.hasToken ? 'present' : 'missing'}.`,
    );
  }
}

async function startPortContentionFixture(): Promise<PortContentionFixture> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  if (!port) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw new Error('Port contention fixture did not bind a TCP port.');
  }

  const previousE2ePort = process.env.E2E_VESLO_SERVER_PORT;
  process.env.E2E_VESLO_SERVER_PORT = String(port);
  console.log(`[e2e] Port contention fixture holding 127.0.0.1:${port}`);
  return { server, previousE2ePort };
}

async function stopPortContentionFixture(fixture: PortContentionFixture | null): Promise<void> {
  if (!fixture) return;

  if (fixture.previousE2ePort === undefined) {
    delete process.env.E2E_VESLO_SERVER_PORT;
  } else {
    process.env.E2E_VESLO_SERVER_PORT = fixture.previousE2ePort;
  }

  await new Promise<void>((resolveClose, reject) => {
    fixture.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolveClose();
    });
  });
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

async function seedPilotDenAuthIfConfigured(
  options: Omit<RunPilotCommandOptions, 'args'> = {},
): Promise<void> {
  const authJson = resolvePilotDenAuthJson(options.env ?? process.env);
  if (!authJson) return;

  await runPilotCommand({
    ...options,
    args: ['eval', buildPilotDenAuthSeedScript(authJson)],
    timeoutMs: Math.min(10_000, options.timeoutMs ?? resolveLaunchTimeout()),
  });
  await ensurePilotReady(options);
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
  assertPilotScenarioSelectionIsolated(scenarios);
  assertLiveManagedAiAuthForScenarioSelection(scenarios);

  if (scenarioSelectionNeedsAutomationSecondaryWorkspace(scenarios)) {
    process.env.E2E_SEED_AUTOMATIONS_SECONDARY_WORKSPACE ||= '1';
  }
  if (scenarioSelectionNeedsSkillRegistryAuthFixture(scenarios)) {
    process.env.E2E_SKILL_REGISTRY_AUTH_BASE ||= 'fixture';
  }
  if (scenarioSelectionNeedsLegacySoulRuntime(scenarios)) {
    process.env.E2E_SEED_LEGACY_SOUL_RUNTIME ||= '1';
  }
  if (scenarioSelectionNeedsSkillEnableInventoryFixture(scenarios)) {
    process.env.E2E_SEED_SKILL_ENABLE_INVENTORY ||= '1';
  }
  if (scenarioSelectionNeedsGoogleMcpCatalogFixture(scenarios)) {
    process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE ||= '1';
  }
  if (scenarioSelectionNeedsSharePointMcpCatalogFixture(scenarios)) {
    process.env.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE ||= '1';
    process.env.E2E_SKILL_REGISTRY_FIXTURE ||= '1';
    process.env.E2E_SKILL_REGISTRY_AUTH_BASE ||= 'fixture';
  }
  if (scenarioSelectionNeedsManagedAiGatewayFixture(scenarios)) {
    process.env.E2E_MANAGED_AI_GATEWAY_FIXTURE ||= '1';
  }
  if (scenarioSelectionNeedsModelStreamRetryFixture(scenarios)) {
    process.env.E2E_RUN_ACTIVITY_PROBE_MODE ||= 'model-retry-no-progress';
    process.env.E2E_MANAGED_AI_RESPONSE_DELAY_MS ||= '30000';
    process.env.VESLO_AI_GATEWAY_PROVIDER_START_TIMEOUT_MS ||= '90000';
    process.env.VESLO_MODEL_RETRY_NO_PROGRESS_HARD_MS ||= '10000';
  }
  if (scenarioSelectionRequiresLiveManagedAiAuth(scenarios)) {
    process.env.VESLO_AI_GATEWAY_PROVIDER_START_TIMEOUT_MS ||= '90000';
  }
  if (scenarioSelectionNeedsSkillRegistryWorkspaceEventFixture(scenarios)) {
    process.env.E2E_SKILL_REGISTRY_EVENTS_MODE ||= 'workspace-update-repeat';
  }
  if (scenarioSelectionDisablesDevAutostart(scenarios)) {
    process.env.VESLO_DISABLE_DEV_AUTOSTART ||= '1';
  }
  if (scenarioSelectionNeedsNoWorkspaceProfile(scenarios)) {
    process.env.E2E_SKIP_DEFAULT_WORKSPACE_STATE ||= '1';
  }
  let portContentionFixture: PortContentionFixture | null = null;

  try {
    if (scenarioSelectionNeedsPortContentionFixture(scenarios)) {
      portContentionFixture = await startPortContentionFixture();
    }

    await startApp();
    await ensurePilotReady({ binary, socket, cwd: e2eRoot, timeoutMs });
    await seedPilotDenAuthIfConfigured({ binary, socket, cwd: e2eRoot, timeoutMs });
    for (const scenario of scenarios) {
      console.log(`[e2e] Running tauri-pilot scenario: ${scenario}`);
      await runPilotCommand({
        binary,
        socket,
        args: ['run', scenario],
        cwd: e2eRoot,
        inheritStdio: true,
      });
      if (scenarioSelectionNeedsRelaunchReconnectCheck([scenario])) {
        const reconnectScenario = join(e2eRoot, 'pilot-scenarios', 'vslo-270-relaunch-reconnect.toml');
        if (!existsSync(reconnectScenario)) {
          throw new Error(`tauri-pilot scenario not found: ${reconnectScenario}`);
        }
        console.log('[e2e] Restarting app for VSLO-270 relaunch reconnect check...');
        await stopApp();
        await startApp(undefined, { preserveIsolatedProfile: true });
        await ensurePilotReady({ binary, socket, cwd: e2eRoot, timeoutMs });
        console.log(`[e2e] Running tauri-pilot scenario: ${reconnectScenario}`);
        await runPilotCommand({
          binary,
          socket,
          args: ['run', reconnectScenario],
          cwd: e2eRoot,
          inheritStdio: true,
        });
      }
    }
  } finally {
    await stopApp();
    await stopPortContentionFixture(portContentionFixture);
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
