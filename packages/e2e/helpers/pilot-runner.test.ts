import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  applyPilotScenarioFixtureEnv,
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

test('sharepoint mcp pilot scenario applies the sharepoint fixture env without enabling google', () => {
  const e2eRoot = '/repo/packages/e2e';
  const env: NodeJS.ProcessEnv = {};

  applyPilotScenarioFixtureEnv(resolvePilotScenarioSelection({ scenario: ['sharepoint-mcp-connectors'] }, e2eRoot), env);

  assert.equal(env.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE, '1');
  assert.equal(env.E2E_SKILL_REGISTRY_FIXTURE, '1');
  assert.equal(env.E2E_SKILL_REGISTRY_AUTH_BASE, 'fixture');
  assert.equal(env.E2E_GOOGLE_MCP_CATALOG_FIXTURE, undefined);
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
