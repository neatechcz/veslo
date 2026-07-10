import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertLiveManagedAiAuthForScenarioSelection,
  assertPilotScenarioSelectionIsolated,
  buildPilotCommand,
  buildPilotDenAuthSeedScript,
  defaultPilotScenarios,
  pilotScenarioSuiteNames,
  pilotFailureDiagnosticCommands,
  pilotReadinessProbeCommands,
  resolvePilotBinary,
  resolvePilotDenAuthJson,
  resolvePilotScenarioCommandTimeoutMs,
  resolvePilotScenarioSelection,
  sanitizePilotArtifactName,
  scenarioSelectionNeedsSkillEnableInventoryFixture,
  scenarioSelectionNeedsGoogleMcpCatalogFixture,
  scenarioSelectionNeedsSharePointMcpCatalogFixture,
  scenarioSelectionNeedsManagedAiGatewayFixture,
  scenarioSelectionNeedsModelStreamRetryFixture,
  scenarioSelectionDisablesDevAutostart,
  scenarioSelectionNeedsRelaunchReconnectCheck,
  scenarioSelectionNeedsSessionQueueRuntimeFixture,
  assertSessionQueueRuntimeFixtureProfileIsolation,
  scenarioSelectionNeedsNoWorkspaceProfile,
  scenarioSelectionNeedsPortContentionFixture,
  scenarioSelectionRequiresLiveManagedAiAuth,
  scenarioSelectionNeedsSkillRegistryAuthFixture,
  scenarioSelectionNeedsLegacySoulRuntime,
  scenarioSelectionNeedsSkillRegistryWorkspaceEventFixture,
  scenarioSelectionNeedsAutomationSecondaryWorkspace,
} from './pilot-runner.js';

const MANAGED_AI_INFERENCE_SCENARIOS = [
  'global-unpublished-draft',
  'message-send-registry-degraded',
  'model-stream-retry-no-progress',
  'pending-session-instance-isolation',
  'runtime-cold-start-session-handoff',
  'sidebar-session-retention',
  'startup-sidebar-existing-sessions',
  'vslo-270-stop-reload-reconnect',
  'vslo-271-windows-idle-runtime-chain-recovery',
] as const;

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

test('resolvePilotScenarioCommandTimeoutMs bounds tauri-pilot scenario runs while allowing live overrides', () => {
  assert.equal(resolvePilotScenarioCommandTimeoutMs({}), 1_200_000);
  assert.equal(resolvePilotScenarioCommandTimeoutMs({ E2E_PILOT_SCENARIO_TIMEOUT_MS: '900000' }), 900_000);
  assert.throws(
    () => resolvePilotScenarioCommandTimeoutMs({ E2E_PILOT_SCENARIO_TIMEOUT_MS: '999' }),
    /Invalid E2E_PILOT_SCENARIO_TIMEOUT_MS/,
  );
});

test('runPilotScenarios passes an explicit timeout to tauri-pilot run commands', () => {
  const source = readFileSync(new URL('./pilot-runner.ts', import.meta.url), 'utf8');

  assert.match(source, /const scenarioCommandTimeoutMs = resolvePilotScenarioCommandTimeoutMs\(\)/);
  assert.match(source, /args: \['run', scenario\],[\s\S]*timeoutMs: scenarioCommandTimeoutMs/);
  assert.match(source, /args: \['run', reconnectScenario\],[\s\S]*timeoutMs: scenarioCommandTimeoutMs/);
});

test('sanitizePilotArtifactName creates stable filesystem-safe scenario names', () => {
  assert.equal(
    sanitizePilotArtifactName('C:\\repo\\packages\\e2e\\pilot-scenarios\\message-send-registry-degraded.toml'),
    'message-send-registry-degraded',
  );
  assert.equal(sanitizePilotArtifactName('../bad scenario:name.toml'), 'bad-scenario-name');
  assert.equal(sanitizePilotArtifactName('.tmp-pilot-diagnostics-fail.toml'), 'tmp-pilot-diagnostics-fail');
});

