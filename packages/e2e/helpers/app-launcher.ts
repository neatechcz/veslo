import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve, dirname, win32, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDesktopAuthSeed } from './desktop-auth-seed.js';
import {
  createGoogleMcpCatalogDenAuthJson,
  E2E_SKILL_REGISTRY_ORG_ID,
  E2E_SKILL_REGISTRY_TOKEN,
  E2E_SKILL_REGISTRY_USER_ID,
  shouldUseGoogleMcpCatalogFixture,
  shouldUseSharePointMcpCatalogFixture,
  startSkillRegistryFixture,
  stopSkillRegistryFixture,
} from './skill-registry-fixture.js';
import {
  E2E_MANAGED_AI_ORG_ID,
  E2E_MANAGED_AI_TOKEN,
  E2E_MANAGED_AI_USER_ID,
  startManagedAiGatewayFixture,
  stopManagedAiGatewayFixture,
  type ManagedAiGatewayFixture,
} from './managed-ai-gateway-fixture.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_PILOT_IDENTIFIER = 'com.neatech.veslo.e2e';
const MAX_E2E_TIMEOUT = 95_000;
const DEFAULT_LAUNCH_TIMEOUT = MAX_E2E_TIMEOUT;
const LAUNCH_TIMEOUT = resolveLaunchTimeout();
const REAL_PROFILE_ENV = process.env.E2E_USE_EXISTING_PROFILE?.trim() === '1';
const CUSTOM_BINARY_PATH = process.env.E2E_TAURI_BINARY?.trim() ?? '';
const CUSTOM_OPENCODE_HOME = process.env.E2E_OPENCODE_HOME?.trim() ?? '';
const ISOLATED_PROFILE_ROOT = join(resolveDesktopRoot(), '..', 'e2e', '.tmp-veslo-home');
const PILOT_RUNTIME_ID = createHash('sha1').update(resolveDesktopRoot()).digest('hex').slice(0, 12);
const DEFAULT_PILOT_RUNTIME_DIR = posix.join('/tmp', `veslo-pilot-${PILOT_RUNTIME_ID}`);
const APP_IDENTIFIERS = [
  'com.neatech.veslo',
  'com.neatech.veslo.dev',
  'com.neatech.veslo.e2e',
  'com.differentai.openwork',
  'com.differentai.openwork.dev',
] as const;
const MANAGED_CHILD_PROCESS_NAMES = [
  'veslo-server.exe',
  'veslo-orchestrator.exe',
  'veslo-code-router.exe',
  'veslo-code.exe',
] as const;

let appProcess: ChildProcess | null = null;
let appProcessOwnedByHarness = false;
let lastOwnedAppProcessPid: number | null = null;
let managedChildCleanupPromise: Promise<number> | null = null;
let managedAiGatewayFixture: ManagedAiGatewayFixture | null = null;
let fixtureCleanupPromise: Promise<void> | null = null;
let appProcessExitPromise: Promise<AppProcessExit> | null = null;
let resolveAppProcessExit: ((result: AppProcessExit) => void) | null = null;

type AppProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

type TerminateAppProcessOptions = {
  platform?: NodeJS.Platform;
  forceKillAfterMs?: number;
  log?: (message: string) => void;
};

type TerminateAppProcessResult = {
  exited: boolean;
  forced: boolean;
};

type AppLaunchEnvOptions = {
  platform?: NodeJS.Platform;
  vesloServerPort?: number;
  pilotRuntimeDir?: string;
  opencodeHome: string;
  snapshotPath: string;
  denApiBase?: string | null;
};

type ResolvePilotRuntimeDirOptions = {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
};

type ResolvePilotSocketPathOptions = ResolvePilotRuntimeDirOptions & {
  runtimeDir?: string;
};

export type StartAppProfileContext = {
  profileRoot: string | null;
  opencodeHome: string | null;
  env: NodeJS.ProcessEnv;
};

export type StartAppOptions = {
  preserveIsolatedProfile?: boolean;
  beforeLaunch?: (context: StartAppProfileContext) => Promise<void> | void;
};

export function resolvePilotIdentifier(env: Record<string, string | undefined> = process.env): string {
  return env.E2E_TAURI_PILOT_IDENTIFIER?.trim() || DEFAULT_PILOT_IDENTIFIER;
}

export function resolveLaunchTimeout(env: Record<string, string | undefined> = process.env): number {
  const raw = env.E2E_LAUNCH_TIMEOUT?.trim();
  if (!raw) return DEFAULT_LAUNCH_TIMEOUT;

  const timeout = Number(raw);
  if (!Number.isInteger(timeout) || timeout < 1) {
    throw new Error(`Invalid E2E_LAUNCH_TIMEOUT: ${raw}`);
  }

  return Math.min(timeout, MAX_E2E_TIMEOUT);
}

function resolveDesktopRoot(): string {
  return resolve(join(__dirname, '..', '..', 'desktop'));
}

