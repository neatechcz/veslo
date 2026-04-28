import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const helperDir = dirname(fileURLToPath(import.meta.url));
const desktopTauriRoot = resolve(helperDir, '..', '..', 'desktop', 'src-tauri');

test('desktop HTTP plugin does not enable persistent cookies during E2E startup', () => {
  const featureTree = execFileSync('cargo', ['tree', '-e', 'features', '-i', 'tauri-plugin-http'], {
    cwd: desktopTauriRoot,
    encoding: 'utf8',
  });

  assert.match(featureTree, /tauri-plugin-http v/);
  assert.doesNotMatch(featureTree, /tauri-plugin-http feature "cookies"/);
});
