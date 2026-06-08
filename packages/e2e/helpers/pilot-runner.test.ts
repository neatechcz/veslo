import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildPilotCommand,
  defaultPilotScenarios,
  pilotReadinessProbeCommands,
  resolvePilotBinary,
  resolvePilotScenarioSelection,
  scenarioSelectionNeedsSkillEnableInventoryFixture,
  scenarioSelectionNeedsManagedAiGatewayFixture,
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

test('automation pilot scenario cache-busts volatile server polling', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'pilot-scenarios', 'automations.toml'), 'utf8');

  assert.match(source, /const freshServerPath = \(path\) =>/);
  assert.match(source, /fetchJson\(connection, freshServerPath\(`/);
});

test('automation pilot scenario reuses restart-returned Veslo server connection', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'pilot-scenarios', 'automations.toml'), 'utf8');

  assert.match(source, /const restartInfo = await tauriInvoke\("veslo_server_restart"\);/);
  assert.match(source, /const restarted = connectionFromServerInfo\(restartInfo\);/);
});

test('automation pilot scenario re-resolves server workspaces by directory after restart', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'pilot-scenarios', 'automations.toml'), 'utf8');

  assert.match(source, /const findServerWorkspaceByDirectory = async \(connection, directory\) =>/);
  assert.match(source, /const runtimeActiveServerWorkspace = await waitForServerWorkspaceByDirectory\(runtimeConnection, activeDirectory\);/);
  assert.match(source, /waitForCompletedAutomation\(async \(\) => await ensureVesloServerConnection\(\), activeDirectory, dueAutomation\.workspaceId, dueAutomation\.id\);/);
});

test('composer draft move pilot scenario uses a pointer click sequence for menu selection', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'pilot-scenarios', 'composer-draft-workspace-move.toml'), 'utf8');

  assert.match(source, /const dispatchClickSequence = \(element\) =>/);
  assert.match(source, /dispatchClickSequence\(picker\);/);
  assert.match(source, /dispatchClickSequence\(option\);/);
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

test('skills enabled-state pilot scenario requests the skill inventory fixture', () => {
  const e2eRoot = '/repo/packages/e2e';

  assert.equal(
    scenarioSelectionNeedsSkillEnableInventoryFixture(resolvePilotScenarioSelection({ scenario: ['skills-enabled-state'] }, e2eRoot)),
    true,
  );
  assert.equal(
    scenarioSelectionNeedsSkillEnableInventoryFixture(resolvePilotScenarioSelection({ scenario: ['navigation'] }, e2eRoot)),
    false,
  );
});

test('message send degraded registry pilot scenario requests the managed AI fixture', () => {
  const e2eRoot = '/repo/packages/e2e';

  assert.equal(
    scenarioSelectionNeedsManagedAiGatewayFixture(
      resolvePilotScenarioSelection({ scenario: ['message-send-registry-degraded'] }, e2eRoot),
    ),
    true,
  );
  assert.equal(
    scenarioSelectionNeedsManagedAiGatewayFixture(resolvePilotScenarioSelection({ scenario: ['smoke'] }, e2eRoot)),
    false,
  );
});

test('message send degraded registry pilot allows cold OpenCode managed-AI startup', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'pilot-scenarios', 'message-send-registry-degraded.toml'), 'utf8');

  assert.match(source, /global_timeout_ms = 500000/);
  assert.match(source, /}, \{\n  timeout: 300000,\n  interval: 1000,\n  message: `Managed AI fixture response did not render/);
  assert.match(source, /timeout_ms = 470000/);
});

test('multi-workspace sessions pilot retries transient local server transport failures', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'pilot-scenarios', 'multi-workspace-sessions.toml'), 'utf8');

  assert.match(source, /const isRetryableServerTransportError = \(error\) =>/);
  assert.match(source, /for \(let attempt = 0; attempt < 8; attempt \+= 1\)/);
  assert.match(source, /await sleep\(250 \* \(attempt \+ 1\)\);/);
});

test('sidebar session retention pilot scenario requests the managed AI fixture', () => {
  const e2eRoot = '/repo/packages/e2e';

  assert.equal(
    scenarioSelectionNeedsManagedAiGatewayFixture(
      resolvePilotScenarioSelection({ scenario: ['sidebar-session-retention'] }, e2eRoot),
    ),
    true,
  );
});

test('pending session instance isolation pilot scenario requests the managed AI fixture', () => {
  const e2eRoot = '/repo/packages/e2e';

  assert.equal(
    scenarioSelectionNeedsManagedAiGatewayFixture(
      resolvePilotScenarioSelection({ scenario: ['pending-session-instance-isolation'] }, e2eRoot),
    ),
    true,
  );
});

test('pending session instance isolation pilot covers required helpers and variants', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'pilot-scenarios', 'pending-session-instance-isolation.toml'), 'utf8');

  for (const helperName of [
    'waitUntil',
    'waitForComposer',
    'setComposerText',
    'sendComposerText',
    'visibleBodyText',
    'assertTextVisible',
    'assertTextNotVisible',
    'clickSidebarRowByText',
  ]) {
    assert.match(source, new RegExp(`const ${helperName} =`));
  }

  assert.match(source, /window\.__TAURI_INTERNALS__\?\.invoke/);
  assert.match(source, /tauriInvoke\("workspace_bootstrap"\)/);
  assert.match(source, /tauriInvoke\("veslo_server_info"\)/);
  assert.match(source, /"x-veslo-gateway-authorization": "Bearer veslo-e2e-managed-ai-token"/);
  assert.match(source, /pending isolation chat A \$\{timestamp\}/);
  assert.match(source, /pending isolation chat B \$\{timestamp\}/);
  assert.match(source, /pending isolation chat project \$\{timestamp\}/);
  assert.match(source, /pending isolation same project A \$\{timestamp\}/);
  assert.match(source, /pending isolation same project B \$\{timestamp\}/);
  assert.match(source, /waitForChatSidebarRow\(messages\.chatA\)/);
  assert.match(source, /waitForProjectSidebarRow\(messages\.sameProjectA\)/);
  assert.match(source, /sameProjectAKey === projectKey/);
  assert.match(source, /assertTextNotVisible\(messages\.sameProjectB/);
});
