import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pilotScenarioSuiteNames } from './pilot-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..', '..');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8')) as T;
}

test('root e2e scripts route through Tauri Pilot instead of WDIO', () => {
  const packageJson = readJson<{ scripts: Record<string, string> }>('package.json');

  assert.equal(packageJson.scripts['test:e2e:ui'], 'pnpm --filter @neatech/veslo-e2e test');
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    if (!name.startsWith('test:e2e')) continue;
    assert.doesNotMatch(command, /\bwdio\b|webdriverio|WebDriverIO/i, `${name} still references WDIO`);
  }
});

test('e2e package exposes only Tauri Pilot and Playwright scripts', () => {
  const packageJson = readJson<{
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
  }>('packages/e2e/package.json');

  assert.equal(packageJson.scripts.test, 'node --import=tsx/esm ./helpers/pilot-runner.ts --suite current-gate');
  assert.equal(
    packageJson.scripts['test:pilot:visual-regression'],
    'node --import=tsx/esm ./helpers/pilot-runner.ts --scenario visual-regression',
  );
  assert.equal(
    packageJson.scripts['test:pilot:session-render-stability'],
    'node --import=tsx/esm ./helpers/pilot-runner.ts --scenario session-render-stability',
  );
  assert.equal(
    packageJson.scripts['test:pilot:session-run-truthfulness'],
    'node --import=tsx/esm ./helpers/pilot-runner.ts --scenario session-run-truthfulness',
  );
  assert.equal(
    packageJson.scripts['test:pilot:feedback-youtrack-live'],
    'node --import=tsx/esm ./helpers/pilot-runner.ts --scenario feedback-youtrack-live',
  );

  for (const [name, command] of Object.entries(packageJson.scripts)) {
    assert.doesNotMatch(command, /\bwdio\b|webdriverio|WebDriverIO/i, `${name} still references WDIO`);
  }
  for (const dependencyName of Object.keys(packageJson.devDependencies)) {
    assert.doesNotMatch(dependencyName, /^@wdio\b|^webdriverio$/, `${dependencyName} should not remain installed`);
  }
});

test('e2e TypeScript config no longer loads WDIO globals', () => {
  const tsconfig = readJson<{ compilerOptions?: { types?: string[] }; include?: string[] }>('packages/e2e/tsconfig.json');

  assert.deepEqual(tsconfig.compilerOptions?.types, ['node']);
  assert.equal(tsconfig.include?.includes('wdio.conf.ts'), false);
  assert.equal(tsconfig.include?.includes('global.d.ts'), false);
});

test('WDIO config and visual-service globals are removed from the test package', () => {
  assert.equal(existsSync(resolve(repoRoot, 'packages/e2e/wdio.conf.ts')), false);
  assert.equal(existsSync(resolve(repoRoot, 'packages/e2e/global.d.ts')), false);
});

test('current-gate suite entries all have Pilot TOML scenarios', () => {
  for (const scenarioName of pilotScenarioSuiteNames('current-gate')) {
    assert.equal(
      existsSync(resolve(repoRoot, 'packages/e2e/pilot-scenarios', `${scenarioName}.toml`)),
      true,
      `${scenarioName} is missing a Pilot scenario`,
    );
  }
});

test('legacy WDIO spec files are removed from specs', () => {
  const specsRoot = resolve(repoRoot, 'packages/e2e/specs');
  const legacySpecs = readdirSync(specsRoot)
    .filter((name) =>
      (name.endsWith('.spec.ts') && !name.endsWith('.playwright.spec.ts')) ||
      name.endsWith('.e2e.ts'),
    )
    .sort();

  assert.deepEqual(legacySpecs, []);
});
