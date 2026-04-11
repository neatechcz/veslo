import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppLaunchEnv } from './app-launcher.js';

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
  assert.equal(env.VESLO_DEN_AUTH_SNAPSHOT_PATH, '/tmp/opencode-home/.veslo/den-auth.json');
  assert.equal(env.GDK_BACKEND, 'x11');
  assert.equal('WAYLAND_DISPLAY' in env, false);
});
