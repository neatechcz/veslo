import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pilotRunnerModule from './pilot-runner.js';
import { compilePilotSelectionPlan } from './pilot-scenario-plan.js';

import {
  assertLiveManagedAiAuthForScenarioSelection,
  assertPilotScenarioTimeoutCap,
  assertPilotScenarioSelectionIsolated,
  buildPilotCommand,
  buildPilotDesktopAuthHydrationCheckScript,
  buildPilotLiveInferenceDiagnosticScript,
  buildPilotStorageSummaryScript,
  configureLiveParityRuntimePreferencesEnvironment,
  defaultPilotScenarios,
  formatLiveInferenceDiagnosticSummary,
  parseLiveInferenceTraceEntries,
  parsePilotJsonOutput,
  pilotScenarioSuiteNames,
  pilotFailureDiagnosticCommands,
  pilotSessionRenderSuccessArtifactCommands,
  pilotReadinessProbeCommands,
  resolvePilotBinary,
  resolveCanonicalLiveInferenceCommandTimeoutMs,
  resolveCanonicalLiveParityRuntimePreferencesSource,
  resolvePilotScenarioCommandTimeoutMs,
  resolvePilotScenarioSelection,
  redactPilotCommandArgs,
  redactPilotDiagnosticText,
  sanitizePilotArtifactName,
  scenarioSelectionNeedsSkillEnableInventoryFixture,
  scenarioSelectionNeedsGoogleMcpCatalogFixture,
  scenarioSelectionNeedsSharePointMcpCatalogFixture,
  scenarioSelectionNeedsManagedAiGatewayFixture,
  scenarioSelectionNeedsModelStreamRetryFixture,
  scenarioSelectionDisablesDevAutostart,
  scenarioSelectionNeedsRelaunchReconnectCheck,
  scenarioSelectionNeedsSessionQueueRuntimeFixture,
  scenarioSelectionRequiresExplicitSessionRuntimeActivation,
  assertSessionQueueRuntimeFixtureProfileIsolation,
  assertPackagedSmokeProfileIsolation,
  scenarioSelectionNeedsPackagedSmokeFixture,
  scenarioSelectionNeedsNoWorkspaceProfile,
  scenarioSelectionNeedsPortContentionFixture,
  scenarioSelectionRequiresLiveManagedAiAuth,
  scenarioSelectionNeedsSkillRegistryAuthFixture,
  scenarioSelectionNeedsLegacySoulRuntime,
  scenarioSelectionNeedsSkillRegistryWorkspaceEventFixture,
  scenarioSelectionNeedsAutomationSecondaryWorkspace,
  summarizeLiveInferenceDiagnostics,
} from './pilot-runner.js';