export function resolvePilotRuntimeDir(options: ResolvePilotRuntimeDirOptions = {}): string {
  const env = options.env ?? process.env;
  const explicit = env.E2E_TAURI_PILOT_RUNTIME_DIR?.trim();
  if (explicit) return explicit;
  if ((options.platform ?? process.platform) === 'win32') return '';
  return DEFAULT_PILOT_RUNTIME_DIR;
}

export function resolvePilotSocketPath(options: ResolvePilotSocketPathOptions = {}): string {
  const env = options.env ?? process.env;
  const explicit = env.E2E_TAURI_PILOT_SOCKET?.trim() || env.TAURI_PILOT_SOCKET?.trim();
  if (explicit) return explicit;

  const platform = options.platform ?? process.platform;
  const identifier = resolvePilotIdentifier(env);
  if (platform === 'win32') {
    return `\\\\.\\pipe\\tauri-pilot-${identifier}`;
  }

  const runtimeDir = options.runtimeDir ?? env.XDG_RUNTIME_DIR ?? resolvePilotRuntimeDir({ env, platform });
  return posix.join(runtimeDir, `tauri-pilot-${identifier}.sock`);
}

function preparePilotRuntimeDir(dir: string): void {
  if (process.platform === 'win32') return;
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
}

function resolveBinaryPath(): string {
  if (CUSTOM_BINARY_PATH) {
    if (existsSync(CUSTOM_BINARY_PATH)) return CUSTOM_BINARY_PATH;
    throw new Error(`Tauri binary not found at ${CUSTOM_BINARY_PATH}. Check E2E_TAURI_BINARY.`);
  }

  const desktopRoot = resolveDesktopRoot();
  const platform = process.platform;
  const tauriTarget = join(desktopRoot, 'src-tauri', 'target', 'debug');

  if (platform === 'win32') {
    const winPath = join(tauriTarget, 'veslo.exe');
    if (existsSync(winPath)) return winPath;
    throw new Error(`Tauri binary not found at ${winPath}. Run: pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e`);
  }

  const unbundledPath = join(tauriTarget, 'veslo');
  if (existsSync(unbundledPath)) return unbundledPath;

  if (platform === 'darwin') {
    const bundledPath = join(tauriTarget, 'bundle', 'macos', 'Veslo by Neatech.app', 'Contents', 'MacOS', 'veslo');
    if (existsSync(bundledPath)) return bundledPath;
  }

  throw new Error(`Tauri binary not found at ${unbundledPath}. Run: pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e`);
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export function buildWindowsManagedChildCleanupScript(parentProcessId: number): string {
  const names = MANAGED_CHILD_PROCESS_NAMES.map((name) => `'${name.replaceAll("'", "''")}'`).join(',');
  return [
    '$ErrorActionPreference = "SilentlyContinue";',
    `$targetParentPid = ${parentProcessId};`,
    `$names = @(${names});`,
    '$children = @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $targetParentPid -and $names -contains $_.Name });',
    'foreach ($child in $children) { Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue; }',
    'Write-Output $children.Count;',
  ].join(' ');
}

async function stopManagedChildProcessesForParent(parentProcessId: number | undefined): Promise<number> {
  if (process.platform !== 'win32' || !parentProcessId) return 0;

  const script = buildWindowsManagedChildCleanupScript(parentProcessId);
  return new Promise((resolveCleanup) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
      script,
    ], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const output: Uint8Array[] = [];
    child.stdout?.on('data', (chunk: Uint8Array) => output.push(chunk));
    child.on('error', () => resolveCleanup(0));
    child.on('exit', () => {
      const count = Number.parseInt(Buffer.concat(output).toString().trim(), 10);
      resolveCleanup(Number.isFinite(count) ? count : 0);
    });
  });
}

async function cleanupManagedChildProcessesForLastOwnedApp(reason: string): Promise<number> {
  const parentProcessId = lastOwnedAppProcessPid ?? undefined;
  if (!parentProcessId) return 0;

  let cleanupPromise: Promise<number>;
  let startedCleanup = false;
  if (managedChildCleanupPromise) {
    cleanupPromise = managedChildCleanupPromise;
  } else {
    startedCleanup = true;
    cleanupPromise = stopManagedChildProcessesForParent(parentProcessId).finally(() => {
      managedChildCleanupPromise = null;
      if (lastOwnedAppProcessPid === parentProcessId) {
        lastOwnedAppProcessPid = null;
      }
    });
    managedChildCleanupPromise = cleanupPromise;
  }

  const stoppedChildren = await cleanupPromise;
  if (startedCleanup && stoppedChildren > 0) {
    console.log(
      `[e2e] Stopped ${stoppedChildren} managed child process${stoppedChildren === 1 ? '' : 'es'} from app PID ${parentProcessId} (${reason}).`,
    );
  }
  return stoppedChildren;
}

function rotateExistingLogFile(path: string): void {
  if (!existsSync(path)) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  renameSync(path, `${path}.${stamp}`);
}

