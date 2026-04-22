import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WEBDRIVER_PORT = 4445;
const LAUNCH_TIMEOUT = parseInt(process.env.E2E_LAUNCH_TIMEOUT ?? '30000', 10);
const POLL_INTERVAL = 250;
const REAL_PROFILE_ENV = process.env.E2E_USE_EXISTING_PROFILE?.trim() === '1';
const CUSTOM_BINARY_PATH = process.env.E2E_TAURI_BINARY?.trim() ?? '';
const CUSTOM_OPENCODE_HOME = process.env.E2E_OPENCODE_HOME?.trim() ?? '';
const ISOLATED_PROFILE_ROOT = join(resolveDesktopRoot(), '..', 'e2e', '.tmp-veslo-home');
const APP_IDENTIFIERS = [
  'com.neatech.veslo',
  'com.neatech.veslo.dev',
  'com.differentai.openwork',
  'com.differentai.openwork.dev',
] as const;

let appProcess: ChildProcess | null = null;
let appProcessOwnedByHarness = false;

function resolveDesktopRoot(): string {
  return resolve(join(__dirname, '..', '..', 'desktop'));
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
    throw new Error(`Tauri binary not found at ${winPath}. Run: pnpm tauri build --debug --no-bundle -- --features e2e`);
  }

  const unbundledPath = join(tauriTarget, 'veslo');
  if (existsSync(unbundledPath)) return unbundledPath;

  if (platform === 'darwin') {
    const bundledPath = join(tauriTarget, 'bundle', 'macos', 'Veslo by Neatech.app', 'Contents', 'MacOS', 'veslo');
    if (existsSync(bundledPath)) return bundledPath;
  }

  throw new Error(`Tauri binary not found at ${unbundledPath}. Run: pnpm tauri build --debug --no-bundle -- --features e2e`);
}

async function pollStatus(port: number, timeout: number): Promise<void> {
  const url = `http://127.0.0.1:${port}/status`;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  throw new Error(`WebDriver server did not respond on ${url} within ${timeout}ms`);
}

