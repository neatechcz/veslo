import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as appLauncherModule from './app-launcher.js';
import {
  buildWindowsManagedChildCleanupScript,
  createAppLaunchEnv,
  publishPilotDenAuthSeedForWebView,
  resolveLaunchTimeout,
  resolveMcpCatalogFixtureDenApiBase,
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
  assert.equal(env.VESLO_APP_CONFIG_DIR, '/tmp/opencode-home/.veslo/app-config');
  assert.equal(env.VESLO_APP_DATA_DIR, '/tmp/opencode-home/.veslo/app-data');
  assert.equal(env.VESLO_APP_LOCAL_DATA_DIR, '/tmp/opencode-home/.veslo/app-local-data');
  assert.equal(env.VESLO_DEN_AUTH_SNAPSHOT_PATH, '/tmp/opencode-home/.veslo/den-auth.json');
  assert.equal(env.XDG_RUNTIME_DIR, '/tmp/veslo-pilot-runtime');
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
      vesloServerPort: 4445,
      opencodeHome: '/tmp/opencode-home',
      snapshotPath: '/tmp/opencode-home/.veslo/den-auth.json',
      denApiBase: 'http://127.0.0.1:54321/',
    },
  );

  assert.equal(env.VESLO_DEN_API_BASE, 'http://127.0.0.1:54321');
});

test('resolveMcpCatalogFixtureDenApiBase forwards the fixture base for Google or SharePoint catalog scenarios', () => {
  assert.equal(
    resolveMcpCatalogFixtureDenApiBase({
      skillRegistryFixtureBaseUrl: 'http://127.0.0.1:54321',
      useGoogleMcpCatalogFixture: true,
      useSharePointMcpCatalogFixture: false,
    }),
    'http://127.0.0.1:54321',
  );
  assert.equal(
    resolveMcpCatalogFixtureDenApiBase({
      skillRegistryFixtureBaseUrl: 'http://127.0.0.1:54321',
      useGoogleMcpCatalogFixture: false,
      useSharePointMcpCatalogFixture: true,
    }),
    'http://127.0.0.1:54321',
  );
  assert.equal(
    resolveMcpCatalogFixtureDenApiBase({
      skillRegistryFixtureBaseUrl: 'http://127.0.0.1:54321',
      useGoogleMcpCatalogFixture: false,
      useSharePointMcpCatalogFixture: false,
    }),
    null,
  );
});

test('publishPilotDenAuthSeedForWebView exposes fixture auth to Pilot seeding without overriding explicit auth', () => {
  const target: Record<string, string | undefined> = {};

  publishPilotDenAuthSeedForWebView({ E2E_DEN_AUTH_JSON: '{"token":"fixture"}' }, target);
  assert.equal(target.E2E_DEN_AUTH_JSON, '{"token":"fixture"}');

  publishPilotDenAuthSeedForWebView({ E2E_DEN_AUTH_JSON: '{"token":"other"}' }, target);
  assert.equal(target.E2E_DEN_AUTH_JSON, '{"token":"fixture"}');

  const explicitTarget = { VESLO_E2E_DEN_AUTH_JSON: '{"token":"explicit"}' };
  publishPilotDenAuthSeedForWebView({ E2E_DEN_AUTH_JSON: '{"token":"fixture"}' }, explicitTarget);
  assert.deepEqual(explicitTarget, { VESLO_E2E_DEN_AUTH_JSON: '{"token":"explicit"}' });
});

test('managed AI fixture auth replaces live auth inputs and prevents snapshot fallback', () => {
  const target: Record<string, string | undefined> = {
    VESLO_E2E_DEN_AUTH_JSON: '{"token":"live-veslo"}',
    E2E_DEN_AUTH_JSON: '{"token":"live-fallback"}',
    VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE: '/tmp/live-veslo-snapshot.json',
    E2E_DEN_AUTH_SNAPSHOT_FILE: '/tmp/live-fallback-snapshot.json',
    VESLO_DEN_AUTH_SNAPSHOT_PATH: '/tmp/live-production-snapshot.json',
  };
  const fixtureAuth = '{"token":"fixture"}';

  const publishFixtureAuth = (appLauncherModule as Record<string, unknown>).publishManagedAiFixtureAuthSeed;
  assert.equal(typeof publishFixtureAuth, 'function');
  (publishFixtureAuth as (authJson: string, env: Record<string, string | undefined>) => void)(fixtureAuth, target);

  assert.equal(target.VESLO_E2E_DEN_AUTH_JSON, fixtureAuth);
  assert.equal(target.E2E_DEN_AUTH_JSON, fixtureAuth);
  assert.equal('VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE' in target, false);
  assert.equal('E2E_DEN_AUTH_SNAPSHOT_FILE' in target, false);
  assert.equal('VESLO_DEN_AUTH_SNAPSHOT_PATH' in target, false);
});