export async function terminateAppProcess(
  child: ChildProcess,
  options: TerminateAppProcessOptions = {},
): Promise<TerminateAppProcessResult> {
  const platform = options.platform ?? process.platform;
  const forceKillAfterMs = options.forceKillAfterMs ?? 5_000;
  const log = options.log ?? console.log;

  if (childHasExited(child)) {
    return { exited: true, forced: false };
  }

  let forced = false;
  let forceKillTimer: NodeJS.Timeout | null = null;
  let timeoutTimer: NodeJS.Timeout | null = null;

  const exited = await new Promise<boolean>((resolveExit) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolveExit(value);
    };

    child.once('exit', () => finish(true));
    if (childHasExited(child)) {
      finish(true);
      return;
    }

    if (platform === 'win32') {
      child.kill();
    } else {
      child.kill('SIGTERM');
    }

    forceKillTimer = setTimeout(() => {
      if (childHasExited(child)) return;

      forced = true;
      log('[e2e] Force killing app process...');
      if (platform === 'win32') {
        child.kill();
      } else {
        child.kill('SIGKILL');
      }
    }, forceKillAfterMs);

    timeoutTimer = setTimeout(() => {
      if (!childHasExited(child)) finish(false);
    }, forceKillAfterMs + 5_000);
  });

  return { exited, forced };
}

export function createAppLaunchEnv(
  baseEnv: NodeJS.ProcessEnv,
  options: AppLaunchEnvOptions,
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const joinForPlatform = platform === 'win32' ? win32.join : posix.join;
  const vesloDataDir = joinForPlatform(options.opencodeHome, '.veslo');
  const vesloAppConfigDir = joinForPlatform(vesloDataDir, 'app-config');
  const vesloAppDataDir = joinForPlatform(vesloDataDir, 'app-data');
  const vesloAppLocalDataDir = joinForPlatform(vesloDataDir, 'app-local-data');
  const denApiBase = options.denApiBase?.trim().replace(/\/+$/, '') ?? '';
  const pilotRuntimeDir = options.pilotRuntimeDir ?? resolvePilotRuntimeDir({ env: baseEnv, platform });
  const pilotSocket = resolvePilotSocketPath({ env: baseEnv, platform, runtimeDir: pilotRuntimeDir });
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    TAURI_PILOT_SOCKET: pilotSocket,
    OPENCODE_HOME: options.opencodeHome,
    VESLO_DATA_DIR: vesloDataDir,
    VESLO_APP_CONFIG_DIR: vesloAppConfigDir,
    VESLO_APP_DATA_DIR: vesloAppDataDir,
    VESLO_APP_LOCAL_DATA_DIR: vesloAppLocalDataDir,
    VESLO_DEN_AUTH_SNAPSHOT_PATH: options.snapshotPath,
    ...(options.vesloServerPort ? { VESLO_DESKTOP_SERVER_PORT: String(options.vesloServerPort) } : {}),
    ...(denApiBase ? { VESLO_DEN_API_BASE: denApiBase } : {}),
  };

  if (platform === 'win32') {
    env.APPDATA = win32.join(options.opencodeHome, 'AppData', 'Roaming');
    env.LOCALAPPDATA = win32.join(options.opencodeHome, 'AppData', 'Local');
    env.WEBVIEW2_USER_DATA_FOLDER = win32.join(options.opencodeHome, 'webview2');
  } else {
    env.XDG_RUNTIME_DIR = pilotRuntimeDir;
  }

  if (platform === 'linux') {
    delete env.WAYLAND_DISPLAY;
    env.GDK_BACKEND = 'x11';
  }

  return env;
}

function parseTcpPort(raw: string | undefined, label: string): number | null {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) return null;
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label}: ${trimmed}`);
  }
  return port;
}

async function findFreeTcpPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error('Unable to reserve a free Veslo server port for E2E.'));
          return;
        }
        resolvePort(port);
      });
    });
  });
}

async function resolveVesloServerPortForLaunch(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return (
    parseTcpPort(env.E2E_VESLO_SERVER_PORT, 'E2E_VESLO_SERVER_PORT') ??
    parseTcpPort(env.VESLO_DESKTOP_SERVER_PORT, 'VESLO_DESKTOP_SERVER_PORT') ??
    await findFreeTcpPort()
  );
}

const ENTERPRISE_CREATOR_SEED_MARKER = '.veslo-enterprise-creators';
const SKILL_ENABLE_FIXTURE_MARKER = '.veslo-skill-enable-inventory';
const E2E_SKILL_ENABLE_GENERATED_AT = '2026-06-06T00:00:00.000Z';

function shouldSeedAutomationsSecondaryWorkspace(env: NodeJS.ProcessEnv): boolean {
  return env.E2E_SEED_AUTOMATIONS_SECONDARY_WORKSPACE?.trim() === '1';
}

function shouldSeedSkillEnableInventory(env: NodeJS.ProcessEnv): boolean {
  return env.E2E_SEED_SKILL_ENABLE_INVENTORY?.trim() === '1';
}

function shouldSeedLegacySoulRuntime(env: NodeJS.ProcessEnv): boolean {
  return env.E2E_SEED_LEGACY_SOUL_RUNTIME?.trim() === '1';
}

function shouldSkipDefaultWorkspaceState(env: NodeJS.ProcessEnv): boolean {
  return env.E2E_SKIP_DEFAULT_WORKSPACE_STATE?.trim() === '1';
}

function fixtureSkillMarkdown(name: string, description: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `# ${name}`,
    '',
    description,
    '',
    '## When to use',
    `- ${description}`,
    '',
  ].join('\n');
}

