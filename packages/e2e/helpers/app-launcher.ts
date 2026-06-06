import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve, dirname, win32, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDesktopAuthSeed } from './desktop-auth-seed.js';
import {
  E2E_SKILL_REGISTRY_ORG_ID,
  E2E_SKILL_REGISTRY_TOKEN,
  E2E_SKILL_REGISTRY_USER_ID,
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

const DEFAULT_WEBDRIVER_PORT = 4445;
const DEFAULT_PILOT_IDENTIFIER = 'com.neatech.veslo.dev';
const DEFAULT_LAUNCH_TIMEOUT = 120_000;
const LAUNCH_TIMEOUT = resolveLaunchTimeout();
const REAL_PROFILE_ENV = process.env.E2E_USE_EXISTING_PROFILE?.trim() === '1';
const CUSTOM_BINARY_PATH = process.env.E2E_TAURI_BINARY?.trim() ?? '';
const CUSTOM_OPENCODE_HOME = process.env.E2E_OPENCODE_HOME?.trim() ?? '';
const ISOLATED_PROFILE_ROOT = join(resolveDesktopRoot(), '..', 'e2e', '.tmp-veslo-home');
const PILOT_RUNTIME_ID = createHash('sha1').update(resolveDesktopRoot()).digest('hex').slice(0, 12);
const DEFAULT_PILOT_RUNTIME_DIR = join('/tmp', `veslo-pilot-${PILOT_RUNTIME_ID}`);
const APP_IDENTIFIERS = [
  'com.neatech.veslo',
  'com.neatech.veslo.dev',
  'com.differentai.openwork',
  'com.differentai.openwork.dev',
] as const;

let appProcess: ChildProcess | null = null;
let appProcessOwnedByHarness = false;
let managedAiGatewayFixture: ManagedAiGatewayFixture | null = null;

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
  opencodeHome: string;
  snapshotPath: string;
  pilotRuntimeDir?: string;
};

type ResolvePilotSocketPathOptions = {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  runtimeDir?: string;
};

type ResolvePilotRuntimeDirOptions = {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
};

