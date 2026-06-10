import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAppLaunchEnv,
  resolveLaunchTimeout,
  resolvePilotIdentifier,
  resolvePilotRuntimeDir,
  resolvePilotSocketPath,
  seedDefaultWorkspaceState,
  terminateAppProcess,
} from './app-launcher.js';

test('createAppLaunchEnv configures pilot and forces x11 on linux so GTK-backed Tauri can start in headless E2E runs', () => {
  const env = createAppLaunchEnv(
    {
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      HOME: '/tmp/home',
    },
    {
      platform: 'linux',
      opencodeHome: '/tmp/opencode-home',
      snapshotPath: '/tmp/opencode-home/.veslo/den-auth.json',
      pilotRuntimeDir: '/tmp/veslo-pilot-runtime',
    },
  );

  assert.equal(env.TAURI_PILOT_SOCKET, '/tmp/veslo-pilot-runtime/tauri-pilot-com.neatech.veslo.e2e.sock');
  assert.equal(env.OPENCODE_HOME, '/tmp/opencode-home');
  assert.equal(env.VESLO_DATA_DIR, '/tmp/opencode-home/.veslo');
  assert.equal(env.VESLO_APP_DATA_DIR, '/tmp/opencode-home/.veslo/app-data');
  assert.equal(env.VESLO_APP_LOCAL_DATA_DIR, '/tmp/opencode-home/.veslo/app-local-data');
  assert.equal(env.VESLO_BUN_CACHE_HOME, '/tmp/home');
  assert.equal(env.VESLO_DEN_AUTH_SNAPSHOT_PATH, '/tmp/opencode-home/.veslo/den-auth.json');
  assert.equal(env.XDG_RUNTIME_DIR, '/tmp/veslo-pilot-runtime');
  assert.equal(env.GDK_BACKEND, 'x11');
  assert.equal('WAYLAND_DISPLAY' in env, false);
});

test('createAppLaunchEnv isolates Windows app, local, WebView2, and pilot storage so stale desktop state does not override the E2E snapshot', () => {
  const env = createAppLaunchEnv(
    {
      USERPROFILE: 'C:\\Users\\micha',
    },
    {
      platform: 'win32',
      opencodeHome: 'C:\\temp\\veslo-e2e-home',
      snapshotPath: 'C:\\temp\\veslo-e2e-home\\.veslo\\den-auth.json',
    },
  );

  assert.equal(env.TAURI_PILOT_SOCKET, '\\\\.\\pipe\\tauri-pilot-com.neatech.veslo.e2e');
  assert.equal(env.OPENCODE_HOME, 'C:\\temp\\veslo-e2e-home');
  assert.equal(env.VESLO_DATA_DIR, 'C:\\temp\\veslo-e2e-home\\.veslo');
  assert.equal(env.VESLO_APP_DATA_DIR, 'C:\\temp\\veslo-e2e-home\\.veslo\\app-data');
  assert.equal(env.VESLO_APP_LOCAL_DATA_DIR, 'C:\\temp\\veslo-e2e-home\\.veslo\\app-local-data');
  assert.equal(env.VESLO_BUN_CACHE_HOME, 'C:\\Users\\micha');
  assert.equal(env.VESLO_DEN_AUTH_SNAPSHOT_PATH, 'C:\\temp\\veslo-e2e-home\\.veslo\\den-auth.json');
  assert.equal(env.APPDATA, 'C:\\temp\\veslo-e2e-home\\AppData\\Roaming');
  assert.equal(env.LOCALAPPDATA, 'C:\\temp\\veslo-e2e-home\\AppData\\Local');
  assert.equal(env.WEBVIEW2_USER_DATA_FOLDER, 'C:\\temp\\veslo-e2e-home\\webview2');
});

test('resolvePilotIdentifier defaults to the e2e app identifier used by the e2e build', () => {
  assert.equal(resolvePilotIdentifier({}), 'com.neatech.veslo.e2e');
  assert.equal(resolvePilotIdentifier({ E2E_TAURI_PILOT_IDENTIFIER: 'com.example.test' }), 'com.example.test');
});

test('resolvePilotSocketPath allows E2E runs to target an explicit pilot socket', () => {
  assert.equal(
    resolvePilotSocketPath({
      env: { E2E_TAURI_PILOT_SOCKET: '/tmp/veslo-custom.sock' },
      platform: 'linux',
      runtimeDir: '/tmp/veslo-pilot-runtime',
    }),
    '/tmp/veslo-custom.sock',
  );
  assert.equal(
    resolvePilotSocketPath({
      env: {},
      platform: 'darwin',
      runtimeDir: '/tmp/veslo-pilot-runtime',
    }),
    '/tmp/veslo-pilot-runtime/tauri-pilot-com.neatech.veslo.e2e.sock',
  );
});

