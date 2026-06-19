import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAppLaunchEnv,
  resolveLaunchTimeout,
  resolveWebDriverPort,
  seedDefaultWorkspaceState,
  terminateAppProcess,
} from './app-launcher.js';

test('createAppLaunchEnv forces x11 on linux so GTK-backed Tauri can start in headless E2E runs', () => {
  const env = createAppLaunchEnv(
    {
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      HOME: '/tmp/home',
    },
    {
      platform: 'linux',
      port: 4445,
      opencodeHome: '/tmp/opencode-home',
      snapshotPath: '/tmp/opencode-home/.veslo/den-auth.json',
    },
  );

  assert.equal(env.TAURI_WEBDRIVER_PORT, '4445');
  assert.equal(env.OPENCODE_HOME, '/tmp/opencode-home');
  assert.equal(env.VESLO_DATA_DIR, '/tmp/opencode-home/.veslo');
  assert.equal(env.VESLO_APP_DATA_DIR, '/tmp/opencode-home/.veslo/app-data');
  assert.equal(env.VESLO_APP_LOCAL_DATA_DIR, '/tmp/opencode-home/.veslo/app-local-data');
  assert.equal(env.VESLO_DEN_AUTH_SNAPSHOT_PATH, '/tmp/opencode-home/.veslo/den-auth.json');
  assert.equal(env.GDK_BACKEND, 'x11');
  assert.equal('WAYLAND_DISPLAY' in env, false);
});

test('createAppLaunchEnv forwards the Den API base for fixture-backed catalog E2E runs', () => {
  const env = createAppLaunchEnv(
    {
      HOME: '/tmp/home',
    },
    {
      platform: 'darwin',
      port: 4445,
      opencodeHome: '/tmp/opencode-home',
      snapshotPath: '/tmp/opencode-home/.veslo/den-auth.json',
      denApiBase: 'http://127.0.0.1:54321/',
    },
  );

  assert.equal(env.VESLO_DEN_API_BASE, 'http://127.0.0.1:54321');
});

test('createAppLaunchEnv isolates Windows app, local, and WebView2 storage so stale desktop state does not override the E2E snapshot', () => {
  const env = createAppLaunchEnv(
    {
      USERPROFILE: 'C:\\Users\\micha',
    },
    {
      platform: 'win32',
      port: 4445,
      opencodeHome: 'C:\\temp\\veslo-e2e-home',
      snapshotPath: 'C:\\temp\\veslo-e2e-home\\.veslo\\den-auth.json',
    },
  );

  assert.equal(env.TAURI_WEBDRIVER_PORT, '4445');
  assert.equal(env.OPENCODE_HOME, 'C:\\temp\\veslo-e2e-home');
  assert.equal(env.VESLO_DATA_DIR, 'C:\\temp\\veslo-e2e-home\\.veslo');
  assert.equal(env.VESLO_APP_DATA_DIR, 'C:\\temp\\veslo-e2e-home\\.veslo\\app-data');
  assert.equal(env.VESLO_APP_LOCAL_DATA_DIR, 'C:\\temp\\veslo-e2e-home\\.veslo\\app-local-data');
  assert.equal(env.VESLO_DEN_AUTH_SNAPSHOT_PATH, 'C:\\temp\\veslo-e2e-home\\.veslo\\den-auth.json');
  assert.equal(env.APPDATA, 'C:\\temp\\veslo-e2e-home\\AppData\\Roaming');
  assert.equal(env.LOCALAPPDATA, 'C:\\temp\\veslo-e2e-home\\AppData\\Local');
  assert.equal(env.WEBVIEW2_USER_DATA_FOLDER, 'C:\\temp\\veslo-e2e-home\\webview2');
});

test('resolveWebDriverPort allows E2E runs to move off a stale default port', () => {
  assert.equal(resolveWebDriverPort({ E2E_WEBDRIVER_PORT: '4455' }), 4455);
});

test('resolveLaunchTimeout gives cold desktop starts enough time by default', () => {
  assert.equal(resolveLaunchTimeout({}), 120000);
});

test('resolveLaunchTimeout allows local overrides for slow machines', () => {
  assert.equal(resolveLaunchTimeout({ E2E_LAUNCH_TIMEOUT: '180000' }), 180000);
});

test('seedDefaultWorkspaceState skips network-backed enterprise creators for deterministic E2E fixtures', () => {
  const root = mkdtempSync(join(tmpdir(), 'veslo-e2e-home-'));
  try {
    seedDefaultWorkspaceState(root, {});

    assert.equal(
      existsSync(join(root, 'workspaces', 'visual-workspace', '.opencode', '.veslo-enterprise-creators')),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('terminateAppProcess waits for stubborn app processes to exit before returning', {
  skip: process.platform === 'win32' ? 'POSIX signal escalation is not available on Windows.' : false,
}, async () => {
  const child = spawn(process.execPath, [
    '-e',
    'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);',
  ], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  try {
    await once(child.stdout!, 'data');

    const result = await terminateAppProcess(child, {
      forceKillAfterMs: 50,
      platform: process.platform,
      log: () => {},
    });

    assert.equal(result.exited, true);
    assert.equal(result.forced, true);
    assert.notEqual(child.exitCode ?? child.signalCode, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
});
