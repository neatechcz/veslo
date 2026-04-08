import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDesktopAuthSeed } from './desktop-auth-seed.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WEBDRIVER_PORT = 4445;
const LAUNCH_TIMEOUT = parseInt(process.env.E2E_LAUNCH_TIMEOUT ?? '30000', 10);
const POLL_INTERVAL = 250;

let appProcess: ChildProcess | null = null;
let appProcessOwnedByHarness = false;

type AppLaunchEnvOptions = {
  platform?: NodeJS.Platform;
  port: number;
  opencodeHome: string;
  snapshotPath: string;
};

function resolveDesktopRoot(): string {
  return resolve(join(__dirname, '..', '..', 'desktop'));
}

function resolveBinaryPath(): string {
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

export function createAppLaunchEnv(
  baseEnv: NodeJS.ProcessEnv,
  options: AppLaunchEnvOptions,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    TAURI_WEBDRIVER_PORT: String(options.port),
    OPENCODE_HOME: options.opencodeHome,
    VESLO_DEN_AUTH_SNAPSHOT_PATH: options.snapshotPath,
  };

  if ((options.platform ?? process.platform) === 'linux') {
    delete env.WAYLAND_DISPLAY;
    env.GDK_BACKEND = 'x11';
  }

  return env;
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

  const tmpDir = join(resolveDesktopRoot(), '..', 'e2e', '.tmp-opencode-home');
  const snapshotPath = prepareDesktopAuthSeed(tmpDir);

  appProcess = spawn(binaryPath, [], {
    env: createAppLaunchEnv(process.env, {
      port,
      opencodeHome: tmpDir,
      snapshotPath,
    }),
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
