import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveLaunchTimeout,
  resolvePilotRuntimeDir,
  resolvePilotSocketPath,
  startApp,
  stopApp,
} from './app-launcher.js';
import {
  startSessionQueueRuntimeFixture,
  type SessionQueueRuntimeFixture,
} from './session-queue-runtime-fixture.js';
import { createSessionRenderArtifactManifest } from './session-render-fixture.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_READY_POLL_INTERVAL = 250;
const DEFAULT_PILOT_SCENARIO_COMMAND_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_PILOT_SCENARIO_NAMES = ['smoke', 'navigation'] as const;
const MANAGED_AI_INFERENCE_SCENARIO_NAMES = [
  'global-unpublished-draft',
  'gpt-5-6-sol-three-message-roundtrip',
  'message-send-registry-degraded',
  'live-skills-finder-roundtrip',
  'model-stream-retry-no-progress',
  'pending-session-instance-isolation',
  'runtime-cold-start-session-handoff',
  'sidebar-session-retention',
  'startup-sidebar-existing-sessions',
  'vslo-270-stop-reload-reconnect',
  'vslo-271-windows-idle-runtime-chain-recovery',
] as const;
const PILOT_SCENARIO_SUITES = {
  'current-gate': [
    'smoke',
    'navigation',
    'admin-managed-ai-access',
    'attachment-staging',
    'composer',
    'extensions-mcp',
    'feedback-bug-report',
    'markdown-drop-guard',
    'skill-publish-dialog',
    'skills-global-inventory',
    'session-capabilities',
    'session-message-replacement',
    'skill-registry-materialization',
    'shared-workspace-skill-lock',
    'session-artifacts',
    'session-prefetch',
    'session',
    'settings-dashboard-link-tabs',
    'settings-gear-navigation',
    'sidebar-primary-actions-overflow',
    'sidebar-primary-actions-pointer-navigation',
    'typography',
    'veslo-server-startup',
    'visual-regression',
    'language-persistence',
  ],
  'live-inference': [
    'runtime-cold-start-session-handoff',
    'message-send-registry-degraded',
  ],
} as const;

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

type PilotCommandCaptureResult = {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  error: string | null;
};

type PilotFailureDiagnosticCommand = {
  name: string;
  args: string[];
  outputFile: string;
  timeoutMs?: number;
};

type ResolvePilotScenarioSelectionOptions = {
  scenario?: string[];
  suite?: string;
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

type PilotSuccessArtifactCommand = PilotFailureDiagnosticCommand;

const SESSION_RENDER_ARTIFACT_VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 768, height: 900 },
  { width: 1440, height: 1000 },
] as const;

type EnvironmentRestore = () => void;

type DenAuthSummary = {
  denApiBase: string | null;
  email: string | null;
  hasToken: boolean;
  source: string | null;
  token: string | null;
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

export function resolvePilotScenarioCommandTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.E2E_PILOT_SCENARIO_TIMEOUT_MS?.trim() ?? '';
  if (!raw) return DEFAULT_PILOT_SCENARIO_COMMAND_TIMEOUT_MS;

  const timeoutMs = Number(raw);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new Error(`Invalid E2E_PILOT_SCENARIO_TIMEOUT_MS: ${raw}`);
  }
  return timeoutMs;
}

export function sanitizePilotArtifactName(value: string): string {
  const base = basename(value.replaceAll('\\', '/')).replace(/\.toml$/i, '');
  const safe = base
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 96);
  return safe || 'scenario';
}

