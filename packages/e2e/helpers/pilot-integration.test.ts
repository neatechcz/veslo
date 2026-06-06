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
  assert.match(cargoToml, /tauri-plugin-pilot = \{ version = "0\.7\.1", default-features = false \}/);
  assert.doesNotMatch(cargoToml, /tauri-plugin-webdriver/);
});

test('desktop registers the pilot plugin behind the debug e2e gate', () => {
  const libRs = readRepoFile('packages/desktop/src-tauri/src/lib.rs');

  assert.match(libRs, /#\[cfg\(all\(debug_assertions, feature = "e2e"\)\)\]\s*let builder = builder\.plugin\(tauri_plugin_pilot::init\(\)\);/s);
  assert.doesNotMatch(libRs, /tauri_plugin_webdriver::init/);
});

test('default Tauri capabilities grant pilot callbacks for e2e builds', () => {
  const capabilities = JSON.parse(readRepoFile('packages/desktop/src-tauri/capabilities/default.json')) as {
    permissions: unknown[];
  };

  assert.equal(capabilities.permissions.includes('pilot:default'), true);
  assert.equal(capabilities.permissions.includes('webdriver:default'), false);
});
