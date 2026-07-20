import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePnpmInvocation } from './build-e2e-desktop.mjs';

const __filename = fileURLToPath(import.meta.url);
const scriptPath = resolve(dirname(__filename), 'build-e2e-desktop.mjs');

test('fresh E2E desktop build dry-run prepares server, sidecars, then the E2E Tauri binary', () => {
  const output = execFileSync(process.execPath, [scriptPath, '--dry-run'], {
    encoding: 'utf8',
  });

  const server = output.indexOf('pnpm --filter veslo-server build:bin');
  const sidecars = output.indexOf('VESLO_SIDECAR_FORCE_BUILD=1 pnpm --filter @neatech/veslo run prepare:sidecar');
  const desktop = output.indexOf('pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e');

  assert.ok(server >= 0);
  assert.ok(sidecars > server);
  assert.ok(desktop > sidecars);
});

test('fresh E2E desktop build invokes pnpm through cmd.exe on Windows without shell mode', () => {
  assert.deepEqual(
    resolvePnpmInvocation('win32', 'C:\\Windows\\System32\\cmd.exe'),
    { command: 'C:\\Windows\\System32\\cmd.exe', viaCmd: true },
  );
  assert.deepEqual(resolvePnpmInvocation('linux'), { command: 'pnpm', viaCmd: false });
});