export function resolveWebDriverPort(env: Record<string, string | undefined> = process.env): number {
  const raw = env.E2E_WEBDRIVER_PORT?.trim();
  if (!raw) return DEFAULT_WEBDRIVER_PORT;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid E2E_WEBDRIVER_PORT: ${raw}`);
  }

  return port;
}

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

  return timeout;
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
  return join(runtimeDir, `tauri-pilot-${identifier}.sock`);
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
  const vesloAppDataDir = joinForPlatform(vesloDataDir, 'app-data');
  const vesloAppLocalDataDir = joinForPlatform(vesloDataDir, 'app-local-data');
  const pilotRuntimeDir = options.pilotRuntimeDir ?? resolvePilotRuntimeDir({ env: baseEnv, platform });
  const pilotSocket = resolvePilotSocketPath({
    env: baseEnv,
    platform,
    runtimeDir: pilotRuntimeDir,
  });
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    TAURI_PILOT_SOCKET: pilotSocket,
    OPENCODE_HOME: options.opencodeHome,
    VESLO_DATA_DIR: vesloDataDir,
    VESLO_APP_DATA_DIR: vesloAppDataDir,
    VESLO_APP_LOCAL_DATA_DIR: vesloAppLocalDataDir,
    VESLO_DEN_AUTH_SNAPSHOT_PATH: options.snapshotPath,
    ...(options.vesloServerPort ? { VESLO_DESKTOP_SERVER_PORT: String(options.vesloServerPort) } : {}),
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

export function seedDefaultWorkspaceState(root: string, env: NodeJS.ProcessEnv): void {
  const workspacePath = join(root, 'workspaces', 'visual-workspace');
  mkdirSync(workspacePath, { recursive: true });
  const opencodePath = join(workspacePath, '.opencode');
  mkdirSync(opencodePath, { recursive: true });
  writeFileSync(
    join(opencodePath, ENTERPRISE_CREATOR_SEED_MARKER),
    'skipped for deterministic e2e fixture\n',
  );

  const workspaceState = {
    version: 4,
    activeId: 'e2e-visual-workspace',
    workspaces: [{
      id: 'e2e-visual-workspace',
      name: 'Visual Workspace',
      path: workspacePath,
      preset: 'starter',
      workspaceType: 'local',
      remoteType: 'opencode',
      baseUrl: null,
      directory: null,
      displayName: 'Visual Workspace',
    }],
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

export async function ensureWebDriverReady(
  _port: number = DEFAULT_WEBDRIVER_PORT,
  _timeout: number = Math.min(5_000, LAUNCH_TIMEOUT),
): Promise<void> {
  throw new Error(
    'WebDriver has been replaced by tauri-pilot for Veslo desktop E2E. Convert this legacy WDIO test to a tauri-pilot scenario before running it.',
  );
}

export async function startApp(_legacyWebDriverPort?: number): Promise<void> {
  const binaryPath = resolveBinaryPath();
  const pilotRuntimeDir = resolvePilotRuntimeDir();
  preparePilotRuntimeDir(pilotRuntimeDir);
  const pilotSocket = resolvePilotSocketPath({ runtimeDir: pilotRuntimeDir });
  console.log(`[e2e] Launching Tauri binary: ${binaryPath}`);
  console.log(`[e2e] tauri-pilot socket: ${pilotSocket}`);
  const skillRegistryFixtureBaseUrl = process.env.E2E_SKILL_REGISTRY_FIXTURE?.trim() === '0'
    ? null
    : await startSkillRegistryFixture();
  const managedAiGatewayFixtureBaseUrl = (await startManagedAiGatewayFixtureIfRequested())?.baseUrl ?? null;
  const exposeSkillRegistryServerEnv = process.env.E2E_SKILL_REGISTRY_SERVER_ENV?.trim() !== '0';
  const seedDenAuthFromSkillRegistryFixture =
    process.env.E2E_SKILL_REGISTRY_AUTH_BASE?.trim() === 'fixture' && Boolean(skillRegistryFixtureBaseUrl);
  const seedEnv = managedAiGatewayFixtureBaseUrl
    ? {
        ...process.env,
        E2E_DEN_AUTH_JSON: JSON.stringify({
          denApiBase: managedAiGatewayFixtureBaseUrl,
          token: E2E_MANAGED_AI_TOKEN,
          orgId: E2E_MANAGED_AI_ORG_ID,
          user: { id: E2E_MANAGED_AI_USER_ID, email: 'veslo-managed-ai-e2e@example.test' },
          org: { id: E2E_MANAGED_AI_ORG_ID, slug: 'veslo-managed-ai-e2e' },
        }),
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
  if (skillRegistryFixtureBaseUrl) {
    console.log(`[e2e] Skill registry fixture: ${skillRegistryFixtureBaseUrl}`);
  }

  const tmpDir = join(resolveDesktopRoot(), '..', 'e2e', '.tmp-opencode-home');
  const vesloServerPort = await resolveVesloServerPortForLaunch();
  let env: NodeJS.ProcessEnv;

  if (CUSTOM_OPENCODE_HOME) {
    const snapshotPath = prepareDesktopAuthSeed(CUSTOM_OPENCODE_HOME, seedEnv, {
      preserveExisting: true,
    });
    env = createAppLaunchEnv(seedEnv, {
      vesloServerPort,
      opencodeHome: CUSTOM_OPENCODE_HOME,
      snapshotPath,
      pilotRuntimeDir,
    });
    seedDefaultWorkspaceState(CUSTOM_OPENCODE_HOME, env);
    console.log(`[e2e] Using custom OPENCODE_HOME: ${CUSTOM_OPENCODE_HOME}`);
  } else if (!REAL_PROFILE_ENV) {
    rmSync(ISOLATED_PROFILE_ROOT, { recursive: true, force: true });
    rmSync(tmpDir, { recursive: true, force: true });
    const snapshotPath = prepareDesktopAuthSeed(tmpDir, seedEnv);
    env = createAppLaunchEnv(seedEnv, {
      vesloServerPort,
      opencodeHome: tmpDir,
      snapshotPath,
      pilotRuntimeDir,
    });
    env.HOME = ISOLATED_PROFILE_ROOT;
    env.USERPROFILE = ISOLATED_PROFILE_ROOT;
    env.XDG_DATA_HOME = join(ISOLATED_PROFILE_ROOT, '.local', 'share');
    env.XDG_CONFIG_HOME = join(ISOLATED_PROFILE_ROOT, '.config');
    env.XDG_CACHE_HOME = join(ISOLATED_PROFILE_ROOT, '.cache');
    seedDefaultWorkspaceState(ISOLATED_PROFILE_ROOT, env);
    console.log(`[e2e] Using isolated app profile: ${ISOLATED_PROFILE_ROOT}`);
    console.log(`[e2e] Using isolated OPENCODE_HOME: ${tmpDir}`);
  } else {
    env = {
      ...process.env,
      TAURI_PILOT_SOCKET: pilotSocket,
      VESLO_DESKTOP_SERVER_PORT: String(vesloServerPort),
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

  appProcess.stdout?.on('data', (data: Buffer) => {
    process.stdout.write(`[app:stdout] ${data}`);
  });
  appProcess.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(`[app:stderr] ${data}`);
  });

  appProcess.on('exit', (code, signal) => {
    console.log(`[e2e] App process exited with code ${code}${signal ? ` signal ${signal}` : ''}`);
    appProcess = null;
    appProcessOwnedByHarness = false;
  });
}

export async function stopApp(): Promise<void> {
  if (!appProcessOwnedByHarness || !appProcess) {
    await stopManagedAiGatewayFixtureIfRunning();
    await stopSkillRegistryFixture();
    return;
  }
  const processToStop = appProcess;
  console.log(`[e2e] Stopping app process (PID ${processToStop.pid})...`);

  const result = await terminateAppProcess(processToStop);
  if (appProcess === processToStop) {
    appProcess = null;
    appProcessOwnedByHarness = false;
  }
  if (!result.exited) {
    console.warn(`[e2e] App process PID ${processToStop.pid} did not exit after termination request.`);
  }
  await stopManagedAiGatewayFixtureIfRunning();
  await stopSkillRegistryFixture();
}

/** Utility for HashRouter-based URL assertions (just the fragment). */
export function hashFragment(path: string): string {
  return `#${path.startsWith('/') ? path : '/' + path}`;
}

