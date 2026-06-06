import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  buildPilotCommand,
  defaultPilotScenarios,
  pilotReadinessProbeCommands,
  resolvePilotBinary,
  resolvePilotScenarioSelection,
  scenarioSelectionNeedsSkillRegistryAuthFixture,
  scenarioSelectionNeedsAutomationSecondaryWorkspace,
} from './pilot-runner.js';

test('resolvePilotBinary defaults to tauri-pilot and supports local overrides', () => {
  assert.equal(resolvePilotBinary({}), 'tauri-pilot');
  assert.equal(resolvePilotBinary({ E2E_TAURI_PILOT_BIN: '/tmp/tauri-pilot' }), '/tmp/tauri-pilot');
});

test('buildPilotCommand passes the deterministic socket before pilot subcommands', () => {
  assert.deepEqual(
    buildPilotCommand({
      binary: 'tauri-pilot',
      socket: '/tmp/veslo.sock',
      args: ['run', './pilot-scenarios/smoke.toml'],
    }),
    {
      command: 'tauri-pilot',
      args: ['--socket', '/tmp/veslo.sock', 'run', './pilot-scenarios/smoke.toml'],
    },
  );
});

test('defaultPilotScenarios contains the two migrated desktop checks', () => {
  assert.deepEqual(
    defaultPilotScenarios('/repo/packages/e2e').map((scenario) => scenario.replaceAll('\\', '/')),
    [
      '/repo/packages/e2e/pilot-scenarios/smoke.toml',
      '/repo/packages/e2e/pilot-scenarios/navigation.toml',
    ],
  );
});

test('pilotReadinessProbeCommands waits for both socket and webview readiness', () => {
  assert.deepEqual(pilotReadinessProbeCommands(), [['ping'], ['state']]);
});

test('resolvePilotScenarioSelection supports focused scenario names without re-enabling legacy WDIO specs', () => {
  const e2eRoot = '/repo/packages/e2e';

  assert.deepEqual(
    resolvePilotScenarioSelection({ scenario: ['smoke'] }, e2eRoot).map((scenario) => scenario.replaceAll('\\', '/')),
    [join(e2eRoot, 'pilot-scenarios', 'smoke.toml').replaceAll('\\', '/')],
  );
});

test('automation pilot scenario requests the secondary workspace fixture', () => {
  const e2eRoot = '/repo/packages/e2e';

  assert.equal(
    scenarioSelectionNeedsAutomationSecondaryWorkspace(resolvePilotScenarioSelection({ scenario: ['automations'] }, e2eRoot)),
    true,
  );
  assert.equal(
    scenarioSelectionNeedsAutomationSecondaryWorkspace(resolvePilotScenarioSelection({ scenario: ['smoke'] }, e2eRoot)),
    false,
  );
});

test('soul dashboard pilot scenario requests skill registry Den auth fixture', () => {
  const e2eRoot = '/repo/packages/e2e';

  assert.equal(
    scenarioSelectionNeedsSkillRegistryAuthFixture(resolvePilotScenarioSelection({ scenario: ['soul-dashboard'] }, e2eRoot)),
    true,
  );
  assert.equal(
    scenarioSelectionNeedsSkillRegistryAuthFixture(resolvePilotScenarioSelection({ scenario: ['navigation'] }, e2eRoot)),
    false,
  );
});