const MANAGED_AI_INFERENCE_SCENARIOS = [
  'global-unpublished-draft',
  'gpt-5-6-sol-three-message-roundtrip',
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

test('runner passes each app launch the run-owned trace and app-log context', () => {
  const source = readFileSync(new URL('./pilot-runner.ts', import.meta.url), 'utf8');

  assert.match(source, /pilotDiagnostics: pilotRunLaunchDiagnostics\(runContext, 1\)/);
  assert.match(source, /pilotDiagnostics: pilotRunLaunchDiagnostics\(runContext, 2\)/);
  assert.match(source, /logDir: runContext\.traceDir/);
  assert.match(source, /appLogDir: runContext\.appLogDir/);
});

test('runner installs the browser-only Pilot prelude after every ready desktop launch', () => {
  const source = readFileSync(new URL('./pilot-runner.ts', import.meta.url), 'utf8');

  assert.match(source, /args: \['--window', 'main', 'eval', '--json', buildPilotBrowserPreludeScript\(\)\]/);
  assert.match(source, /await ensurePilotReady\([\s\S]*await installPilotBrowserPrelude\(/);
  assert.match(source, /await startApp\(\{[\s\S]*pilotDiagnostics: pilotRunLaunchDiagnostics\(runContext, 2\)[\s\S]*await installPilotBrowserPrelude\(/);
});

test('canonical live inference observes a cold real response with diagnostic collection grace', () => {
  assert.equal(resolveCanonicalLiveInferenceCommandTimeoutMs({}), 185_000);
  assert.equal(
    resolveCanonicalLiveInferenceCommandTimeoutMs({ E2E_PILOT_SCENARIO_TIMEOUT_MS: '60000' }),
    60_000,
  );
  assert.equal(
    resolveCanonicalLiveInferenceCommandTimeoutMs({ E2E_PILOT_SCENARIO_TIMEOUT_MS: '900000' }),
    185_000,
  );
});

test('canonical live inference summarizes only timing, known fallbacks, and simulated-input state', () => {
  const summary = summarizeLiveInferenceDiagnostics({
    scenario: '/repo/packages/e2e/pilot-scenarios/message-send-registry-degraded.toml',
    browser: {
      clickAt: 1_000,
      sendStartedAt: 1_010,
      serverAcceptedAt: 1_700,
      firstAssistantTextAt: 45_600,
      firstAssistantTextSource: 'session-sse',
      traceId: 'send-private-correlation',
      sessionId: 'session-private-correlation',
      runId: 'run-private-correlation',
      modelVariant: 'xhigh',
      // This is normal lifecycle observation, not a runtime restart. Keep the
      // summary defensive even if a future browser collector returns it.
      runtimeRecoveryEvents: ['session-lifecycle-recovery:poll'],
    },
    serverTrace: parseLiveInferenceTraceEntries([
      JSON.stringify({
        ts: 1_850,
        traceId: 'send-private-correlation',
        sessionId: 'session-private-correlation',
        requestId: 'request-private-correlation',
        event: 'server:ai-gateway:provider-hit',
        provider: 'codex_oauth',
      }),
      'incomplete trace line',
      JSON.stringify({
        ts: 6_850,
        traceId: 'send-private-correlation',
        requestId: 'request-private-correlation',
        event: 'server:ai-gateway:upstream-headers',
      }),
    ].join('\n')),
    appStderr: '[runtime_prepare_workspace] orchestrator activate failed, falling back to fresh start: daemon absent',
    env: {
      E2E_MANAGED_AI_GATEWAY_FIXTURE: '0',
      E2E_MANAGED_AI_RESPONSE_DELAY_MS: '',
      E2E_RUN_ACTIVITY_PROBE_MODE: '',
      VESLO_DISABLE_DEV_AUTOSTART: '',
    },
  });

  assert.equal(summary.diagnosticsComplete, true);
  assert.deepEqual(summary.simulatedFailureInputs, {
    managedAiGatewayFixture: false,
    managedAiResponseDelay: false,
    runActivityProbe: false,
  });
  assert.equal(summary.runtimeShape.devAutostartDisabled, false);
  assert.equal(summary.runtimeShape.modelVariant, 'xhigh');
  assert.deepEqual(summary.timingMs, {
    clickToSendStart: 10,
    clickToServerAccepted: 700,
    serverAcceptedToProviderHit: 150,
    providerHitToUpstreamHeaders: 5_000,
    upstreamHeadersToFirstAssistantText: 38_750,
    providerHitToFirstAssistantText: 43_750,
    clickToFirstAssistantText: 44_600,
  });
  assert.deepEqual(summary.latencyDiagnosis, {
    dominantStage: 'stream-to-first-text',
    dominantStageMs: 38_750,
  });
  assert.equal(summary.provider, 'codex_oauth');
  assert.deepEqual(summary.fallbacks, ['orchestrator-activate-fresh-start']);
  const persisted = JSON.stringify(summary);
  assert.doesNotMatch(persisted, /private-correlation/);
  assert.match(formatLiveInferenceDiagnosticSummary(summary), /simulated=no/);
  assert.match(buildPilotLiveInferenceDiagnosticScript(), /veslo\.modelVariant/);
  assert.doesNotMatch(
    buildPilotLiveInferenceDiagnosticScript(),
    /textContent|innerText|promptText|messageText/i,
  );
  assert.deepEqual(parsePilotJsonOutput('Pilot output\n{"ok":true}'), { ok: true });
});

test('canonical live inference uses an explicit runtime preference source or the Windows dev profile default', () => {
  assert.equal(
    resolveCanonicalLiveParityRuntimePreferencesSource(
      {
        E2E_LIVE_PARITY_RUNTIME_PREFERENCES_SOURCE:
          'C:\\e2e\\runtime-preferences.json',
      },
      { platform: 'win32', fileExists: () => false },
    ),
    'C:\\e2e\\runtime-preferences.json',
  );

  const checked: string[] = [];
  assert.equal(
    resolveCanonicalLiveParityRuntimePreferencesSource(
      { APPDATA: 'C:\\Users\\micha\\AppData\\Roaming' },
      {
        platform: 'win32',
        fileExists: (path) => {
          checked.push(path);
          return true;
        },
      },
    ),
    'C:\\Users\\micha\\AppData\\Roaming\\com.neatech.veslo.dev\\runtime-preferences.json',
  );
  assert.deepEqual(checked, [
    'C:\\Users\\micha\\AppData\\Roaming\\com.neatech.veslo.dev\\runtime-preferences.json',
  ]);
  assert.equal(
    resolveCanonicalLiveParityRuntimePreferencesSource(
      { APPDATA: 'C:\\Users\\micha\\AppData\\Roaming' },
      { platform: 'linux', fileExists: () => true },
    ),
    '',
  );
});

test('every live managed-AI scenario receives the isolated runtime preference mirror source', () => {
  const env: NodeJS.ProcessEnv = {
    E2E_LIVE_PARITY_RUNTIME_PREFERENCES_SOURCE:
      'C:\\e2e\\runtime-preferences.json',
  };

  const restore = configureLiveParityRuntimePreferencesEnvironment(env);
  assert.equal(
    env.E2E_LIVE_PARITY_RUNTIME_PREFERENCES_SOURCE,
    'C:\\e2e\\runtime-preferences.json',
  );
  restore();
  assert.deepEqual(env, {
    E2E_LIVE_PARITY_RUNTIME_PREFERENCES_SOURCE:
      'C:\\e2e\\runtime-preferences.json',
  });

  const source = readFileSync(new URL('./pilot-runner.ts', import.meta.url), 'utf8');
  assert.match(
    source,
    /const restoreLiveParityRuntimePreferencesEnvironment = requiresLiveManagedAiAuth\s*\? configureLiveParityRuntimePreferencesEnvironment\(\)\s*: null/,
  );
  assert.match(
    source,
    /restoreLiveParityRuntimePreferencesEnvironment\?\.\(\);/,
  );
});

test('Pilot scenario timeout cap rejects canonical timeouts above the real cold-response budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'veslo-pilot-timeout-cap-'));
  const allowed = join(root, 'allowed.toml');
  const rejected = join(root, 'rejected.toml');
  try {
    writeFileSync(allowed, '[scenario]\nglobal_timeout_ms = 180000\n\n[[step]]\ntimeout_ms = 180000\n');
    writeFileSync(rejected, '[scenario]\nglobal_timeout_ms = 180001\n');

    assert.doesNotThrow(() => assertPilotScenarioTimeoutCap([allowed]));
    assert.throws(() => assertPilotScenarioTimeoutCap([rejected]), /global_timeout_ms=180001/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runPilotScenarios persists a JUnit result and passes an explicit timeout to Pilot runs', () => {
  const source = readFileSync(new URL('./pilot-runner.ts', import.meta.url), 'utf8');

  assert.match(source, /const selectionPlan = compilePilotSelectionPlan\(/);
  assert.match(source, /assertSelectionPlanAllowed\(selectionPlan\);/);
  assert.doesNotMatch(source, /assertSelectionPlanMatchesLegacy\(selectionPlan/);
  assert.match(source, /const isCanonicalLiveInferenceSuite = selectionPlan\.launch\.scenarioTimeout === 'canonical-live'/);
  assert.match(source, /\? resolveCanonicalLiveInferenceCommandTimeoutMs\(\)\s*:\s*resolvePilotScenarioCommandTimeoutMs\(\)/);
  assert.match(source, /if \(isCanonicalLiveInferenceSuite\) \{\s*assertPilotScenarioTimeoutCap\(scenarios\);/);
  assert.match(source, /const junitRawPath = join\(junitTemporaryDir, 'pilot\.junit\.xml'\);/);
  assert.match(source, /const args = \['run', '--junit', junitRawPath, options\.scenario\];/);
  assert.match(source, /redactPilotJUnitXml\(junit\)/);
  assert.match(source, /rmSync\(junitTemporaryDir, \{ recursive: true, force: true \}\);/);
  assert.match(source, /scenario,\s*timeoutMs: scenarioCommandTimeoutMs,\s*runContext,/);
  assert.match(source, /scenario: reconnectScenario,\s*timeoutMs: scenarioCommandTimeoutMs,\s*runContext,/);
  assert.match(source, /persistPilotScenarioCommandResult\(/);
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
    'storage-local-summary',
    'storage-session-summary',
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
  assert.deepEqual(commands.find((command) => command.name === 'storage-local-summary')?.args, [
    '--window',
    'main',
    'eval',
    '--json',
    buildPilotStorageSummaryScript('local'),
  ]);
  assert.deepEqual(commands.find((command) => command.name === 'storage-session-summary')?.args, [
    '--window',
    'main',
    'eval',
    '--json',
    buildPilotStorageSummaryScript('session'),
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

  assert.deepEqual(names, ['message-send-registry-degraded']);
  assert.deepEqual(pilotScenarioSuiteNames('live-inference-lifecycle'), ['runtime-cold-start-session-handoff']);

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
    assert.match(content, /aiAccess\?\.provider === "codex_oauth"/, `${scenarioName} must require the managed codex_oauth provider`);
    assert.match(
      content,
      /visibleAssistantTexts\(\)/,
      `${scenarioName} must require a rendered assistant response`,
    );
    assert.match(
      content,
      /sendPrompt:server-submit-first-success/,
      `${scenarioName} must assert the current production server-submit-first acceptance event`,
    );
    assert.match(content, /action = "navigate"/, `${scenarioName} must use Pilot navigation`);
    assert.match(content, /action = "type"/, `${scenarioName} must type through Pilot`);
    assert.match(
      content,
      /__vesloContenteditableTypeAdapter[\s\S]*document\.execCommand\("insertText"/,
      `${scenarioName} must adapt Pilot type through WebView's contenteditable edit algorithm`,
    );
    assert.match(content, /action = "click"/, `${scenarioName} must click through Pilot`);
    assert.match(
      content,
      /data-testid=\\"session-composer-input\\"/,
      `${scenarioName} must target the stable composer input selector`,
    );
    assert.doesNotMatch(
      content,
      /replaceChildren\(|dispatchEvent\(new InputEvent|sendButton\.click\(/,
      `${scenarioName} must not bypass native Pilot input or click actions`,
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

test('live Pilot startup gives the production webview and snapshot hydration bounded cold-start time', () => {
  const source = readFileSync(new URL('./pilot-runner.ts', import.meta.url), 'utf8');

  assert.match(source, /const PILOT_WEBVIEW_READINESS_TIMEOUT_MS = 30_000;/);
  assert.match(source, /const PILOT_DESKTOP_AUTH_HYDRATION_COMMAND_TIMEOUT_MS = 15_000;/);
  assert.match(
    source,
    /ensurePilotReady[\s\S]*Math\.min\(PILOT_WEBVIEW_READINESS_TIMEOUT_MS, resolveLaunchTimeout\(\)\)/,
  );
  assert.match(
    source,
    /verifyPilotDesktopAuthHydration[\s\S]*Math\.min\([\s\S]*PILOT_DESKTOP_AUTH_HYDRATION_COMMAND_TIMEOUT_MS,[\s\S]*options\.timeoutMs \?\? resolveLaunchTimeout\(\)/,
  );
});

test('live auth verification checks snapshot-hydrated WebView state without writing or reloading it', () => {
  const script = buildPilotDesktopAuthHydrationCheckScript();

  assert.match(script, /window\.localStorage\.getItem\("veslo\.den\.auth"\)/);
  assert.match(script, /desktop-snapshot-hydration/);
  assert.doesNotMatch(script, /setItem\(/);
  assert.doesNotMatch(script, /den_auth_snapshot_write/);
  assert.doesNotMatch(script, /window\.location\.reload\(\)/);
});

test('Pilot storage summaries expose auth state without raw storage values', () => {
  const local = buildPilotStorageSummaryScript('local');
  const session = buildPilotStorageSummaryScript('session');

  assert.match(local, /hasToken/);
  assert.match(local, /denApiBase/);
  assert.match(session, /window\.sessionStorage/);
  assert.doesNotMatch(local, /storage list/);
  assert.doesNotMatch(local, /return authRaw/);
});

test('Pilot diagnostic redaction removes bearer material from structured output and command arguments', () => {
  const redacted = redactPilotDiagnosticText(JSON.stringify({
    provider: 'codex_oauth',
    token: 'live-token',
    nested: {
      authorization: 'Bearer another-live-token',
      accessToken: 'access-live-token',
      refreshToken: 'refresh-live-token',
      clientToken: 'client-live-token',
      apiKey: 'api-key-live-token',
      secret: 'secret-live-token',
      password: 'password-live-token',
    },
    message: 'Authorization: Bearer third-live-token',
  }));

  assert.match(redacted, /codex_oauth/);
  assert.match(redacted, /<redacted>/);
  assert.doesNotMatch(redacted, /live-token|another-live-token|third-live-token|access-live-token|refresh-live-token|client-live-token|api-key-live-token|secret-live-token|password-live-token/);
  assert.deepEqual(
    redactPilotCommandArgs(['--socket', '/tmp/veslo.sock', 'eval', 'window.token = "live-token"']),
    ['--socket', '<redacted-path>', 'eval', '<redacted-eval-script>'],
  );
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
  const plan = compilePilotSelectionPlan({
    scenarios: ['/repo/packages/e2e/pilot-scenarios/sharepoint-mcp-connectors.toml'],
  });

  assert.equal(plan.fixtures.includes('sharepoint-mcp-catalog'), true);
  assert.deepEqual(
    plan.environment.filter((mutation) => mutation.key.startsWith('E2E_')),
    [
      { key: 'E2E_SHAREPOINT_MCP_CATALOG_FIXTURE', operation: 'set-if-empty', value: '1' },
      { key: 'E2E_SKILL_REGISTRY_FIXTURE', operation: 'set-if-empty', value: '1' },
      { key: 'E2E_SKILL_REGISTRY_AUTH_BASE', operation: 'set-if-empty', value: 'fixture' },
    ],
  );
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

test('global managed AI model policy selects only the deterministic gateway fixture path', () => {
  const e2eRoot = '/repo/packages/e2e';
  const scenarios = resolvePilotScenarioSelection(
    { scenario: ['global-managed-ai-model-policy'] },
    e2eRoot,
  );

  assert.equal(scenarioSelectionNeedsManagedAiGatewayFixture(scenarios), true);
  assert.equal(scenarioSelectionRequiresLiveManagedAiAuth(scenarios), false);
  assert.equal(
    scenarioSelectionNeedsManagedAiGatewayFixture(
      resolvePilotScenarioSelection({ scenario: ['smoke'] }, e2eRoot),
    ),
    false,
  );
});

test('global managed AI model policy fixture rejects the existing desktop profile', () => {
  const scenarios = resolvePilotScenarioSelection(
    { scenario: ['global-managed-ai-model-policy'] },
    '/repo/packages/e2e',
  );

  const assertProfileIsolation = (pilotRunnerModule as Record<string, unknown>)
    .assertManagedAiGatewayFixtureProfileIsolation;
  assert.equal(typeof assertProfileIsolation, 'function');
  assert.throws(
    () => (assertProfileIsolation as (selected: string[], env: NodeJS.ProcessEnv) => void)(
      scenarios,
      { E2E_USE_EXISTING_PROFILE: '1' },
    ),
    /must use the isolated E2E profile/,
  );
  assert.throws(
    () => (assertProfileIsolation as (selected: string[], env: NodeJS.ProcessEnv) => void)(
      scenarios,
      { E2E_OPENCODE_HOME: '/user/profile' },
    ),
    /must not set E2E_OPENCODE_HOME/,
  );
  assert.doesNotThrow(() => (
    assertProfileIsolation as (selected: string[], env: NodeJS.ProcessEnv) => void
  )(scenarios, {}));
});

test('global managed AI model policy is focused-only and disables debug autostart', () => {
  const e2eRoot = '/repo/packages/e2e';
  const focused = resolvePilotScenarioSelection(
    { scenario: ['global-managed-ai-model-policy'] },
    e2eRoot,
  );

  assert.equal(scenarioSelectionDisablesDevAutostart(focused), true);
  assert.doesNotThrow(() => assertPilotScenarioSelectionIsolated(focused));
  assert.throws(
    () => assertPilotScenarioSelectionIsolated([
      ...focused,
      ...resolvePilotScenarioSelection({ scenario: ['smoke'] }, e2eRoot),
    ]),
    /global-managed-ai-model-policy must run as a focused pilot scenario/,
  );
});

test('global managed AI model policy restores prior auth environment after fixture teardown', () => {
  const configureFixtureEnvironment = (pilotRunnerModule as Record<string, unknown>)
    .configureManagedAiGatewayFixtureEnvironment;
  assert.equal(typeof configureFixtureEnvironment, 'function');
  const env: NodeJS.ProcessEnv = {
    E2E_MANAGED_AI_GATEWAY_FIXTURE: '0',
    VESLO_E2E_DEN_AUTH_JSON: '{"token":"live"}',
    E2E_DEN_AUTH_JSON: '{"token":"fallback"}',
    VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE: '/tmp/veslo.json',
    E2E_DEN_AUTH_SNAPSHOT_FILE: '/tmp/fallback.json',
    VESLO_DEN_AUTH_SNAPSHOT_PATH: '/tmp/production.json',
  };

  const restore = (
    configureFixtureEnvironment as (target: NodeJS.ProcessEnv) => () => void
  )(env);
  assert.equal(env.E2E_MANAGED_AI_GATEWAY_FIXTURE, '1');
  assert.equal(env.VESLO_E2E_DEN_AUTH_JSON, '');
  assert.equal(env.E2E_DEN_AUTH_JSON, '');
  assert.equal(env.VESLO_DEN_AUTH_SNAPSHOT_PATH, '');

  restore();
  assert.deepEqual(env, {
    E2E_MANAGED_AI_GATEWAY_FIXTURE: '0',
    VESLO_E2E_DEN_AUTH_JSON: '{"token":"live"}',
    E2E_DEN_AUTH_JSON: '{"token":"fallback"}',
    VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE: '/tmp/veslo.json',
    E2E_DEN_AUTH_SNAPSHOT_FILE: '/tmp/fallback.json',
    VESLO_DEN_AUTH_SNAPSHOT_PATH: '/tmp/production.json',
  });
});

test('global managed AI model policy enables the fixture before the desktop launch', () => {
  const source = readFileSync(new URL('./pilot-runner.ts', import.meta.url), 'utf8');
  const fixtureSelection = source.indexOf("selectionPlanHasFixture(selectionPlan, 'managed-ai-gateway')");
  const fixtureEnv = source.indexOf('configureManagedAiGatewayFixtureEnvironment()');
  const desktopLaunch = source.indexOf('await startApp(');

  assert.ok(fixtureSelection >= 0, 'fixture selection guard must exist');
  assert.ok(fixtureEnv > fixtureSelection, 'fixture env must be enabled after scenario selection');
  assert.ok(desktopLaunch > fixtureEnv, 'fixture env must be enabled before startApp launches Tauri');
});

test('global managed AI model policy scenario covers the real desktop contract', () => {
  const scenarioUrl = new URL('../pilot-scenarios/global-managed-ai-model-policy.toml', import.meta.url);
  assert.equal(existsSync(scenarioUrl), true, 'global managed AI model policy Pilot scenario is missing');

  const content = readFileSync(scenarioUrl, 'utf8');
  assert.match(content, /name = "global-managed-ai-model-policy"/);
  assert.match(content, /window\.location\.hash = "\/dashboard\/settings\?debug=1"/);
  assert.doesNotMatch(content, /setTimeout\(\(\) => window\.location\.assign/);
  const debugAnchor = content.indexOf('target = "[data-testid=\\"managed-ai-access-settings-card\\"]"');
  const proofStart = content.indexOf('name = "start global managed AI model policy proof"');
  assert.ok(debugAnchor >= 0, 'scenario must wait for the developer-only managed AI card');
  assert.ok(debugAnchor < proofStart, 'developer-mode card must render before the async proof starts');
  assert.match(content, /canonicalizeModelLabel/);
  assert.match(content, /normalSettingsSurface/);
  assert.match(content, /sessionComposerSurface/);
  assert.match(content, /assertNoModelAuthorityControls/);
  assert.match(content, /promptNonce/);
  assert.doesNotMatch(content, /entry\.promptText/);
  assert.match(content, /__e2e\/model-policy/);
  assert.match(content, /enabledModels\.length === 2/);
  assert.match(content, /Change model/);
  assert.match(content, /findComposerSendButton/);
  assert.match(content, /tauriInvoke\("runtime_prepare_workspace"/);
  assert.doesNotMatch(content, /tauriInvoke\("(?:engine_start|orchestrator_workspace_activate)"/);
  assert.match(content, /__e2e\/requests/);
  assert.match(content, /gpt-5\.3-codex/);
  assert.match(content, /model_override_not_allowed/);
  assert.match(content, /veslo-e2e-managed-ai-second-token/);
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

test('VSLO-270 scenarios use the atomic workspace runtime preparation contract', () => {
  const scenarios = [
    '../pilot-scenarios/vslo-270-stop-reload-reconnect.toml',
    '../pilot-scenarios/vslo-270-relaunch-reconnect.toml',
  ];

  for (const scenario of scenarios) {
    const content = readFileSync(new URL(scenario, import.meta.url), 'utf8');

    assert.match(content, /tauriInvoke\("runtime_prepare_workspace"/);
    assert.doesNotMatch(content, /tauriInvoke\("(?:engine_start|orchestrator_workspace_activate)"/);
  }
});

test('VSLO-270 stop reload reconnect uses real Pilot UI navigation, type, Send, and Stop', () => {
  const content = readFileSync(
    new URL('../pilot-scenarios/vslo-270-stop-reload-reconnect.toml', import.meta.url),
    'utf8',
  );

  assert.match(content, /action = "navigate"/);
  assert.match(content, /action = "type"/);
  assert.match(content, /action = "click"/);
  assert.match(content, /installContenteditableTypeAdapter\(\)/);
  assert.match(content, /session-composer-send-button/);
  assert.match(content, /session-composer-stop-button/);
  assert.match(content, /NativeSendClick/);
  assert.match(content, /NativeStopClick/);
  assert.doesNotMatch(content, /navigateToHash\(/);
  assert.doesNotMatch(content, /replaceChildren\(|dispatchEvent\(new InputEvent|sendButton\.click\(|stopButton\.click\(/);
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
  assert.match(content, /entry\?\.event === "managed-config-compare"/);
  assert.match(content, /entry\?\.matches === true/);
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
    scenarioSelectionDisablesDevAutostart(
      resolvePilotScenarioSelection({ scenario: ['vslo-235-local-host-child-exit'] }, e2eRoot),
    ),
    true,
  );
  assert.equal(
    scenarioSelectionDisablesDevAutostart(resolvePilotScenarioSelection({ scenario: ['smoke'] }, e2eRoot)),
    false,
  );
  assert.equal(
    scenarioSelectionDisablesDevAutostart(resolvePilotScenarioSelection({ scenario: ['packaged-smoke'] }, e2eRoot)),
    true,
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

test('session render stability reuses the isolated deterministic lifecycle fixture and captures width-specific artifacts', () => {
  const selected = ['/repo/packages/e2e/pilot-scenarios/session-render-stability.toml'];
  assert.equal(scenarioSelectionNeedsSessionQueueRuntimeFixture(selected), true);
  assert.throws(
    () => assertPilotScenarioSelectionIsolated([...selected, '/repo/packages/e2e/pilot-scenarios/smoke.toml']),
    /session-queue-durability must run as a focused pilot scenario/,
  );
  const commands = pilotSessionRenderSuccessArtifactCommands('/tmp/session-render-artifacts');
  assert.deepEqual(
    commands.filter((command) => command.name.startsWith('screenshot-')).map((command) => command.args.at(-1)),
    [
      join('/tmp/session-render-artifacts', 'session-390x844.png'),
      join('/tmp/session-render-artifacts', 'session-768x900.png'),
      join('/tmp/session-render-artifacts', 'session-1440x1000.png'),
    ],
  );
  assert.deepEqual(
    commands.find((command) => command.name === 'session-center-snapshot')?.args,
    ['--window', 'main', 'snapshot', '-i', '--selector', '[data-testid="session-center-pane"]', '--depth', '8'],
  );
});

test('session run truthfulness reuses the focused deterministic lifecycle fixture', () => {
  const selected = ['/repo/packages/e2e/pilot-scenarios/session-run-truthfulness.toml'];
  assert.equal(scenarioSelectionNeedsSessionQueueRuntimeFixture(selected), true);
  assert.throws(
    () => assertSessionQueueRuntimeFixtureProfileIsolation(selected, { E2E_USE_EXISTING_PROFILE: '1' }),
    /must not use E2E_USE_EXISTING_PROFILE=1/,
  );
});

test('VSLO-281 MSG attachment acceptance reuses the focused deterministic lifecycle fixture', () => {
  const selected = ['/repo/packages/e2e/pilot-scenarios/vslo-281-msg-attachment-visible-error.toml'];
  assert.equal(scenarioSelectionNeedsSessionQueueRuntimeFixture(selected), true);
  assert.equal(scenarioSelectionRequiresExplicitSessionRuntimeActivation(selected), true);
  assert.throws(
    () => assertPilotScenarioSelectionIsolated([...selected, '/repo/packages/e2e/pilot-scenarios/smoke.toml']),
    /focused pilot scenario/,
  );
  assert.throws(
    () => assertSessionQueueRuntimeFixtureProfileIsolation(selected, { E2E_USE_EXISTING_PROFILE: '1' }),
    /must not use E2E_USE_EXISTING_PROFILE=1/,
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

test('non-canonical managed AI scenarios disable debug dev autostart while the canonical suite measures dev parity', () => {
  const e2eRoot = '/repo/packages/e2e';

  for (const scenarioName of MANAGED_AI_INFERENCE_SCENARIOS) {
    assert.equal(
      scenarioSelectionDisablesDevAutostart(resolvePilotScenarioSelection({ scenario: [scenarioName] }, e2eRoot)),
      scenarioName !== 'message-send-registry-degraded',
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
  const plan = compilePilotSelectionPlan({
    scenarios: ['/repo/packages/e2e/pilot-scenarios/model-stream-retry-no-progress.toml'],
  });

  assert.deepEqual(
    plan.environment.find((mutation) => mutation.key === 'VESLO_AI_GATEWAY_PROVIDER_START_TIMEOUT_MS'),
    { key: 'VESLO_AI_GATEWAY_PROVIDER_START_TIMEOUT_MS', operation: 'set-if-empty', value: '90000' },
  );
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

test('canonical live inference clears inherited E2E gateway and registry fixtures before desktop launch', () => {
  const configureLiveEnvironment = (pilotRunnerModule as Record<string, unknown>)
    .configureCanonicalLiveInferenceEnvironment;
  assert.equal(typeof configureLiveEnvironment, 'function');
  const env: NodeJS.ProcessEnv = {
    E2E_MANAGED_AI_GATEWAY_FIXTURE: '0',
    E2E_SKILL_REGISTRY_FIXTURE: '1',
    E2E_SKILL_REGISTRY_SERVER_ENV: '1',
    E2E_SKILL_REGISTRY_AUTH_BASE: 'fixture',
    E2E_GOOGLE_MCP_CATALOG_FIXTURE: '1',
    E2E_SHAREPOINT_MCP_CATALOG_FIXTURE: '1',
    E2E_RUN_ACTIVITY_PROBE_MODE: 'model-retry-no-progress',
    E2E_MANAGED_AI_RESPONSE_DELAY_MS: '30000',
    E2E_SKILL_REGISTRY_EVENTS_MODE: 'workspace-update-repeat',
    VESLO_DISABLE_DEV_AUTOSTART: '1',
    VESLO_RUNTIME_DIAGNOSTICS: '0',
    VESLO_SEND_WORKFLOW_TRACE: '0',
    VESLO_SEND_WORKFLOW_TRACE_CONSOLE: '1',
  };

  const restore = (
    configureLiveEnvironment as (target: NodeJS.ProcessEnv) => () => void
  )(env);
  assert.deepEqual(env, {
    E2E_MANAGED_AI_GATEWAY_FIXTURE: '0',
    E2E_SKILL_REGISTRY_FIXTURE: '0',
    E2E_SKILL_REGISTRY_SERVER_ENV: '0',
    E2E_SKILL_REGISTRY_AUTH_BASE: '',
    E2E_GOOGLE_MCP_CATALOG_FIXTURE: '0',
    E2E_SHAREPOINT_MCP_CATALOG_FIXTURE: '0',
    E2E_RUN_ACTIVITY_PROBE_MODE: '',
    E2E_MANAGED_AI_RESPONSE_DELAY_MS: '',
    E2E_SKILL_REGISTRY_EVENTS_MODE: '',
    VESLO_DISABLE_DEV_AUTOSTART: '',
    VESLO_RUNTIME_DIAGNOSTICS: '0',
    E2E_FORWARD_APP_LOGS: '0',
    VESLO_SEND_WORKFLOW_TRACE: '1',
    VESLO_SEND_WORKFLOW_TRACE_CONSOLE: '',
  });

  restore();
  assert.deepEqual(env, {
    E2E_MANAGED_AI_GATEWAY_FIXTURE: '0',
    E2E_SKILL_REGISTRY_FIXTURE: '1',
    E2E_SKILL_REGISTRY_SERVER_ENV: '1',
    E2E_SKILL_REGISTRY_AUTH_BASE: 'fixture',
    E2E_GOOGLE_MCP_CATALOG_FIXTURE: '1',
    E2E_SHAREPOINT_MCP_CATALOG_FIXTURE: '1',
    E2E_RUN_ACTIVITY_PROBE_MODE: 'model-retry-no-progress',
    E2E_MANAGED_AI_RESPONSE_DELAY_MS: '30000',
    E2E_SKILL_REGISTRY_EVENTS_MODE: 'workspace-update-repeat',
    VESLO_DISABLE_DEV_AUTOSTART: '1',
    VESLO_RUNTIME_DIAGNOSTICS: '0',
    VESLO_SEND_WORKFLOW_TRACE: '0',
    VESLO_SEND_WORKFLOW_TRACE_CONSOLE: '1',
  });
});

test('canonical live inference applies its no-fixture environment before launching desktop', () => {
  const source = readFileSync(new URL('./pilot-runner.ts', import.meta.url), 'utf8');
  const configuration = source.indexOf('configureCanonicalLiveInferenceEnvironment()');
  const desktopLaunch = source.indexOf('await startApp(');

  assert.ok(configuration >= 0, 'canonical live inference fixture reset must exist');
  assert.ok(desktopLaunch > configuration, 'canonical live inference must reset fixtures before startApp launches Tauri');
});

test('packaged smoke requires its isolated production-shaped launch contract', () => {
  const e2eRoot = '/repo/packages/e2e';
  const scenarios = resolvePilotScenarioSelection({ scenario: ['packaged-smoke'] }, e2eRoot);

  assert.equal(scenarioSelectionNeedsPackagedSmokeFixture(scenarios), true);
  assert.throws(
    () => assertPackagedSmokeProfileIsolation(scenarios, {}),
    /desktop:smoke-packaged/,
  );
  assert.throws(
    () => assertPackagedSmokeProfileIsolation(scenarios, {
      VESLO_PACKAGED_SMOKE: '1',
      VESLO_DEV_SERVER_URL: 'http://127.0.0.1:8787',
    }),
    /VESLO_DEV_SERVER_URL/,
  );
  assert.throws(
    () => assertPackagedSmokeProfileIsolation(scenarios, {
      VESLO_PACKAGED_SMOKE: '1',
      OPENROUTER_API_KEY: 'not-for-smoke',
    }),
    /OPENROUTER_API_KEY/,
  );
  assert.throws(
    () => assertPackagedSmokeProfileIsolation(scenarios, {
      VESLO_PACKAGED_SMOKE: '1',
      E2E_LAUNCH_TIMEOUT: '60000',
    }),
    /E2E_LAUNCH_TIMEOUT/,
  );
  assert.throws(
    () => assertPackagedSmokeProfileIsolation(scenarios, {
      VESLO_PACKAGED_SMOKE: '1',
      VESLO_DEN_API_BASE: 'https://den.example.test',
    }),
    /VESLO_DEN_API_BASE/,
  );
  assert.throws(
    () => assertPackagedSmokeProfileIsolation(scenarios, {
      VESLO_PACKAGED_SMOKE: '1',
      VESLO_DOCUMENT_RUNTIME_MODULE: 'file:///C:/checkout/provider.mjs',
    }),
    /VESLO_DOCUMENT_RUNTIME_MODULE/,
  );
  assert.throws(
    () => assertPackagedSmokeProfileIsolation(scenarios, {
      VESLO_PACKAGED_SMOKE: '1',
      OPENCODE_ROUTER_BIN_PATH: 'C:\\checkout\\veslo-code-router.exe',
    }),
    /OPENCODE_ROUTER_BIN_PATH/,
  );
  assert.throws(
    () => assertPilotScenarioSelectionIsolated([
      ...scenarios,
      ...resolvePilotScenarioSelection({ scenario: ['smoke'] }, e2eRoot),
    ]),
    /focused pilot scenario/,
  );
  assert.doesNotThrow(() => assertPackagedSmokeProfileIsolation(scenarios, {
    VESLO_PACKAGED_SMOKE: '1',
  }));
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
        E2E_USE_EXISTING_PROFILE: '1',
      }),
      /harness-owned isolated profile/,
    );
    assert.throws(
      () => assertLiveManagedAiAuthForScenarioSelection(scenarios, {
        VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE: snapshotPath,
        E2E_OPENCODE_HOME: 'C:\\Users\\jajse\\.opencode',
      }),
      /harness-owned isolated profile/,
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
    const plan = compilePilotSelectionPlan({ scenarios });
    assert.deepEqual(
      plan.environment.find((mutation) => mutation.key === 'VESLO_AI_GATEWAY_PROVIDER_START_TIMEOUT_MS'),
      { key: 'VESLO_AI_GATEWAY_PROVIDER_START_TIMEOUT_MS', operation: 'set-if-empty', value: '90000' },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
