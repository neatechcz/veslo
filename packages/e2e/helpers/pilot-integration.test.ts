import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..', '..');

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

test('desktop e2e feature uses tauri-pilot instead of WebDriver', () => {
  const cargoToml = readRepoFile('packages/desktop/src-tauri/Cargo.toml');

  assert.match(cargoToml, /e2e = \["tauri-plugin-pilot\/press"\]/);
  assert.match(
    cargoToml,
    /tauri-plugin-pilot = \{ git = "https:\/\/github\.com\/mpiton\/tauri-pilot", rev = "a6c5baa3f280fe75e75220be8e7689785a200d13", default-features = false \}/,
  );
  assert.doesNotMatch(cargoToml, /tauri-plugin-webdriver/);
});

test('desktop registers the pilot plugin behind the debug e2e gate', () => {
  const libRs = readRepoFile('packages/desktop/src-tauri/src/lib.rs');
  const registrations = libRs.match(/let builder = builder\.plugin\(tauri_plugin_pilot::init\(\)\);/g) ?? [];

  assert.equal(registrations.length, 1);
  assert.match(libRs, /#\[cfg\(all\(debug_assertions, feature = "e2e"\)\)\]\s*let builder = builder\.plugin\(tauri_plugin_pilot::init\(\)\);/s);
  assert.doesNotMatch(libRs, /tauri_plugin_webdriver::init/);
});

test('e2e package exposes runnable tauri-pilot scripts used by root commands', () => {
  const packageJson = JSON.parse(readRepoFile('packages/e2e/package.json')) as {
    scripts: Record<string, string>;
  };

  assert.equal(packageJson.scripts['test:pilot'], 'node --import=tsx/esm ./helpers/pilot-runner.ts');
  assert.equal(
    packageJson.scripts['test:pilot:core-platform-skills'],
    'node --import=tsx/esm ./specs/core-platform-skills.pilot.ts',
  );
  assert.equal(packageJson.scripts['test:pilot:smoke'], 'node --import=tsx/esm ./helpers/pilot-runner.ts --scenario smoke');
  assert.equal(
    packageJson.scripts['test:pilot:navigation'],
    'node --import=tsx/esm ./helpers/pilot-runner.ts --scenario navigation',
  );
  assert.equal(
    packageJson.scripts['test:pilot:soul-dashboard'],
    'node --import=tsx/esm ./helpers/pilot-runner.ts --scenario soul-dashboard',
  );
});

test('e2e Tauri config grants pilot callbacks without enabling them in default capabilities', () => {
  const defaultCapabilities = JSON.parse(readRepoFile('packages/desktop/src-tauri/capabilities/default.json')) as {
    permissions: unknown[];
  };
  const e2eConfig = JSON.parse(readRepoFile('packages/desktop/src-tauri/tauri.e2e.conf.json')) as {
    app?: { security?: { capabilities?: unknown[] } };
  };
  const e2eCapabilities = e2eConfig.app?.security?.capabilities ?? [];
  const pilotCapability = e2eCapabilities.find(
    (entry): entry is { permissions?: unknown[] } =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      Array.isArray((entry as { permissions?: unknown[] }).permissions) &&
      (entry as { permissions?: unknown[] }).permissions?.includes('pilot:default') === true,
  );

  assert.equal(defaultCapabilities.permissions.includes('pilot:default'), false);
  assert.equal(defaultCapabilities.permissions.includes('webdriver:default'), false);
  assert.ok(pilotCapability, 'Expected tauri.e2e.conf.json to grant pilot:default only for E2E builds.');
});