async function hasReadyWebDriverServer(port: number): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/status`;
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

function prepareIsolatedProfileEnv(env: NodeJS.ProcessEnv): void {
  rmSync(ISOLATED_PROFILE_ROOT, { recursive: true, force: true });

  const xdgData = join(ISOLATED_PROFILE_ROOT, '.local', 'share');
  const xdgConfig = join(ISOLATED_PROFILE_ROOT, '.config');
  const xdgCache = join(ISOLATED_PROFILE_ROOT, '.cache');
  const appData = join(ISOLATED_PROFILE_ROOT, 'AppData', 'Roaming');
  const localAppData = join(ISOLATED_PROFILE_ROOT, 'AppData', 'Local');
  const orchestratorData = join(ISOLATED_PROFILE_ROOT, '.veslo', 'orchestrator');
  const opencodeHome = CUSTOM_OPENCODE_HOME || join(ISOLATED_PROFILE_ROOT, '.opencode');
  const workspacePath = join(ISOLATED_PROFILE_ROOT, 'workspaces', 'visual-workspace');

  for (const dir of [ISOLATED_PROFILE_ROOT, xdgData, xdgConfig, xdgCache, appData, localAppData, orchestratorData, opencodeHome, workspacePath]) {
    mkdirSync(dir, { recursive: true });
  }

  env.HOME = ISOLATED_PROFILE_ROOT;
  env.USERPROFILE = ISOLATED_PROFILE_ROOT;
  env.XDG_DATA_HOME = xdgData;
  env.XDG_CONFIG_HOME = xdgConfig;
  env.XDG_CACHE_HOME = xdgCache;
  env.APPDATA = appData;
  env.LOCALAPPDATA = localAppData;
  env.VESLO_DATA_DIR = orchestratorData;
  env.OPENCODE_HOME = opencodeHome;

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

  const stateDirs =
    process.platform === 'darwin'
      ? APP_IDENTIFIERS.map(id => join(ISOLATED_PROFILE_ROOT, 'Library', 'Application Support', id))
      : process.platform === 'win32'
        ? APP_IDENTIFIERS.flatMap(id => [join(appData, id), join(localAppData, id)])
        : APP_IDENTIFIERS.map(id => join(xdgData, id));

  for (const dir of stateDirs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'veslo-workspaces.json'), JSON.stringify(workspaceState, null, 2));
  }

  console.log(`[e2e] Using isolated app profile: ${ISOLATED_PROFILE_ROOT}`);
  if (CUSTOM_OPENCODE_HOME) {
    console.log(`[e2e] Using custom OPENCODE_HOME: ${CUSTOM_OPENCODE_HOME}`);
  } else {
    console.log(`[e2e] Using isolated OPENCODE_HOME: ${opencodeHome}`);
  }
}

export async function ensureWebDriverReady(
  port: number = WEBDRIVER_PORT,
  timeout: number = Math.max(POLL_INTERVAL, Math.min(5_000, LAUNCH_TIMEOUT)),
): Promise<void> {
  await pollStatus(port, timeout);
}

export async function startApp(port: number = WEBDRIVER_PORT): Promise<void> {
  if (await hasReadyWebDriverServer(port)) {
    console.log(`[e2e] Reusing existing WebDriver server on port ${port}.`);
    appProcess = null;
    appProcessOwnedByHarness = false;
    return;
  }

  const binaryPath = resolveBinaryPath();
  console.log(`[e2e] Launching Tauri binary: ${binaryPath}`);
  console.log(`[e2e] WebDriver port: ${port}`);

  const env = {
    ...process.env,
    TAURI_WEBDRIVER_PORT: String(port),
  } as NodeJS.ProcessEnv;

  if (!REAL_PROFILE_ENV) {
    prepareIsolatedProfileEnv(env);
  } else if (CUSTOM_OPENCODE_HOME) {
    env.OPENCODE_HOME = CUSTOM_OPENCODE_HOME;
    console.log(`[e2e] Using the app's existing profile with custom OPENCODE_HOME: ${CUSTOM_OPENCODE_HOME}`);
  } else {
    console.log("[e2e] Using the app's existing profile and OPENCODE_HOME.");
  }

  appProcess = spawn(binaryPath, [], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  appProcessOwnedByHarness = true;

  appProcess.stdout?.on('data', (data: Buffer) => {
    process.stdout.write(`[app:stdout] ${data}`);
  });
  appProcess.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(`[app:stderr] ${data}`);
  });

  appProcess.on('exit', (code) => {
    console.log(`[e2e] App process exited with code ${code}`);
    appProcess = null;
    appProcessOwnedByHarness = false;
  });

  try {
    console.log(`[e2e] Waiting for WebDriver server on port ${port}...`);
    await pollStatus(port, LAUNCH_TIMEOUT);
    console.log(`[e2e] WebDriver server is ready.`);
  } catch (error) {
    if (!appProcess) {
      throw new Error(
        `Spawned Tauri app exited before WebDriver became ready. ` +
        `If Veslo is already running, run it with the e2e WebDriver build or stop it before launching tests.`,
      );
    }
    stopApp();
    throw error;
  }
}

export function stopApp(): void {
  if (!appProcessOwnedByHarness || !appProcess) {
    return;
  }
  console.log(`[e2e] Stopping app process (PID ${appProcess.pid})...`);

  if (process.platform === 'win32') {
    appProcess.kill();
  } else {
    appProcess.kill('SIGTERM');
    const forceKillTimeout = setTimeout(() => {
      if (appProcess) {
        console.log('[e2e] Force killing app process...');
        appProcess.kill('SIGKILL');
      }
    }, 5000);
    appProcess.on('exit', () => clearTimeout(forceKillTimeout));
  }
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
  await browser.execute((h: string) => { window.location.hash = h; }, hash);
}