test('pilot failure diagnostics include high-signal app state probes', () => {
  const commands = pilotFailureDiagnosticCommands('/tmp/diag');
  const names = commands.map((command) => command.name);

  assert.deepEqual(names, [
    'state',
    'windows',
    'snapshot',
    'snapshot-json',
    'logs',
    'network',
    'network-failed',
    'storage-local',
    'storage-session',
    'forms',
    'send-workflow-trace',
    'veslo-server-info',
    'workspace-bootstrap',
    'screenshot',
  ]);
  assert.deepEqual(commands.find((command) => command.name === 'logs')?.args, ['--window', 'main', 'logs', '--last', '200', '--json']);
  assert.deepEqual(commands.find((command) => command.name === 'workspace-bootstrap')?.args, [
    '--window',
    'main',
    'ipc',
    '--json',
    'workspace_bootstrap',
  ]);
  assert.deepEqual(commands.find((command) => command.name === 'send-workflow-trace')?.args, [
    '--window',
    'main',
    'eval',
    '--json',
    '(window.__vesloDumpSendWorkflowTrace?.() ?? window.__vesloSendWorkflowTrace ?? []).slice(-300)',
  ]);
  assert.deepEqual(commands.find((command) => command.name === 'screenshot')?.args, [
    '--window',
    'main',
    'screenshot',
    join('/tmp/diag', 'webview.png'),
  ]);
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

test('current-gate pilot suite enumerates the WDIO replacement scenarios explicitly', () => {
  assert.deepEqual(pilotScenarioSuiteNames('current-gate'), [
    'smoke',
    'navigation',
    'admin-managed-ai-access',
    'attachment-staging',
    'composer',
    'extensions-mcp',
    'feedback-bug-report',
    'markdown-drop-guard',
    'skill-publish-dialog',
    'skills-global-inventory',
    'session-capabilities',
    'session-message-replacement',
    'skill-registry-materialization',
    'shared-workspace-skill-lock',
    'session-artifacts',
    'session-prefetch',
    'session',
    'settings-dashboard-link-tabs',
    'settings-gear-navigation',
    'sidebar-primary-actions-overflow',
    'sidebar-primary-actions-pointer-navigation',
    'typography',
    'veslo-server-startup',
    'visual-regression',
    'language-persistence',
  ]);
});

test('live-inference pilot suite uses production-path managed AI scenarios', () => {
  const e2eRoot = '/repo/packages/e2e';
  const names = pilotScenarioSuiteNames('live-inference');

  assert.deepEqual(names, [
    'runtime-cold-start-session-handoff',
    'message-send-registry-degraded',
  ]);

  const scenarios = resolvePilotScenarioSelection({ suite: 'live-inference' }, e2eRoot);
  assert.equal(scenarioSelectionRequiresLiveManagedAiAuth(scenarios), true);
  assert.equal(scenarioSelectionNeedsManagedAiGatewayFixture(scenarios), false);

  for (const scenarioName of names) {
    const content = readFileSync(new URL(`../pilot-scenarios/${scenarioName}.toml`, import.meta.url), 'utf8');
    assert.doesNotMatch(
      content,
      /tauriInvoke\("(?:engine_start|engine_info|orchestrator_workspace_activate)"/,
      `${scenarioName} must not bypass the production workspace runtime path`,
    );
    assert.match(content, /ai-gateway\/me\/ai-access/, `${scenarioName} must check live AI gateway access`);
    assert.match(
      content,
      /messageRoleCount\("assistant"\)|visibleMessageTexts\("assistant"\)/,
      `${scenarioName} must require a rendered assistant response`,
    );
  }
});

test('resolvePilotScenarioSelection resolves named suites to pilot scenario files', () => {
  const e2eRoot = '/repo/packages/e2e';

  assert.deepEqual(
    resolvePilotScenarioSelection({ suite: 'current-gate' }, e2eRoot).map((scenario) => scenario.replaceAll('\\', '/')),
    pilotScenarioSuiteNames('current-gate')
      .map((name) => join(e2eRoot, 'pilot-scenarios', `${name}.toml`).replaceAll('\\', '/')),
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

test('resolvePilotDenAuthJson reads authJson from the configured live snapshot file', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'veslo-pilot-den-auth-'));
  const snapshotPath = join(tempDir, 'den-auth.json');
  const authJson = JSON.stringify({
    denApiBase: 'https://api.veslo.work',
    token: 'live-token',
    user: { email: 'user@neatech.cz' },
  });

  try {
    writeFileSync(snapshotPath, JSON.stringify({ version: 1, authJson }));
    assert.equal(
      resolvePilotDenAuthJson({ VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE: snapshotPath }),
      authJson,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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

test('soul pilot scenarios request skill registry Den auth fixture', () => {
  const e2eRoot = '/repo/packages/e2e';

  assert.equal(
    scenarioSelectionNeedsSkillRegistryAuthFixture(resolvePilotScenarioSelection({ scenario: ['soul-dashboard'] }, e2eRoot)),
    true,
  );
  assert.equal(
    scenarioSelectionNeedsSkillRegistryAuthFixture(resolvePilotScenarioSelection({ scenario: ['soul-den-local'] }, e2eRoot)),
    true,
  );
  assert.equal(
    scenarioSelectionNeedsSkillRegistryAuthFixture(resolvePilotScenarioSelection({ scenario: ['navigation'] }, e2eRoot)),
    false,
  );
});

test('soul-den-local pilot scenario requests legacy manifestless Soul runtime fixture', () => {
  const e2eRoot = '/repo/packages/e2e';

  assert.equal(
    scenarioSelectionNeedsLegacySoulRuntime(resolvePilotScenarioSelection({ scenario: ['soul-den-local'] }, e2eRoot)),
    true,
  );
  assert.equal(
    scenarioSelectionNeedsLegacySoulRuntime(resolvePilotScenarioSelection({ scenario: ['navigation'] }, e2eRoot)),
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

test('managed AI inference pilot scenarios require live auth and never auto-select the gateway fixture', () => {
  const e2eRoot = '/repo/packages/e2e';

  for (const scenarioName of MANAGED_AI_INFERENCE_SCENARIOS) {
    const scenarios = resolvePilotScenarioSelection({ scenario: [scenarioName] }, e2eRoot);

    assert.equal(scenarioSelectionRequiresLiveManagedAiAuth(scenarios), true, scenarioName);
    assert.equal(scenarioSelectionNeedsManagedAiGatewayFixture(scenarios), false, scenarioName);
  }

  assert.equal(
    scenarioSelectionRequiresLiveManagedAiAuth(resolvePilotScenarioSelection({ scenario: ['smoke'] }, e2eRoot)),
    false,
  );
  assert.equal(
    scenarioSelectionNeedsManagedAiGatewayFixture(resolvePilotScenarioSelection({ scenario: ['smoke'] }, e2eRoot)),
    false,
  );
});

test('model stream retry pilot scenario requests retry fixture and live managed-AI auth', () => {
  const e2eRoot = '/repo/packages/e2e';
  const scenarios = resolvePilotScenarioSelection({ scenario: ['model-stream-retry-no-progress'] }, e2eRoot);

  assert.equal(scenarioSelectionNeedsManagedAiGatewayFixture(scenarios), false);
  assert.equal(scenarioSelectionRequiresLiveManagedAiAuth(scenarios), true);
  assert.equal(scenarioSelectionNeedsModelStreamRetryFixture(scenarios), true);
  assert.equal(
    scenarioSelectionNeedsModelStreamRetryFixture(resolvePilotScenarioSelection({ scenario: ['smoke'] }, e2eRoot)),
    false,
  );
});

test('VSLO-270 stop reload reconnect pilot scenario requests live auth and retry fixtures', () => {
  const e2eRoot = '/repo/packages/e2e';
  const scenarios = resolvePilotScenarioSelection({ scenario: ['vslo-270-stop-reload-reconnect'] }, e2eRoot);

  assert.equal(scenarioSelectionNeedsManagedAiGatewayFixture(scenarios), false);
  assert.equal(scenarioSelectionRequiresLiveManagedAiAuth(scenarios), true);
  assert.equal(scenarioSelectionNeedsModelStreamRetryFixture(scenarios), true);
  assert.equal(scenarioSelectionDisablesDevAutostart(scenarios), true);
  assert.equal(scenarioSelectionNeedsSkillRegistryWorkspaceEventFixture(scenarios), true);
  assert.equal(scenarioSelectionNeedsRelaunchReconnectCheck(scenarios), true);
});

test('runtime cold-start handoff pilot scenario requires live managed-AI auth', () => {
  const e2eRoot = '/repo/packages/e2e';
  const scenarios = resolvePilotScenarioSelection({ scenario: ['runtime-cold-start-session-handoff'] }, e2eRoot);

  assert.equal(scenarioSelectionNeedsManagedAiGatewayFixture(scenarios), false);
  assert.equal(scenarioSelectionRequiresLiveManagedAiAuth(scenarios), true);
});

test('runtime cold-start handoff pilot scenario uses a deterministic live inference prompt', () => {
  const content = readFileSync(
    new URL('../pilot-scenarios/runtime-cold-start-session-handoff.toml', import.meta.url),
    'utf8',
  );

  assert.match(content, /const token = `runtime-handoff-\$\{Date\.now\(\)\}`;/);
  assert.match(content, /Reply with exactly \$\{token\}\. Do not use tools\. No other words\./);
  assert.doesNotMatch(content, /runtime cold start handoff \$\{Date\.now\(\)\}/);
  assert.match(content, /assistantTexts\.some\(\(value\) => value\.includes\(token\)\)/);
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

test('session queue durability uses its isolated deterministic runtime fixture', () => {
  const selected = ['/repo/packages/e2e/pilot-scenarios/session-queue-durability.toml'];
  assert.equal(scenarioSelectionNeedsSessionQueueRuntimeFixture(selected), true);
  assert.throws(
    () => assertPilotScenarioSelectionIsolated([...selected, '/repo/packages/e2e/pilot-scenarios/smoke.toml']),
    /session-queue-durability must run as a focused pilot scenario/,
  );
});

test('session queue durability rejects the shared existing-profile switch', () => {
  const selected = ['/repo/packages/e2e/pilot-scenarios/session-queue-durability.toml'];
  assert.throws(
    () => assertSessionQueueRuntimeFixtureProfileIsolation(selected, { E2E_USE_EXISTING_PROFILE: '1' }),
    /must not use E2E_USE_EXISTING_PROFILE=1/,
  );
  assert.doesNotThrow(() => assertSessionQueueRuntimeFixtureProfileIsolation(selected, {}));
});

test('resolvePilotDenAuthJson reads authJson from the production desktop snapshot path', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'veslo-pilot-den-auth-prod-'));
  const snapshotPath = join(tempDir, 'den-auth.json');
  const authJson = JSON.stringify({
    denApiBase: 'https://api.veslo.work',
    token: 'live-token',
    user: { email: 'user@neatech.cz' },
  });

  try {
    writeFileSync(snapshotPath, JSON.stringify({ version: 1, authJson }));
    assert.equal(
      resolvePilotDenAuthJson({ VESLO_DEN_AUTH_SNAPSHOT_PATH: snapshotPath }),
      authJson,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('managed AI inference pilot scenarios disable debug dev autostart for production-path runtime startup', () => {
  const e2eRoot = '/repo/packages/e2e';

  for (const scenarioName of MANAGED_AI_INFERENCE_SCENARIOS) {
    assert.equal(
      scenarioSelectionDisablesDevAutostart(resolvePilotScenarioSelection({ scenario: [scenarioName] }, e2eRoot)),
      true,
      scenarioName,
    );
  }
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

test('VSLO-271 pilot scenario requires live managed-AI auth and not the fixture', () => {
  const e2eRoot = '/repo/packages/e2e';
  const scenarios = resolvePilotScenarioSelection({ scenario: ['vslo-271-windows-idle-runtime-chain-recovery'] }, e2eRoot);
  const tempDir = mkdtempSync(join(tmpdir(), 'veslo-pilot-live-auth-'));
  const snapshotPath = join(tempDir, 'den-auth.json');
  const writeSnapshot = (email: string) => {
    writeFileSync(snapshotPath, JSON.stringify({
      version: 1,
      authJson: JSON.stringify({
        denApiBase: 'https://api.veslo.work',
        token: 'live-token',
        orgId: 'org-live',
        user: { id: 'user-live', email },
        org: { id: 'org-live' },
      }),
      keepSignedIn: true,
      onboardingComplete: true,
    }));
  };

  try {
    assert.equal(scenarioSelectionRequiresLiveManagedAiAuth(scenarios), true);
    assert.equal(scenarioSelectionNeedsManagedAiGatewayFixture(scenarios), false);
    assert.throws(
      () => assertLiveManagedAiAuthForScenarioSelection(scenarios, { E2E_MANAGED_AI_GATEWAY_FIXTURE: '0' }),
      /VESLO_DEN_AUTH_SNAPSHOT_PATH/,
    );

    writeSnapshot('veslo-e2e@example.test');
    assert.throws(
      () => assertLiveManagedAiAuthForScenarioSelection(scenarios, {
        VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE: snapshotPath,
        E2E_MANAGED_AI_GATEWAY_FIXTURE: '0',
      }),
      /real Den user auth seed/,
    );

    writeSnapshot('david.kral@neatech.cz');
    assert.throws(
      () => assertLiveManagedAiAuthForScenarioSelection(scenarios, {
        VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE: snapshotPath,
        E2E_MANAGED_AI_GATEWAY_FIXTURE: '1',
      }),
      /live managed-AI path/,
    );
    assert.throws(
      () => assertLiveManagedAiAuthForScenarioSelection(scenarios, {
        VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE: snapshotPath,
        E2E_MANAGED_AI_GATEWAY_FIXTURE: '0',
        VESLO_AI_GATEWAY_BASE_URL: 'http://127.0.0.1:8788',
      }),
      /live managed-AI gateway/,
    );
    assert.throws(
      () => assertLiveManagedAiAuthForScenarioSelection(scenarios, {
        VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE: snapshotPath,
        E2E_MANAGED_AI_GATEWAY_FIXTURE: '0',
        VESLO_AI_GATEWAY_BASE_URL: 'http://[::1]:8788',
      }),
      /live managed-AI gateway/,
    );
    assert.throws(
      () => assertLiveManagedAiAuthForScenarioSelection(scenarios, {
        VESLO_E2E_DEN_AUTH_JSON: JSON.stringify({
          denApiBase: 'https://api.veslo.work',
          token: 'veslo-e2e-managed-ai-token',
          user: { email: 'user@neatech.cz' },
        }),
      }),
      /E2E fixture token/,
    );
    assert.doesNotThrow(() => assertLiveManagedAiAuthForScenarioSelection(scenarios, {
      VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE: snapshotPath,
      E2E_MANAGED_AI_GATEWAY_FIXTURE: '0',
    }));
    assert.doesNotThrow(() => assertLiveManagedAiAuthForScenarioSelection(scenarios, {
      VESLO_DEN_AUTH_SNAPSHOT_PATH: snapshotPath,
      E2E_MANAGED_AI_GATEWAY_FIXTURE: '0',
    }));
    assert.doesNotThrow(() => assertLiveManagedAiAuthForScenarioSelection(scenarios, {
      VESLO_E2E_DEN_AUTH_JSON: JSON.stringify({
        denApiBase: 'https://api.veslo.work',
        token: 'live-token',
        user: { email: 'user@neatech.cz' },
      }),
    }));
    const source = readFileSync(new URL('./pilot-runner.ts', import.meta.url), 'utf8');
    assert.match(source, /scenarioSelectionRequiresLiveManagedAiAuth\(scenarios\)[\s\S]*VESLO_AI_GATEWAY_PROVIDER_START_TIMEOUT_MS\s*\|\|=\s*'90000'/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