export function tailText(value: string, maxLength = 20_000): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, 1_000)}\n...<truncated ${value.length - maxLength} chars>...\n${value.slice(-maxLength + 1_000)}`;
}

export function pilotFailureDiagnosticCommands(outputDir: string): PilotFailureDiagnosticCommand[] {
  return [
    { name: 'state', args: ['--window', 'main', 'state', '--json'], outputFile: 'state.json' },
    { name: 'windows', args: ['windows', '--json'], outputFile: 'windows.json' },
    { name: 'snapshot', args: ['--window', 'main', 'snapshot', '-i', '--depth', '6'], outputFile: 'snapshot.txt' },
    { name: 'snapshot-json', args: ['--window', 'main', 'snapshot', '--json', '--depth', '5'], outputFile: 'snapshot.json' },
    { name: 'logs', args: ['--window', 'main', 'logs', '--last', '200', '--json'], outputFile: 'logs.json' },
    { name: 'network', args: ['--window', 'main', 'network', '--last', '200', '--json'], outputFile: 'network.json' },
    {
      name: 'network-failed',
      args: ['--window', 'main', 'network', '--failed', '--last', '100', '--json'],
      outputFile: 'network-failed.json',
    },
    { name: 'storage-local', args: ['--window', 'main', 'storage', '--json', 'list'], outputFile: 'storage-local.json' },
    { name: 'storage-session', args: ['--window', 'main', 'storage', '--session', '--json', 'list'], outputFile: 'storage-session.json' },
    { name: 'forms', args: ['--window', 'main', 'forms', '--json'], outputFile: 'forms.json' },
    {
      name: 'send-workflow-trace',
      args: [
        '--window',
        'main',
        'eval',
        '--json',
        '(window.__vesloDumpSendWorkflowTrace?.() ?? window.__vesloSendWorkflowTrace ?? []).slice(-300)',
      ],
      outputFile: 'send-workflow-trace.json',
    },
    { name: 'veslo-server-info', args: ['--window', 'main', 'ipc', '--json', 'veslo_server_info'], outputFile: 'veslo-server-info.json' },
    { name: 'workspace-bootstrap', args: ['--window', 'main', 'ipc', '--json', 'workspace_bootstrap'], outputFile: 'workspace-bootstrap.json' },
    {
      name: 'screenshot',
      args: ['--window', 'main', 'screenshot', join(outputDir, 'webview.png')],
      outputFile: 'screenshot.txt',
      timeoutMs: 10_000,
    },
  ];
}

export function defaultPilotScenarios(e2eRoot = resolve(__dirname, '..')): string[] {
  return DEFAULT_PILOT_SCENARIO_NAMES.map((name) => join(e2eRoot, 'pilot-scenarios', `${name}.toml`));
}

export function pilotScenarioSuiteNames(suiteName: string): string[] {
  const suite = PILOT_SCENARIO_SUITES[suiteName as keyof typeof PILOT_SCENARIO_SUITES];
  if (!suite) {
    throw new Error(`Unknown tauri-pilot scenario suite: ${suiteName}`);
  }
  return [...suite];
}

export function pilotReadinessProbeCommands(): string[][] {
  return [['ping'], ['state']];
}

export function resolvePilotDenAuthJson(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.VESLO_E2E_DEN_AUTH_JSON?.trim() || env.E2E_DEN_AUTH_JSON?.trim() || '';
  if (raw) return raw;

  const snapshotPath = resolveLiveDenAuthSnapshotPath(env);
  if (!snapshotPath || !existsSync(snapshotPath)) return null;

  return readDenAuthJsonFromSnapshot(snapshotPath);
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
  if (requested.length > 0 && options.suite?.trim()) {
    throw new Error('Use either --scenario or --suite, not both.');
  }
  if (options.suite?.trim()) {
    return pilotScenarioSuiteNames(options.suite.trim())
      .map((name) => join(e2eRoot, 'pilot-scenarios', `${name}.toml`));
  }
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
  void scenarios;
  return false;
}

export function scenarioSelectionNeedsModelStreamRetryFixture(scenarios: string[]): boolean {
  return scenarios.some((scenario) =>
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/model-stream-retry-no-progress.toml') ||
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/vslo-270-stop-reload-reconnect.toml'),
  );
}

export function scenarioSelectionDisablesDevAutostart(scenarios: string[]): boolean {
  return scenarios.some((scenario) => {
    const normalized = scenario.replaceAll('\\', '/');
    return normalized.endsWith('/pilot-scenarios/runtime-cold-start-session-handoff.toml') ||
      normalized.endsWith('/pilot-scenarios/vslo-270-stop-reload-reconnect.toml') ||
      MANAGED_AI_INFERENCE_SCENARIO_NAMES.some((name) =>
        normalized.endsWith(`/pilot-scenarios/${name}.toml`),
      );
  });
}

export function pilotSessionRenderSuccessArtifactCommands(outputDir: string): PilotSuccessArtifactCommand[] {
  const commands: PilotSuccessArtifactCommand[] = [];
  for (const viewport of SESSION_RENDER_ARTIFACT_VIEWPORTS) {
    const name = `${viewport.width}x${viewport.height}`;
    commands.push(
      {
        name: `position-${name}`,
        args: [
          '--window',
          'main',
          'ipc',
          'e2e_position_main_window',
          '--args',
          JSON.stringify({ width: viewport.width, height: viewport.height, x: 32, y: 32 }),
          '--json',
        ],
        outputFile: `position-${name}.json`,
      },
      {
        name: `settle-${name}`,
        args: ['--window', 'main', 'watch', '--selector', '[data-testid="session-center-pane"]', '--stable', '250', '--timeout', '10000'],
        outputFile: `settle-${name}.txt`,
        timeoutMs: 15_000,
      },
      {
        name: `screenshot-${name}`,
        args: ['--window', 'main', 'screenshot', join(outputDir, `session-${name}.png`)],
        outputFile: `screenshot-${name}.txt`,
        timeoutMs: 15_000,
      },
    );
  }
  commands.push({
    name: 'session-center-snapshot',
    args: ['--window', 'main', 'snapshot', '-i', '--selector', '[data-testid="session-center-pane"]', '--depth', '8'],
    outputFile: 'session-center.snapshot.txt',
    timeoutMs: 15_000,
  });
  return commands;
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

export function scenarioSelectionNeedsSessionQueueRuntimeFixture(scenarios: string[]): boolean {
  return scenarios.some((scenario) =>
    [
      'session-queue-durability',
      'session-render-stability',
      'session-run-truthfulness',
    ].some((name) => scenario.replaceAll('\\', '/').endsWith(`/pilot-scenarios/${name}.toml`)),
  );
}

export function scenarioSelectionRequiresExplicitSessionRuntimeActivation(scenarios: string[]): boolean {
  return scenarios.some((scenario) =>
    ['session-render-stability', 'session-run-truthfulness']
      .some((name) => scenario.replaceAll('\\', '/').endsWith(`/pilot-scenarios/${name}.toml`)),
  );
}

export function assertPilotScenarioSelectionIsolated(scenarios: string[]): void {
  if (scenarioSelectionNeedsModelStreamRetryFixture(scenarios) && scenarios.length > 1) {
    throw new Error(
      'model-stream-retry-no-progress must run as a focused pilot scenario because it enables a global orchestrator probe fixture.',
    );
  }
  if (scenarioSelectionNeedsSessionQueueRuntimeFixture(scenarios) && scenarios.length > 1) {
    throw new Error(
      'session-queue-durability must run as a focused pilot scenario because it owns a deterministic OpenCode and lifecycle fixture.',
    );
  }
}

export function assertSessionQueueRuntimeFixtureProfileIsolation(
  scenarios: string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (
    scenarioSelectionNeedsSessionQueueRuntimeFixture(scenarios) &&
    env.E2E_USE_EXISTING_PROFILE?.trim() === '1'
  ) {
    throw new Error(
      'session queue deterministic acceptance coverage must not use E2E_USE_EXISTING_PROFILE=1. Use the manual live-user Pilot smoke path separately.',
    );
  }
}

function setEnvironmentForFixture(values: Record<string, string>): EnvironmentRestore {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
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
  return scenarios.some((scenario) => {
    const normalized = scenario.replaceAll('\\', '/');
    return MANAGED_AI_INFERENCE_SCENARIO_NAMES.some((name) =>
      normalized.endsWith(`/pilot-scenarios/${name}.toml`),
    );
  });
}

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isLoopbackUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function resolveLiveDenAuthSnapshotPath(env: Record<string, string | undefined>): string | null {
  const snapshotPath = normalizeOptionalText(env.VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE)
    ?? normalizeOptionalText(env.E2E_DEN_AUTH_SNAPSHOT_FILE)
    ?? normalizeOptionalText(env.VESLO_DEN_AUTH_SNAPSHOT_PATH);
  return snapshotPath ? resolve(snapshotPath) : null;
}

function readDenAuthJsonFromSnapshot(snapshotPath: string): string {
  const raw = readFileSync(snapshotPath, 'utf8').replace(/^\uFEFF/, '');
  const snapshot = JSON.parse(raw) as { authJson?: unknown };
  return typeof snapshot.authJson === 'string' ? snapshot.authJson : raw;
}

function readDenAuthSummaryFromJson(authRaw: string, source: string | null): DenAuthSummary {
  const parsed = JSON.parse(authRaw.replace(/^\uFEFF/, '')) as {
    denApiBase?: unknown;
    token?: unknown;
    user?: { email?: unknown };
    source?: unknown;
  };
  return {
    denApiBase: normalizeOptionalText(parsed.denApiBase),
    email: normalizeOptionalText(parsed.user?.email),
    hasToken: Boolean(normalizeOptionalText(parsed.token)),
    source: normalizeOptionalText(parsed.source) ?? source,
    token: normalizeOptionalText(parsed.token),
  };
}

export function assertLiveManagedAiAuthForScenarioSelection(
  scenarios: string[],
  env: Record<string, string | undefined> = process.env,
): void {
  if (!scenarioSelectionRequiresLiveManagedAiAuth(scenarios)) return;

  if (env.E2E_MANAGED_AI_GATEWAY_FIXTURE?.trim() === '1') {
    throw new Error(
      'Managed-AI inference pilot scenarios must run the live managed-AI path. Unset E2E_MANAGED_AI_GATEWAY_FIXTURE or set it to 0.',
    );
  }

  const managedAiOverride =
    normalizeOptionalText(env.VESLO_MANAGED_AI_BASE_URL) ?? normalizeOptionalText(env.VESLO_AI_GATEWAY_BASE_URL);
  if (isLoopbackUrl(managedAiOverride)) {
    throw new Error(
      `Managed-AI inference pilot scenarios require a live managed-AI gateway, got loopback override: ${managedAiOverride}.`,
    );
  }

  let summary: DenAuthSummary | null = null;
  const rawAuthJson = normalizeOptionalText(env.VESLO_E2E_DEN_AUTH_JSON) ?? normalizeOptionalText(env.E2E_DEN_AUTH_JSON);
  if (rawAuthJson) {
    summary = readDenAuthSummaryFromJson(rawAuthJson, 'env');
  } else {
    const snapshotPath = resolveLiveDenAuthSnapshotPath(env);
    if (!snapshotPath) {
      throw new Error(
        'Managed-AI inference pilot scenarios require live Den auth. Set VESLO_DEN_AUTH_SNAPSHOT_PATH or VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE to a real user snapshot, for example C:\\Users\\jajse\\.veslo\\den-auth.json.',
      );
    }
    if (!existsSync(snapshotPath)) {
      throw new Error(`Live Den auth snapshot does not exist: ${snapshotPath}`);
    }
    summary = readDenAuthSummaryFromJson(readDenAuthJsonFromSnapshot(snapshotPath), snapshotPath);
  }

  const invalidReasons = [
    !summary.hasToken ? 'token missing' : null,
    !summary.email ? 'email missing' : null,
    summary.email?.endsWith('@example.test') ? `test email ${summary.email}` : null,
    summary.token?.startsWith('veslo-e2e-') ? 'E2E fixture token' : null,
    isLoopbackUrl(summary.denApiBase) ? `loopback Den base ${summary.denApiBase}` : null,
  ].filter((reason): reason is string => Boolean(reason));

  if (invalidReasons.length > 0) {
    throw new Error(
      `Managed-AI inference pilot scenarios require a real Den user auth seed, got email=${summary.email ?? 'missing'} token=${summary.hasToken ? 'present' : 'missing'} source=${summary.source ?? 'unknown'} (${invalidReasons.join(', ')}).`,
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
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: Uint8Array[] = [];
    const errors: Uint8Array[] = [];
    let timeout: NodeJS.Timeout | null = null;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      resolveCommand();
    };

    child.stdout?.on('data', (chunk: Uint8Array) => {
      output.push(chunk);
      if (options.inheritStdio) process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk: Uint8Array) => {
      errors.push(chunk);
      if (options.inheritStdio) process.stderr.write(chunk);
    });

    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
        finish(new Error(`tauri-pilot command timed out after ${options.timeoutMs}ms: ${args.join(' ')}`));
      }, options.timeoutMs);
    }

    child.on('error', (error) => {
      finish(error);
    });

    child.on('exit', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }

      const stderr = Buffer.concat(errors).toString().trim();
      const stdout = Buffer.concat(output).toString().trim();
      const detail = [stderr, stdout].filter(Boolean).join('\n');
      finish(new Error(`tauri-pilot exited with ${code ?? signal}: ${args.join(' ')}${detail ? `\n${tailText(detail)}` : ''}`));
    });
  });
}

async function runPilotCommandCapture(options: Omit<RunPilotCommandOptions, 'inheritStdio'>): Promise<PilotCommandCaptureResult> {
  const binary = options.binary ?? resolvePilotBinary(options.env);
  const socket = options.socket ?? resolvePilotSocketPath({ runtimeDir: resolvePilotRuntimeDir() });
  const { command, args } = buildPilotCommand({ binary, socket, args: options.args });

  return await new Promise<PilotCommandCaptureResult>((resolveCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: Uint8Array[] = [];
    const errors: Uint8Array[] = [];
    let timeout: NodeJS.Timeout | null = null;
    let timedOut = false;

    child.stdout?.on('data', (chunk: Uint8Array) => output.push(chunk));
    child.stderr?.on('data', (chunk: Uint8Array) => errors.push(chunk));

    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
      }, options.timeoutMs);
    }

    child.on('error', (error) => {
      if (timeout) clearTimeout(timeout);
      resolveCommand({
        command,
        args,
        stdout: Buffer.concat(output).toString(),
        stderr: Buffer.concat(errors).toString(),
        exitCode: null,
        signal: null,
        timedOut,
        error: error.message,
      });
    });

    child.on('exit', (code, signal) => {
      if (timeout) clearTimeout(timeout);
      resolveCommand({
        command,
        args,
        stdout: Buffer.concat(output).toString(),
        stderr: Buffer.concat(errors).toString(),
        exitCode: code,
        signal,
        timedOut,
        error: null,
      });
    });
  });
}

async function collectPilotFailureDiagnostics(options: {
  binary: string;
  socket: string;
  cwd: string;
  e2eRoot: string;
  scenario: string;
  error: unknown;
  timeoutMs: number;
}): Promise<void> {
  if (process.env.E2E_PILOT_FAILURE_DIAGNOSTICS?.trim() === '0') return;

  const scenarioName = sanitizePilotArtifactName(options.scenario);
  const outputDir = join(options.e2eRoot, 'tauri-pilot-failures', `diagnostics-${Date.now()}-${scenarioName}`);
  mkdirSync(outputDir, { recursive: true });

  const errorText = options.error instanceof Error
    ? `${options.error.stack ?? options.error.message}\n`
    : `${String(options.error)}\n`;
  writeFileSync(join(outputDir, 'failure.txt'), errorText, 'utf8');

  const commands = pilotFailureDiagnosticCommands(outputDir);
  const results: Array<{
    name: string;
    command: string;
    args: string[];
    outputFile: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    error: string | null;
  }> = [];

  for (const diagnostic of commands) {
    const result = await runPilotCommandCapture({
      binary: options.binary,
      socket: options.socket,
      cwd: options.cwd,
      args: diagnostic.args,
      timeoutMs: diagnostic.timeoutMs ?? Math.min(5_000, Math.max(1_000, options.timeoutMs)),
    });
    const body = [
      result.stdout.trim() ? result.stdout.trim() : null,
      result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : null,
      result.error ? `error:\n${result.error}` : null,
      result.exitCode === 0 && !result.timedOut ? null : `status: exit=${result.exitCode ?? 'null'} signal=${result.signal ?? 'null'} timedOut=${result.timedOut}`,
    ].filter(Boolean).join('\n\n');

    writeFileSync(join(outputDir, diagnostic.outputFile), body ? `${body}\n` : '', 'utf8');
    results.push({
      name: diagnostic.name,
      command: result.command,
      args: result.args,
      outputFile: diagnostic.outputFile,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      error: result.error,
    });
  }

  writeFileSync(join(outputDir, 'summary.json'), JSON.stringify({
    scenario: options.scenario,
    capturedAt: new Date().toISOString(),
    failure: errorText.trim(),
    commands: results,
  }, null, 2), 'utf8');

  console.error(`[e2e] Pilot failure diagnostics captured: ${outputDir}`);
}

async function collectSessionRenderSuccessArtifacts(options: {
  binary: string;
  socket: string;
  cwd: string;
  e2eRoot: string;
  timeoutMs: number;
}): Promise<void> {
  const outputDir = join(options.e2eRoot, 'tauri-pilot-artifacts', `session-render-stability-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });
  const commands = pilotSessionRenderSuccessArtifactCommands(outputDir);
  const results: Array<{ name: string; outputFile: string; command: string; args: string[] }> = [];

  for (const artifact of commands) {
    const result = await runPilotCommandCapture({
      binary: options.binary,
      socket: options.socket,
      cwd: options.cwd,
      args: artifact.args,
      timeoutMs: artifact.timeoutMs ?? Math.min(15_000, Math.max(1_000, options.timeoutMs)),
    });
    const body = [
      result.stdout.trim() ? result.stdout.trim() : null,
      result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : null,
      result.error ? `error:\n${result.error}` : null,
      result.exitCode === 0 && !result.timedOut ? null : `status: exit=${result.exitCode ?? 'null'} signal=${result.signal ?? 'null'} timedOut=${result.timedOut}`,
    ].filter(Boolean).join('\n\n');
    writeFileSync(join(outputDir, artifact.outputFile), body ? `${body}\n` : '', 'utf8');
    if (result.exitCode !== 0 || result.timedOut || result.error) {
      throw new Error(`Could not capture session-render-stability artifact ${artifact.name}: ${body || 'tauri-pilot returned no detail'}`);
    }
    results.push({ name: artifact.name, outputFile: artifact.outputFile, command: result.command, args: result.args });
  }

  const manifest = createSessionRenderArtifactManifest({
    widths: SESSION_RENDER_ARTIFACT_VIEWPORTS.map((viewport) => viewport.width),
  });
  writeFileSync(join(outputDir, 'manifest.json'), JSON.stringify({ ...manifest, commands: results }, null, 2), 'utf8');
  console.log(`[e2e] Session render artifacts captured: ${outputDir}`);
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
  const scenarioCommandTimeoutMs = resolvePilotScenarioCommandTimeoutMs();

  for (const scenario of scenarios) {
    if (!existsSync(scenario)) {
      throw new Error(`tauri-pilot scenario not found: ${scenario}`);
    }
  }
  assertPilotScenarioSelectionIsolated(scenarios);
  assertSessionQueueRuntimeFixtureProfileIsolation(scenarios);
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
  let sessionQueueRuntimeFixture: SessionQueueRuntimeFixture | null = null;
  let restoreSessionQueueFixtureEnvironment: EnvironmentRestore | null = null;

  try {
    if (scenarioSelectionNeedsPortContentionFixture(scenarios)) {
      portContentionFixture = await startPortContentionFixture();
    }
    if (scenarioSelectionNeedsSessionQueueRuntimeFixture(scenarios)) {
      sessionQueueRuntimeFixture = await startSessionQueueRuntimeFixture();
      restoreSessionQueueFixtureEnvironment = setEnvironmentForFixture({
        E2E_SESSION_QUEUE_FIXTURE_BASE_URL: sessionQueueRuntimeFixture.baseUrl,
        E2E_SESSION_QUEUE_VESLO_SERVER_URL: sessionQueueRuntimeFixture.vesloServerBaseUrl,
        E2E_SESSION_QUEUE_VESLO_SERVER_TOKEN: sessionQueueRuntimeFixture.vesloServerToken,
        E2E_SESSION_QUEUE_VESLO_WORKSPACE_ID: sessionQueueRuntimeFixture.vesloWorkspaceId,
        VESLO_DEV_SERVER_URL: sessionQueueRuntimeFixture.vesloServerBaseUrl,
        VESLO_DEV_SERVER_TOKEN: sessionQueueRuntimeFixture.vesloServerToken,
        ...(scenarioSelectionRequiresExplicitSessionRuntimeActivation(scenarios)
          ? { E2E_SESSION_RUNTIME_REQUIRE_EXPLICIT_ACTIVATION: '1' }
          : {}),
        VESLO_E2E_DEN_AUTH_JSON: '{}',
        VESLO_DISABLE_DEV_AUTOSTART: '1',
      });
      console.log(`[e2e] Session queue runtime fixture: ${sessionQueueRuntimeFixture.baseUrl}`);
    }

    const queueRuntimeFixtureForLaunch = sessionQueueRuntimeFixture;
    await startApp(queueRuntimeFixtureForLaunch
      ? {
          beforeLaunch: async ({ profileRoot, opencodeHome }) => {
            if (!profileRoot || !opencodeHome) {
              throw new Error('Session queue fixture requires the isolated E2E profile and OPENCODE_HOME.');
            }
            await queueRuntimeFixtureForLaunch.startVesloServer({
              workspacePath: join(profileRoot, 'workspaces', 'visual-workspace'),
              dataDir: join(opencodeHome, '.veslo', 'session-queue-server'),
            });
          },
        }
      : undefined);
    await ensurePilotReady({ binary, socket, cwd: e2eRoot, timeoutMs });
    await seedPilotDenAuthIfConfigured({ binary, socket, cwd: e2eRoot, timeoutMs });
    for (const scenario of scenarios) {
      console.log(`[e2e] Running tauri-pilot scenario: ${scenario}`);
      try {
        await runPilotCommand({
          binary,
          socket,
          args: ['run', scenario],
          cwd: e2eRoot,
          timeoutMs: scenarioCommandTimeoutMs,
          inheritStdio: true,
        });
        if (scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/session-render-stability.toml')) {
          await collectSessionRenderSuccessArtifacts({ binary, socket, cwd: e2eRoot, e2eRoot, timeoutMs });
        }
      } catch (error) {
        await collectPilotFailureDiagnostics({ binary, socket, cwd: e2eRoot, e2eRoot, scenario, error, timeoutMs });
        throw error;
      }
      if (scenarioSelectionNeedsRelaunchReconnectCheck([scenario])) {
        const reconnectScenario = join(e2eRoot, 'pilot-scenarios', 'vslo-270-relaunch-reconnect.toml');
        if (!existsSync(reconnectScenario)) {
          throw new Error(`tauri-pilot scenario not found: ${reconnectScenario}`);
        }
        console.log('[e2e] Restarting app for VSLO-270 relaunch reconnect check...');
        await stopApp();
        await startApp({ preserveIsolatedProfile: true });
        await ensurePilotReady({ binary, socket, cwd: e2eRoot, timeoutMs });
        console.log(`[e2e] Running tauri-pilot scenario: ${reconnectScenario}`);
        try {
          await runPilotCommand({
            binary,
            socket,
            args: ['run', reconnectScenario],
            cwd: e2eRoot,
            timeoutMs: scenarioCommandTimeoutMs,
            inheritStdio: true,
          });
        } catch (error) {
          await collectPilotFailureDiagnostics({
            binary,
            socket,
            cwd: e2eRoot,
            e2eRoot,
            scenario: reconnectScenario,
            error,
            timeoutMs,
          });
          throw error;
        }
      }
    }
  } finally {
    await stopApp();
    await stopPortContentionFixture(portContentionFixture);
    await sessionQueueRuntimeFixture?.stop();
    restoreSessionQueueFixtureEnvironment?.();
  }
}

export function parsePilotRunnerArgs(argv: string[]): ResolvePilotScenarioSelectionOptions {
  const scenario: string[] = [];
  let suite: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--scenario' || arg === '-s') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a scenario name or path`);
      scenario.push(value);
      index += 1;
    } else if (arg.startsWith('--scenario=')) {
      scenario.push(arg.slice('--scenario='.length));
    } else if (arg === '--suite') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a suite name`);
      suite = value;
      index += 1;
    } else if (arg.startsWith('--suite=')) {
      suite = arg.slice('--suite='.length);
    }
  }
  return { scenario, suite };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === __filename) {
  runPilotScenarios(parsePilotRunnerArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