function writeSkillFixture(root: string, name: string, description: string): string {
  const skillDir = join(root, name);
  rmSync(skillDir, { recursive: true, force: true });
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), fixtureSkillMarkdown(name, description));
  return skillDir;
}

function fixturePackageSha256(name: string, source: string): string {
  return createHash('sha256').update(`${source}:${name}`).digest('hex');
}

type SkillEnableMaterializationSeed = {
  installationId: string;
  skillId: string;
  name: string;
  versionId: string;
  source: 'organization' | 'platform';
  target: 'workspace' | 'personal-global';
  removalPolicy: 'locked';
  packageSha256: string;
  skillDir: string;
  materializedAt: string;
};

function writeManagedSkillMarker(entry: SkillEnableMaterializationSeed): void {
  writeFileSync(
    join(entry.skillDir, '.veslo-managed.json'),
    `${JSON.stringify({ schemaVersion: 1, ...entry }, null, 2)}\n`,
  );
}

function writeSkillMaterializationManifest(rootDir: string, entries: SkillEnableMaterializationSeed[]): void {
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(
    join(rootDir, '.veslo-materialization.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: E2E_SKILL_ENABLE_GENERATED_AT,
      entries,
    }, null, 2)}\n`,
  );
}

function seedSkillEnableInventoryFixture(input: {
  root: string;
  workspacePath: string;
  env: NodeJS.ProcessEnv;
}): void {
  const configRoot = input.env.XDG_CONFIG_HOME?.trim() || join(input.root, '.config');
  const globalSkillsRoot = join(configRoot, 'opencode', 'skills');
  const workspaceSkillsRoot = join(input.workspacePath, '.opencode', 'skills');
  const workspaceManagedRoot = join(workspaceSkillsRoot, 'veslo-managed');
  const globalManagedRoot = join(globalSkillsRoot, 'veslo-managed');

  mkdirSync(globalSkillsRoot, { recursive: true });
  mkdirSync(workspaceSkillsRoot, { recursive: true });

  writeSkillFixture(
    globalSkillsRoot,
    'e2e-enable-global-skill',
    'Global fixture skill for the enable switch desktop pilot scenario.',
  );
  writeSkillFixture(
    workspaceSkillsRoot,
    'e2e-enable-workspace-skill',
    'Workspace fixture skill for the enable switch desktop pilot scenario.',
  );

  const organizationSkillDir = writeSkillFixture(
    workspaceManagedRoot,
    'e2e-enable-org-skill',
    'Organization managed fixture skill for the enable switch desktop pilot scenario.',
  );
  const platformSkillDir = writeSkillFixture(
    globalManagedRoot,
    'e2e-enable-platform-skill',
    'Platform managed fixture skill for the enable switch desktop pilot scenario.',
  );

  const organizationEntry: SkillEnableMaterializationSeed = {
    installationId: 'install_e2e_enable_org_skill',
    skillId: 'skill_e2e_enable_org_skill',
    name: 'e2e-enable-org-skill',
    versionId: 'version_e2e_enable_org_skill_1',
    packageSha256: fixturePackageSha256('e2e-enable-org-skill', 'organization'),
    source: 'organization',
    target: 'workspace',
    removalPolicy: 'locked',
    skillDir: organizationSkillDir,
    materializedAt: E2E_SKILL_ENABLE_GENERATED_AT,
  };
  const platformEntry: SkillEnableMaterializationSeed = {
    installationId: 'install_e2e_enable_platform_skill',
    skillId: 'skill_e2e_enable_platform_skill',
    name: 'e2e-enable-platform-skill',
    versionId: 'version_e2e_enable_platform_skill_1',
    packageSha256: fixturePackageSha256('e2e-enable-platform-skill', 'platform'),
    source: 'platform',
    target: 'personal-global',
    removalPolicy: 'locked',
    skillDir: platformSkillDir,
    materializedAt: E2E_SKILL_ENABLE_GENERATED_AT,
  };

  writeManagedSkillMarker(organizationEntry);
  writeManagedSkillMarker(platformEntry);
  writeSkillMaterializationManifest(workspaceManagedRoot, [organizationEntry]);
  writeSkillMaterializationManifest(globalManagedRoot, [platformEntry]);
  writeFileSync(join(input.workspacePath, '.opencode', SKILL_ENABLE_FIXTURE_MARKER), 'enabled\n');
}

export function seedDefaultWorkspaceState(root: string, env: NodeJS.ProcessEnv): void {
  const workspacePath = join(root, 'workspaces', 'visual-workspace');
  const sessionQueueFixtureBaseUrl = env.E2E_SESSION_QUEUE_FIXTURE_BASE_URL?.trim() || null;
  const sessionQueueVesloServerUrl = env.E2E_SESSION_QUEUE_VESLO_SERVER_URL?.trim().replace(/\/+$/, '') || null;
  const sessionQueueVesloServerToken = env.E2E_SESSION_QUEUE_VESLO_SERVER_TOKEN?.trim() || null;
  const sessionQueueVesloWorkspaceId = env.E2E_SESSION_QUEUE_VESLO_WORKSPACE_ID?.trim() || null;
  const sessionQueueUsesVesloWorkspace = Boolean(
    sessionQueueFixtureBaseUrl &&
    sessionQueueVesloServerUrl &&
    sessionQueueVesloServerToken &&
    sessionQueueVesloWorkspaceId,
  );
  const sessionRuntimeRequiresExplicitActivation =
    sessionQueueUsesVesloWorkspace && env.E2E_SESSION_RUNTIME_REQUIRE_EXPLICIT_ACTIVATION?.trim() === '1';
  mkdirSync(workspacePath, { recursive: true });
  const opencodePath = join(workspacePath, '.opencode');
  mkdirSync(opencodePath, { recursive: true });
  writeFileSync(
    join(opencodePath, ENTERPRISE_CREATOR_SEED_MARKER),
    'skipped for deterministic e2e fixture\n',
  );
  if (shouldSeedLegacySoulRuntime(env)) {
    writeFileSync(join(opencodePath, 'soul-company.md'), '# Organization Soul\n\n- Existing organization memory\n');
    writeFileSync(join(opencodePath, 'soul-user.md'), '# User Soul\n');
    writeFileSync(join(opencodePath, 'soul-workspace.md'), '');
  }
  if (shouldSeedSkillEnableInventory(env)) {
    seedSkillEnableInventoryFixture({ root, workspacePath, env });
  }

  const secondaryAutomationWorkspacePath = join(root, 'workspaces', 'automations-secondary-workspace');
  const workspaces = [{
    id: 'e2e-visual-workspace',
    name: 'Visual Workspace',
    path: workspacePath,
    preset: 'starter',
    workspaceType: sessionQueueUsesVesloWorkspace ? 'remote' : 'local',
    remoteType: sessionQueueUsesVesloWorkspace ? 'veslo' : 'opencode',
    baseUrl: sessionQueueUsesVesloWorkspace
      ? `${sessionQueueVesloServerUrl}/w/${encodeURIComponent(sessionQueueVesloWorkspaceId!)}/opencode`
      : null,
    directory: sessionQueueUsesVesloWorkspace ? workspacePath : null,
    displayName: 'Visual Workspace',
    ...(sessionQueueUsesVesloWorkspace
      ? {
          vesloHostUrl: sessionQueueVesloServerUrl,
          vesloToken: sessionQueueVesloServerToken,
          vesloWorkspaceId: sessionQueueVesloWorkspaceId,
          vesloWorkspaceName: 'Visual Workspace',
        }
      : {}),
  }];

  // Remote workspaces deliberately lazy-boot. These lifecycle scenarios must
  // exercise the same user click that connects a pre-selected workspace, so
  // start them on a harmless remote entry instead of pre-activating the target.
  if (sessionRuntimeRequiresExplicitActivation) {
    workspaces.push({
      id: 'e2e-session-runtime-decoy',
      name: 'E2E activation decoy',
      path: workspacePath,
      preset: 'remote',
      workspaceType: 'remote',
      remoteType: 'opencode',
      baseUrl: 'http://127.0.0.1:9/e2e-activation-decoy',
      directory: workspacePath,
      displayName: 'E2E activation decoy',
    });
  }

  if (shouldSeedAutomationsSecondaryWorkspace(env)) {
    mkdirSync(secondaryAutomationWorkspacePath, { recursive: true });
    workspaces.push({
      id: 'e2e-automations-secondary-workspace',
      name: 'Automations Secondary Workspace',
      path: secondaryAutomationWorkspacePath,
      preset: 'starter',
      workspaceType: 'local',
      remoteType: 'opencode',
      baseUrl: null,
      directory: null,
      displayName: 'Automations Secondary Workspace',
    });
  }

  const workspaceState = {
    version: 4,
    activeId: sessionRuntimeRequiresExplicitActivation
      ? 'e2e-session-runtime-decoy'
      : 'e2e-visual-workspace',
    workspaces,
  };

  const xdgData = env.XDG_DATA_HOME ?? join(root, '.local', 'share');
  const appData = env.APPDATA ?? join(root, 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA ?? join(root, 'AppData', 'Local');
  const stateDirs = [
    env.VESLO_APP_DATA_DIR,
    env.VESLO_APP_LOCAL_DATA_DIR,
    ...(process.platform === 'darwin'
      ? APP_IDENTIFIERS.map(id => join(root, 'Library', 'Application Support', id))
      : process.platform === 'win32'
        ? APP_IDENTIFIERS.flatMap(id => [join(appData, id), join(localAppData, id)])
        : APP_IDENTIFIERS.map(id => join(xdgData, id))),
  ].filter((dir): dir is string => Boolean(dir));

  for (const dir of stateDirs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'veslo-workspaces.json'), JSON.stringify(workspaceState, null, 2));
  }
}

function shouldUseManagedAiGatewayFixture(): boolean {
  return process.env.E2E_MANAGED_AI_GATEWAY_FIXTURE?.trim() === '1';
}

export function resolveMcpCatalogFixtureDenApiBase(input: {
  skillRegistryFixtureBaseUrl: string | null;
  useGoogleMcpCatalogFixture: boolean;
  useSharePointMcpCatalogFixture: boolean;
}): string | null {
  if (!input.skillRegistryFixtureBaseUrl) return null;
  if (!input.useGoogleMcpCatalogFixture && !input.useSharePointMcpCatalogFixture) return null;
  return input.skillRegistryFixtureBaseUrl;
}

export function publishPilotDenAuthSeedForWebView(
  seedEnv: Record<string, string | undefined>,
  targetEnv: Record<string, string | undefined> = process.env,
): void {
  const existing = targetEnv.VESLO_E2E_DEN_AUTH_JSON?.trim() || targetEnv.E2E_DEN_AUTH_JSON?.trim();
  if (existing) return;

  const seed = seedEnv.VESLO_E2E_DEN_AUTH_JSON?.trim() || seedEnv.E2E_DEN_AUTH_JSON?.trim();
  if (!seed) return;

  targetEnv.E2E_DEN_AUTH_JSON = seed;
}

export function publishManagedAiFixtureAuthSeed(
  authJson: string,
  targetEnv: Record<string, string | undefined> = process.env,
): void {
  targetEnv.VESLO_E2E_DEN_AUTH_JSON = authJson;
  targetEnv.E2E_DEN_AUTH_JSON = authJson;
  delete targetEnv.VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE;
  delete targetEnv.E2E_DEN_AUTH_SNAPSHOT_FILE;
  delete targetEnv.VESLO_DEN_AUTH_SNAPSHOT_PATH;
}

async function startManagedAiGatewayFixtureIfRequested(): Promise<ManagedAiGatewayFixture | null> {
  if (!shouldUseManagedAiGatewayFixture()) {
    return null;
  }
  if (managedAiGatewayFixture) {
    return managedAiGatewayFixture;
  }

  managedAiGatewayFixture = await startManagedAiGatewayFixture();
  process.env.E2E_MANAGED_AI_GATEWAY_BASE_URL = managedAiGatewayFixture.baseUrl;
  process.env.VESLO_E2E_EXPECTED_MANAGED_AI_PROVIDER ||= 'codex_oauth';
  process.env.VESLO_E2E_EXPECTED_MANAGED_AI_MODEL ||= 'gpt-5.4';
  console.log(`[e2e] Managed AI gateway fixture: ${managedAiGatewayFixture.baseUrl}`);
  return managedAiGatewayFixture;
}

async function stopManagedAiGatewayFixtureIfRunning(): Promise<void> {
  const fixture = managedAiGatewayFixture;
  managedAiGatewayFixture = null;
  await stopManagedAiGatewayFixture(fixture);
}

async function cleanupStartedFixtures(): Promise<void> {
  fixtureCleanupPromise ??= (async () => {
    await stopManagedAiGatewayFixtureIfRunning();
    await stopSkillRegistryFixture();
  })().finally(() => {
    fixtureCleanupPromise = null;
  });
  return fixtureCleanupPromise;
}

export async function startApp(options: StartAppOptions = {}): Promise<void> {
  const binaryPath = resolveBinaryPath();
  const pilotRuntimeDir = resolvePilotRuntimeDir();
  preparePilotRuntimeDir(pilotRuntimeDir);
  console.log(`[e2e] Launching Tauri binary: ${binaryPath}`);
  const useGoogleMcpCatalogFixture = shouldUseGoogleMcpCatalogFixture();
  const useSharePointMcpCatalogFixture = shouldUseSharePointMcpCatalogFixture();
  const useMcpCatalogFixture = useGoogleMcpCatalogFixture || useSharePointMcpCatalogFixture;
  const skillRegistryFixtureBaseUrl = process.env.E2E_SKILL_REGISTRY_FIXTURE?.trim() === '0' && !useMcpCatalogFixture
    ? null
    : await startSkillRegistryFixture();
  const googleMcpCatalogFixtureBaseUrl = useGoogleMcpCatalogFixture ? skillRegistryFixtureBaseUrl : null;
  const mcpCatalogFixtureDenApiBase = resolveMcpCatalogFixtureDenApiBase({
    skillRegistryFixtureBaseUrl,
    useGoogleMcpCatalogFixture,
    useSharePointMcpCatalogFixture,
  });
  const managedAiGatewayFixtureBaseUrl = (await startManagedAiGatewayFixtureIfRequested())?.baseUrl ?? null;
  const exposeSkillRegistryServerEnv = process.env.E2E_SKILL_REGISTRY_SERVER_ENV?.trim() !== '0';
  const seedDenAuthFromSkillRegistryFixture =
    process.env.E2E_SKILL_REGISTRY_AUTH_BASE?.trim() === 'fixture' && Boolean(skillRegistryFixtureBaseUrl);
  const managedAiFixtureAuthJson = managedAiGatewayFixtureBaseUrl
    ? JSON.stringify({
        denApiBase: managedAiGatewayFixtureBaseUrl,
        token: E2E_MANAGED_AI_TOKEN,
        orgId: E2E_MANAGED_AI_ORG_ID,
        user: { id: E2E_MANAGED_AI_USER_ID, email: 'veslo-managed-ai-e2e@example.test' },
        org: { id: E2E_MANAGED_AI_ORG_ID, slug: 'veslo-managed-ai-e2e' },
      })
    : null;
  if (managedAiFixtureAuthJson) {
    publishManagedAiFixtureAuthSeed(managedAiFixtureAuthJson);
  }
  const seedEnv = managedAiFixtureAuthJson
    ? { ...process.env }
    : googleMcpCatalogFixtureBaseUrl
    ? {
        ...process.env,
        E2E_DEN_AUTH_JSON: createGoogleMcpCatalogDenAuthJson(googleMcpCatalogFixtureBaseUrl),
      }
    : seedDenAuthFromSkillRegistryFixture
    ? {
        ...process.env,
        E2E_DEN_AUTH_JSON: JSON.stringify({
          denApiBase: skillRegistryFixtureBaseUrl,
          token: E2E_SKILL_REGISTRY_TOKEN,
          orgId: E2E_SKILL_REGISTRY_ORG_ID,
          user: { id: `${E2E_SKILL_REGISTRY_USER_ID}_fixture`, email: 'veslo-registry-e2e@example.test' },
          org: { id: E2E_SKILL_REGISTRY_ORG_ID, slug: 'veslo-e2e' },
        }),
      }
    : process.env;
  if (!managedAiFixtureAuthJson) {
    publishPilotDenAuthSeedForWebView(seedEnv);
  }
  if (skillRegistryFixtureBaseUrl) {
    console.log(`[e2e] Skill registry fixture: ${skillRegistryFixtureBaseUrl}`);
  }
  if (googleMcpCatalogFixtureBaseUrl) {
    console.log(`[e2e] Google MCP catalog fixture: ${googleMcpCatalogFixtureBaseUrl}`);
  }
  if (useSharePointMcpCatalogFixture && mcpCatalogFixtureDenApiBase) {
    console.log(`[e2e] SharePoint MCP catalog fixture: ${mcpCatalogFixtureDenApiBase}`);
  }

  const tmpDir = join(resolveDesktopRoot(), '..', 'e2e', '.tmp-opencode-home');
  const vesloServerPort = await resolveVesloServerPortForLaunch();
  let env: NodeJS.ProcessEnv;
  let profileRoot: string | null = null;

  if (CUSTOM_OPENCODE_HOME) {
    profileRoot = CUSTOM_OPENCODE_HOME;
    const snapshotPath = prepareDesktopAuthSeed(CUSTOM_OPENCODE_HOME, seedEnv, {
      preserveExisting: true,
    });
    env = createAppLaunchEnv(seedEnv, {
      vesloServerPort,
      opencodeHome: CUSTOM_OPENCODE_HOME,
      snapshotPath,
      denApiBase: mcpCatalogFixtureDenApiBase,
    });
    if (!shouldSkipDefaultWorkspaceState(env)) {
      seedDefaultWorkspaceState(CUSTOM_OPENCODE_HOME, env);
    }
    console.log(`[e2e] Using custom OPENCODE_HOME: ${CUSTOM_OPENCODE_HOME}`);
  } else if (!REAL_PROFILE_ENV) {
    profileRoot = ISOLATED_PROFILE_ROOT;
    const preserveIsolatedProfile =
      options.preserveIsolatedProfile === true ||
      process.env.E2E_PRESERVE_ISOLATED_PROFILE?.trim() === '1';
    if (!preserveIsolatedProfile) {
      rmSync(ISOLATED_PROFILE_ROOT, { recursive: true, force: true });
      rmSync(tmpDir, { recursive: true, force: true });
    }
    const snapshotPath = prepareDesktopAuthSeed(tmpDir, seedEnv);
    env = createAppLaunchEnv(seedEnv, {
      vesloServerPort,
      opencodeHome: tmpDir,
      snapshotPath,
      denApiBase: mcpCatalogFixtureDenApiBase,
    });
    env.HOME = ISOLATED_PROFILE_ROOT;
    env.USERPROFILE = ISOLATED_PROFILE_ROOT;
    env.XDG_DATA_HOME = join(ISOLATED_PROFILE_ROOT, '.local', 'share');
    env.XDG_CONFIG_HOME = join(ISOLATED_PROFILE_ROOT, '.config');
    env.XDG_CACHE_HOME = join(ISOLATED_PROFILE_ROOT, '.cache');
    if (!shouldSkipDefaultWorkspaceState(env)) {
      seedDefaultWorkspaceState(ISOLATED_PROFILE_ROOT, env);
    }
    console.log(`[e2e] Using isolated app profile: ${ISOLATED_PROFILE_ROOT}${preserveIsolatedProfile ? ' (preserved)' : ''}`);
    console.log(`[e2e] Using isolated OPENCODE_HOME: ${tmpDir}${preserveIsolatedProfile ? ' (preserved)' : ''}`);
  } else {
    env = {
      ...process.env,
      ...(mcpCatalogFixtureDenApiBase ? { VESLO_DEN_API_BASE: mcpCatalogFixtureDenApiBase } : {}),
    } as NodeJS.ProcessEnv;
    if (process.platform !== 'win32') {
      env.XDG_RUNTIME_DIR = pilotRuntimeDir;
    }
    if (process.platform === 'linux') {
      delete env.WAYLAND_DISPLAY;
      env.GDK_BACKEND = 'x11';
    }
    console.log('[e2e] Using the app\'s existing profile and OPENCODE_HOME.');
  }
  console.log(`[e2e] Veslo server port: ${vesloServerPort}`);

  await options.beforeLaunch?.({
    profileRoot,
    opencodeHome: env.OPENCODE_HOME?.trim() || null,
    env,
  });

  const appLogRoot = env.OPENCODE_HOME
    ? join(env.OPENCODE_HOME, '.veslo', 'e2e-logs')
    : '';
  const appStdoutLog = appLogRoot ? join(appLogRoot, 'app-stdout.log') : '';
  const appStderrLog = appLogRoot ? join(appLogRoot, 'app-stderr.log') : '';
  if (appLogRoot) {
    mkdirSync(appLogRoot, { recursive: true });
    const header = `[e2e] started=${new Date().toISOString()} binary=${binaryPath}\n`;
    rotateExistingLogFile(appStdoutLog);
    rotateExistingLogFile(appStderrLog);
    writeFileSync(appStdoutLog, header, 'utf8');
    writeFileSync(appStderrLog, header, 'utf8');
    console.log(`[e2e] Capturing app logs: ${appLogRoot}`);
  }
  const appendAppLog = (path: string, data: Buffer) => {
    if (!path) return;
    appendFileSync(path, data);
  };

  appProcess = spawn(binaryPath, [], {
    env: {
      ...env,
      ...(skillRegistryFixtureBaseUrl && exposeSkillRegistryServerEnv
        ? {
            VESLO_SKILL_REGISTRY_BASE_URL: skillRegistryFixtureBaseUrl,
            VESLO_SKILL_REGISTRY_TOKEN: 'veslo-e2e-registry-token',
          }
        : {}),
      ...(managedAiGatewayFixtureBaseUrl
        ? {
            VESLO_MANAGED_AI_BASE_URL: managedAiGatewayFixtureBaseUrl,
            VESLO_AI_GATEWAY_BASE_URL: managedAiGatewayFixtureBaseUrl,
          }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  appProcessOwnedByHarness = true;
  lastOwnedAppProcessPid = appProcess.pid ?? null;
  managedChildCleanupPromise = null;
  appProcessExitPromise = new Promise<AppProcessExit>((resolveExit) => {
    resolveAppProcessExit = resolveExit;
  });

  appProcess.stdout?.on('data', (data: Buffer) => {
    appendAppLog(appStdoutLog, data);
    process.stdout.write(`[app:stdout] ${data}`);
  });
  appProcess.stderr?.on('data', (data: Buffer) => {
    appendAppLog(appStderrLog, data);
    process.stderr.write(`[app:stderr] ${data}`);
  });

  appProcess.on('exit', (code, signal) => {
    console.log(`[e2e] App process exited with code ${code}${signal ? ` signal ${signal}` : ''}`);
    const exitedPid = appProcess?.pid ?? lastOwnedAppProcessPid;
    lastOwnedAppProcessPid = exitedPid ?? null;
    appProcess = null;
    appProcessOwnedByHarness = false;
    resolveAppProcessExit?.({ code, signal });
    resolveAppProcessExit = null;
    void (async () => {
      await cleanupManagedChildProcessesForLastOwnedApp('app exit');
      await cleanupStartedFixtures();
    })().catch((error) => {
      console.warn(`[e2e] Failed to clean up after app exit: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
}

export async function waitForAppExit(): Promise<AppProcessExit | null> {
  return appProcessExitPromise ? await appProcessExitPromise : null;
}

export async function stopApp(): Promise<void> {
  if (!appProcessOwnedByHarness || !appProcess) {
    await cleanupManagedChildProcessesForLastOwnedApp('stop fallback');
    await cleanupStartedFixtures();
    return;
  }
  const processToStop = appProcess;
  const processToStopPid = processToStop.pid;
  console.log(`[e2e] Stopping app process (PID ${processToStop.pid})...`);

  const result = await terminateAppProcess(processToStop);
  if (appProcess === processToStop) {
    appProcess = null;
    appProcessOwnedByHarness = false;
  }
  if (!result.exited) {
    console.warn(`[e2e] App process PID ${processToStop.pid} did not exit after termination request.`);
  }
  lastOwnedAppProcessPid = processToStopPid ?? lastOwnedAppProcessPid;
  await cleanupManagedChildProcessesForLastOwnedApp('stopApp');
  await cleanupStartedFixtures();
}
