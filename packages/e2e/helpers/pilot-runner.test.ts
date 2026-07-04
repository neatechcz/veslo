import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertPilotScenarioSelectionIsolated,
  buildPilotCommand,
  buildPilotDenAuthSeedScript,
  defaultPilotScenarios,
  pilotReadinessProbeCommands,
  resolvePilotBinary,
  resolvePilotDenAuthJson,
  resolvePilotScenarioSelection,
  scenarioSelectionNeedsSkillEnableInventoryFixture,
  scenarioSelectionNeedsGoogleMcpCatalogFixture,
  scenarioSelectionNeedsSharePointMcpCatalogFixture,
  scenarioSelectionNeedsManagedAiGatewayFixture,
  scenarioSelectionNeedsModelStreamRetryFixture,
  scenarioSelectionDisablesDevAutostart,
  scenarioSelectionNeedsRelaunchReconnectCheck,
  scenarioSelectionNeedsNoWorkspaceProfile,
  scenarioSelectionNeedsPortContentionFixture,
  scenarioSelectionNeedsSkillRegistryAuthFixture,
  scenarioSelectionNeedsSkillRegistryWorkspaceEventFixture,
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

test('resolvePilotDenAuthJson prefers the Veslo-prefixed auth seed', () => {
  assert.equal(resolvePilotDenAuthJson({}), null);
  assert.equal(
    resolvePilotDenAuthJson({
      E2E_DEN_AUTH_JSON: '{"token":"fallback"}',
      VESLO_E2E_DEN_AUTH_JSON: '{"token":"preferred"}',
    }),
    '{"token":"preferred"}',
  );
});