/**
 * Navigate to a hash route in the Tauri app.
 * WebDriver's browser.url() requires a full URL, so we use
 * window.location.hash to navigate within the HashRouter.
 */
export async function navigateToHash(path: string): Promise<void> {
  const hash = path.startsWith('/') ? path : '/' + path;
  const previousHash = await currentHashRoute().catch(() => '');
  await browser.execute((h: string) => {
    const oldUrl = window.location.href;
    window.location.hash = h;
    window.dispatchEvent(new HashChangeEvent('hashchange', {
      oldURL: oldUrl,
      newURL: window.location.href,
    }));
  }, hash);

  await browser.pause(50);
  const nextHash = await currentHashRoute().catch(() => '');
  if (nextHash === previousHash && !nextHash.includes(hash)) {
    const currentUrl = await browser.getUrl().catch(() => '');
    const baseUrl = currentUrl.replace(/#.*$/, '');
    if (!baseUrl) throw new Error(`Unable to resolve current URL before navigating to #${hash}`);
    await browser.url(`${baseUrl}#${hash}`);
  }
}

export async function currentHashRoute(): Promise<string> {
  return browser.execute(() => window.location.hash);
}

export async function waitForHashRoute(hashFragment: string, timeout = 10000): Promise<void> {
  await browser.waitUntil(
    async () => (await currentHashRoute()).includes(hashFragment),
    { timeout, timeoutMsg: `Route did not change to ${hashFragment} within ${timeout}ms` },
  );
}