test('createAppLaunchEnv isolates Windows app, local, and WebView2 storage so stale desktop state does not override the E2E snapshot', () => {
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
  assert.equal(env.VESLO_APP_CONFIG_DIR, 'C:\\temp\\veslo-e2e-home\\.veslo\\app-config');
  assert.equal(env.VESLO_APP_DATA_DIR, 'C:\\temp\\veslo-e2e-home\\.veslo\\app-data');
  assert.equal(env.VESLO_APP_LOCAL_DATA_DIR, 'C:\\temp\\veslo-e2e-home\\.veslo\\app-local-data');
  assert.equal(env.VESLO_DEN_AUTH_SNAPSHOT_PATH, 'C:\\temp\\veslo-e2e-home\\.veslo\\den-auth.json');
  assert.equal(env.APPDATA, 'C:\\temp\\veslo-e2e-home\\AppData\\Roaming');
  assert.equal(env.LOCALAPPDATA, 'C:\\temp\\veslo-e2e-home\\AppData\\Local');
  assert.equal(env.WEBVIEW2_USER_DATA_FOLDER, 'C:\\temp\\veslo-e2e-home\\webview2');
});

test('resolvePilotIdentifier defaults to the dedicated e2e app identifier', () => {
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

test('resolveLaunchTimeout caps E2E launch waits at 95 seconds by default', () => {
  assert.equal(resolveLaunchTimeout({}), 95000);
});

test('resolveLaunchTimeout allows shorter local overrides and caps longer ones', () => {
  assert.equal(resolveLaunchTimeout({ E2E_LAUNCH_TIMEOUT: '45000' }), 45000);
  assert.equal(resolveLaunchTimeout({ E2E_LAUNCH_TIMEOUT: '180000' }), 95000);
});

test('startApp does not expose legacy WebDriver wiring in the tauri-pilot harness', () => {
  const source = readFileSync(new URL('./app-launcher.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /hasReadyWebDriverServer/);
  assert.doesNotMatch(source, /ensureWebDriverReady/);
  assert.doesNotMatch(source, /TAURI_WEBDRIVER_PORT/);
  assert.doesNotMatch(source, /E2E_WEBDRIVER_PORT/);
});

test('startApp can relaunch while preserving the isolated profile for reconnect checks', () => {
  const source = readFileSync(new URL('./app-launcher.ts', import.meta.url), 'utf8');

  assert.match(source, /type StartAppOptions = \{\s*preserveIsolatedProfile\?: boolean;\s*beforeLaunch\?: \(context: StartAppProfileContext\) => Promise<void> \| void;\s*\}/);
  assert.match(source, /startApp\(options: StartAppOptions = \{\}\)/);
  assert.match(source, /options\.preserveIsolatedProfile === true/);
  assert.match(source, /E2E_PRESERVE_ISOLATED_PROFILE/);
});

test('Windows managed child cleanup is scoped to the launched app PID and known Veslo sidecars', () => {
  const script = buildWindowsManagedChildCleanupScript(12345);

  assert.match(script, /\$targetParentPid = 12345/);
  assert.match(script, /ParentProcessId -eq \$targetParentPid/);
  assert.match(script, /veslo-server\.exe/);
  assert.match(script, /veslo-orchestrator\.exe/);
  assert.match(script, /veslo-code-router\.exe/);
  assert.doesNotMatch(script, /Stop-Process -Name/);
});

test('startApp retains the launched PID for child cleanup even after unexpected app exit', () => {
  const source = readFileSync(new URL('./app-launcher.ts', import.meta.url), 'utf8');

  assert.match(source, /let lastOwnedAppProcessPid: number \| null = null/);
  assert.match(source, /lastOwnedAppProcessPid = appProcess\.pid \?\? null/);
  assert.match(source, /appProcess\.on\('exit'[\s\S]*cleanupManagedChildProcessesForLastOwnedApp\('app exit'\)/);
  assert.match(source, /if \(!appProcessOwnedByHarness \|\| !appProcess\) \{[\s\S]*cleanupManagedChildProcessesForLastOwnedApp\('stop fallback'\)/);
});

test('startApp rotates previous app logs before writing the latest E2E capture', () => {
  const source = readFileSync(new URL('./app-launcher.ts', import.meta.url), 'utf8');

  assert.match(source, /function rotateExistingLogFile\(path: string\): void/);
  assert.match(source, /renameSync\(path, `\$\{path\}\.\$\{stamp\}`\)/);
  assert.match(source, /rotateExistingLogFile\(appStdoutLog\)/);
  assert.match(source, /rotateExistingLogFile\(appStderrLog\)/);
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

test('seedDefaultWorkspaceState uses the deterministic queue fixture as a remote Veslo workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'veslo-e2e-queue-home-'));
  try {
    seedDefaultWorkspaceState(root, {
      E2E_SESSION_QUEUE_FIXTURE_BASE_URL: 'http://127.0.0.1:45678',
      E2E_SESSION_QUEUE_VESLO_SERVER_URL: 'http://127.0.0.1:45679',
      E2E_SESSION_QUEUE_VESLO_SERVER_TOKEN: 'session-queue-e2e-token',
      E2E_SESSION_QUEUE_VESLO_WORKSPACE_ID: 'session-queue-workspace',
    });
    const stateDirectory = process.platform === 'win32'
      ? join(root, 'AppData', 'Roaming', 'com.neatech.veslo.e2e')
      : join(root, '.local', 'share', 'com.neatech.veslo.e2e');
    const state = JSON.parse(
      readFileSync(join(stateDirectory, 'veslo-workspaces.json'), 'utf8'),
    ) as { workspaces: Array<{ workspaceType?: string; baseUrl?: string | null }> };
    assert.deepEqual(state.workspaces, [
      {
        id: 'e2e-visual-workspace',
        name: 'Visual Workspace',
        path: join(root, 'workspaces', 'visual-workspace'),
        preset: 'starter',
        workspaceType: 'remote',
        remoteType: 'veslo',
        baseUrl: 'http://127.0.0.1:45679/w/session-queue-workspace/opencode',
        directory: join(root, 'workspaces', 'visual-workspace'),
        displayName: 'Visual Workspace',
        vesloHostUrl: 'http://127.0.0.1:45679',
        vesloToken: 'session-queue-e2e-token',
        vesloWorkspaceId: 'session-queue-workspace',
        vesloWorkspaceName: 'Visual Workspace',
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('seedDefaultWorkspaceState can require an explicit user activation for session runtime fixtures', () => {
  const root = mkdtempSync(join(tmpdir(), 'veslo-e2e-session-runtime-home-'));
  try {
    seedDefaultWorkspaceState(root, {
      E2E_SESSION_QUEUE_FIXTURE_BASE_URL: 'http://127.0.0.1:45678',
      E2E_SESSION_QUEUE_VESLO_SERVER_URL: 'http://127.0.0.1:45679',
      E2E_SESSION_QUEUE_VESLO_SERVER_TOKEN: 'session-queue-e2e-token',
      E2E_SESSION_QUEUE_VESLO_WORKSPACE_ID: 'session-queue-workspace',
      E2E_SESSION_RUNTIME_REQUIRE_EXPLICIT_ACTIVATION: '1',
    });
    const stateDirectory = process.platform === 'win32'
      ? join(root, 'AppData', 'Roaming', 'com.neatech.veslo.e2e')
      : join(root, '.local', 'share', 'com.neatech.veslo.e2e');
    const state = JSON.parse(readFileSync(join(stateDirectory, 'veslo-workspaces.json'), 'utf8')) as {
      activeId: string;
      workspaces: Array<{ id: string; workspaceType?: string; remoteType?: string; baseUrl?: string | null }>;
    };
    assert.equal(state.activeId, 'e2e-session-runtime-decoy');
    assert.deepEqual(state.workspaces.at(-1), {
      id: 'e2e-session-runtime-decoy',
      name: 'E2E activation decoy',
      path: join(root, 'workspaces', 'visual-workspace'),
      preset: 'remote',
      workspaceType: 'remote',
      remoteType: 'opencode',
      baseUrl: 'http://127.0.0.1:9/e2e-activation-decoy',
      directory: join(root, 'workspaces', 'visual-workspace'),
      displayName: 'E2E activation decoy',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('seedDefaultWorkspaceState can seed legacy manifestless Soul runtime files', () => {
  const root = mkdtempSync(join(tmpdir(), 'veslo-e2e-home-'));
  try {
    seedDefaultWorkspaceState(root, {
      E2E_SEED_LEGACY_SOUL_RUNTIME: '1',
    });

    const workspacePath = join(root, 'workspaces', 'visual-workspace');
    assert.equal(
      readFileSync(join(workspacePath, '.opencode', 'soul-company.md'), 'utf8'),
      '# Organization Soul\n\n- Existing organization memory\n',
    );
    assert.equal(
      readFileSync(join(workspacePath, '.opencode', 'soul-user.md'), 'utf8'),
      '# User Soul\n',
    );
    assert.equal(
      readFileSync(join(workspacePath, '.opencode', 'soul-workspace.md'), 'utf8'),
      '',
    );
    assert.equal(existsSync(join(workspacePath, '.opencode', 'veslo', 'soul-manifest.json')), false);
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