test('buildPilotDenAuthSeedScript writes browser and desktop auth state', () => {
  const script = buildPilotDenAuthSeedScript('{"denApiBase":"http://127.0.0.1:8788","token":"token"}');

  assert.match(script, /window\.localStorage\.setItem\("veslo\.den\.auth", authJson\)/);
  assert.match(script, /den_auth_snapshot_write/);
  assert.match(script, /window\.location\.reload\(\)/);
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

test('google mcp pilot scenario requests the google mcp catalog fixture', () => {
  const e2eRoot = '/repo/packages/e2e';

  assert.equal(
    scenarioSelectionNeedsGoogleMcpCatalogFixture(resolvePilotScenarioSelection({ scenario: ['google-mcp-connectors'] }, e2eRoot)),
    true,
  );
  assert.equal(
    scenarioSelectionNeedsGoogleMcpCatalogFixture(resolvePilotScenarioSelection({ scenario: ['navigation'] }, e2eRoot)),
    false,
  );
});

test('sharepoint mcp pilot scenario requests the sharepoint mcp catalog fixture', () => {
  const e2eRoot = '/repo/packages/e2e';

  assert.equal(
    scenarioSelectionNeedsSharePointMcpCatalogFixture(
      resolvePilotScenarioSelection({ scenario: ['sharepoint-mcp-connectors'] }, e2eRoot),
    ),
    true,
  );
  assert.equal(
    scenarioSelectionNeedsSharePointMcpCatalogFixture(resolvePilotScenarioSelection({ scenario: ['google-mcp-connectors'] }, e2eRoot)),
    false,
  );
  assert.equal(
    scenarioSelectionNeedsGoogleMcpCatalogFixture(resolvePilotScenarioSelection({ scenario: ['sharepoint-mcp-connectors'] }, e2eRoot)),
    false,
  );
});

test('sharepoint mcp pilot scenario wires the sharepoint fixture env', () => {
  const source = readFileSync(new URL('./pilot-runner.ts', import.meta.url), 'utf8');

  assert.match(source, /scenarioSelectionNeedsSharePointMcpCatalogFixture\(scenarios\)/);
  assert.match(source, /process\.env\.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE\s*\|\|=\s*'1'/);
  assert.match(source, /process\.env\.E2E_SKILL_REGISTRY_FIXTURE\s*\|\|=\s*'1'/);
  assert.match(source, /process\.env\.E2E_SKILL_REGISTRY_AUTH_BASE\s*\|\|=\s*'fixture'/);
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

test('sidebar session retention pilot scenario requests the managed AI fixture', () => {
  const e2eRoot = '/repo/packages/e2e';

  assert.equal(
    scenarioSelectionNeedsManagedAiGatewayFixture(
      resolvePilotScenarioSelection({ scenario: ['sidebar-session-retention'] }, e2eRoot),
    ),
    true,
  );
});

test('global unpublished draft pilot scenario requests the managed AI fixture', () => {
  const e2eRoot = '/repo/packages/e2e';

  assert.equal(
    scenarioSelectionNeedsManagedAiGatewayFixture(
      resolvePilotScenarioSelection({ scenario: ['global-unpublished-draft'] }, e2eRoot),
    ),
    true,
  );
});

test('model stream retry pilot scenario requests managed AI and retry fixtures', () => {
  const e2eRoot = '/repo/packages/e2e';
  const scenarios = resolvePilotScenarioSelection({ scenario: ['model-stream-retry-no-progress'] }, e2eRoot);

  assert.equal(scenarioSelectionNeedsManagedAiGatewayFixture(scenarios), true);
  assert.equal(scenarioSelectionNeedsModelStreamRetryFixture(scenarios), true);
  assert.equal(
    scenarioSelectionNeedsModelStreamRetryFixture(resolvePilotScenarioSelection({ scenario: ['smoke'] }, e2eRoot)),
    false,
  );
});

test('VSLO-270 stop reload reconnect pilot scenario requests managed AI and retry fixtures', () => {
  const e2eRoot = '/repo/packages/e2e';
  const scenarios = resolvePilotScenarioSelection({ scenario: ['vslo-270-stop-reload-reconnect'] }, e2eRoot);

  assert.equal(scenarioSelectionNeedsManagedAiGatewayFixture(scenarios), true);
  assert.equal(scenarioSelectionNeedsModelStreamRetryFixture(scenarios), true);
  assert.equal(scenarioSelectionDisablesDevAutostart(scenarios), true);
  assert.equal(scenarioSelectionNeedsSkillRegistryWorkspaceEventFixture(scenarios), true);
  assert.equal(scenarioSelectionNeedsRelaunchReconnectCheck(scenarios), true);
});

test('runtime cold-start handoff pilot scenario requests the managed AI fixture', () => {
  const e2eRoot = '/repo/packages/e2e';

  assert.equal(
    scenarioSelectionNeedsManagedAiGatewayFixture(
      resolvePilotScenarioSelection({ scenario: ['runtime-cold-start-session-handoff'] }, e2eRoot),
    ),
    true,
  );
});

test('runtime cold-start handoff pilot scenario disables debug dev autostart', () => {
  const e2eRoot = '/repo/packages/e2e';

  assert.equal(
    scenarioSelectionDisablesDevAutostart(
      resolvePilotScenarioSelection({ scenario: ['runtime-cold-start-session-handoff'] }, e2eRoot),
    ),
    true,
  );
  assert.equal(
    scenarioSelectionDisablesDevAutostart(resolvePilotScenarioSelection({ scenario: ['smoke'] }, e2eRoot)),
    false,
  );
});

test('model stream retry pilot scenario is focused-only because it enables a global probe fixture', () => {
  const e2eRoot = '/repo/packages/e2e';
  const isolated = resolvePilotScenarioSelection({ scenario: ['model-stream-retry-no-progress'] }, e2eRoot);
  const mixed = resolvePilotScenarioSelection({ scenario: ['smoke', 'model-stream-retry-no-progress'] }, e2eRoot);

  assert.doesNotThrow(() => assertPilotScenarioSelectionIsolated(isolated));
  assert.throws(
    () => assertPilotScenarioSelectionIsolated(mixed),
    /model-stream-retry-no-progress must run as a focused pilot scenario/,
  );
});

test('model stream retry pilot fixture widens provider-start watchdog for debug desktop cold starts', () => {
  const source = readFileSync(new URL('./pilot-runner.ts', import.meta.url), 'utf8');

  assert.match(source, /VESLO_AI_GATEWAY_PROVIDER_START_TIMEOUT_MS/);
  assert.match(source, /process\.env\.VESLO_AI_GATEWAY_PROVIDER_START_TIMEOUT_MS\s*\|\|=\s*'90000'/);
});

test('VSLO-235 local host scenario requests a no-workspace desktop profile', () => {
  const e2eRoot = '/repo/packages/e2e';

  assert.equal(
    scenarioSelectionNeedsNoWorkspaceProfile(
      resolvePilotScenarioSelection({ scenario: ['vslo-235-local-host-no-workspace'] }, e2eRoot),
    ),
    true,
  );
  assert.equal(
    scenarioSelectionNeedsNoWorkspaceProfile(resolvePilotScenarioSelection({ scenario: ['smoke'] }, e2eRoot)),
    false,
  );
});

test('VSLO-235 port contention scenario requests a held local server port', () => {
  const e2eRoot = '/repo/packages/e2e';

  assert.equal(
    scenarioSelectionNeedsPortContentionFixture(
      resolvePilotScenarioSelection({ scenario: ['vslo-235-local-host-port-contention'] }, e2eRoot),
    ),
    true,
  );
  assert.equal(
    scenarioSelectionNeedsPortContentionFixture(resolvePilotScenarioSelection({ scenario: ['smoke'] }, e2eRoot)),
    false,
  );
});