test('resolvePilotRuntimeDir uses a short Unix path so the pilot socket stays below SUN_LEN', () => {
  const runtimeDir = resolvePilotRuntimeDir({ platform: 'darwin' });
  const socket = resolvePilotSocketPath({
    env: {},
    platform: 'darwin',
    runtimeDir,
  });

  assert.match(runtimeDir, /^\/tmp\/veslo-pilot-[a-f0-9]+$/);
  assert.equal(socket.length < 100, true);
});

test('createAppLaunchEnv can move the desktop Veslo server off the fixed production port', () => {
  const env = createAppLaunchEnv(
    {},
    {
      opencodeHome: '/tmp/opencode-home',
      snapshotPath: '/tmp/opencode-home/.veslo/den-auth.json',
      vesloServerPort: 61234,
    },
  );

  assert.equal(env.VESLO_DESKTOP_SERVER_PORT, '61234');
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
    const workspacePath = join(root, 'workspaces', 'visual-workspace');

    assert.equal(
      existsSync(join(workspacePath, '.opencode', '.veslo-enterprise-creators')),
      true,
    );
    assert.equal(
      execFileSync('git', ['-C', workspacePath, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
      realpathSync(workspacePath),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('seedDefaultWorkspaceState creates startup sidebar databases with transcript tables', {
  skip: !(existsSync('/usr/bin/sqlite3') || existsSync('/opt/homebrew/bin/sqlite3')) ? 'sqlite3 is required for DB fixture assertions.' : false,
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'veslo-e2e-home-'));
  const appDataRoot = join(root, '.veslo', 'app-data');
  try {
    seedDefaultWorkspaceState(root, {
      E2E_SEED_STARTUP_SIDEBAR_SESSIONS: '1',
      VESLO_APP_DATA_DIR: appDataRoot,
    });

    const sqlite = existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : '/opt/homebrew/bin/sqlite3';
    const chatDb = join(appDataRoot, 'private-workspaces', 'startup-chat', '.opencode', 'opencode.db');
    const projectDb = join(root, 'workspaces', 'startup-inactive-project', '.opencode', 'opencode.db');

    for (const dbPath of [chatDb, projectDb]) {
      const tables = execFileSync(sqlite, [dbPath, '.tables'], { encoding: 'utf8' });
      assert.match(tables, /\bsession\b/);
      assert.match(tables, /\bmessage\b/);
      assert.match(tables, /\bpart\b/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('seedDefaultWorkspaceState can seed all skill enable inventory scopes', () => {
  const root = mkdtempSync(join(tmpdir(), 'veslo-e2e-home-'));
  const configRoot = join(root, '.config');
  try {
    seedDefaultWorkspaceState(root, {
      E2E_SEED_SKILL_ENABLE_INVENTORY: '1',
      XDG_CONFIG_HOME: configRoot,
    });

    const workspacePath = join(root, 'workspaces', 'visual-workspace');
    const globalSkillsRoot = join(configRoot, 'opencode', 'skills');
    const workspaceSkillsRoot = join(workspacePath, '.opencode', 'skills');
    const platformManifest = JSON.parse(
      readFileSync(join(globalSkillsRoot, 'veslo-managed', '.veslo-materialization.json'), 'utf8'),
    ) as { entries: Array<{ name: string; source: string; target: string }> };
    const organizationManifest = JSON.parse(
      readFileSync(join(workspaceSkillsRoot, 'veslo-managed', '.veslo-materialization.json'), 'utf8'),
    ) as { entries: Array<{ name: string; source: string; target: string }> };

    assert.equal(existsSync(join(globalSkillsRoot, 'e2e-enable-global-skill', 'SKILL.md')), true);
    assert.equal(existsSync(join(workspaceSkillsRoot, 'e2e-enable-workspace-skill', 'SKILL.md')), true);
    assert.deepEqual(platformManifest.entries.map((entry) => [entry.name, entry.source, entry.target]), [
      ['e2e-enable-platform-skill', 'platform', 'personal-global'],
    ]);
    assert.deepEqual(organizationManifest.entries.map((entry) => [entry.name, entry.source, entry.target]), [
      ['e2e-enable-org-skill', 'organization', 'workspace'],
    ]);
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
