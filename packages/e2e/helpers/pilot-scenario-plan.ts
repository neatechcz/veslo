import { basename } from 'node:path';

export const PILOT_SELECTION_PLAN_SCHEMA = 'veslo-tauri-pilot-selection-plan/v1';

export type PilotProfileMode =
  | 'isolated'
  | 'existing-profile'
  | 'custom-opencode-home'
  | 'packaged-smoke';

export type PilotAuthMode = 'none' | 'fixture' | 'live-den';

export type PilotFixtureName =
  | 'automation-secondary-workspace'
  | 'skill-registry-auth'
  | 'legacy-soul-runtime'
  | 'skill-enable-inventory'
  | 'google-mcp-catalog'
  | 'sharepoint-mcp-catalog'
  | 'managed-ai-gateway'
  | 'model-stream-retry'
  | 'skill-registry-workspace-events'
  | 'session-queue-runtime'
  | 'packaged-smoke-model'
  | 'port-contention';

export type PilotEnvironmentMutation = {
  key: string;
  operation: 'set-if-empty' | 'set' | 'clear' | 'preserve-or-default' | 'fixture-value';
  value?: string;
};

export type PilotSelectionPrecondition =
  | 'canonical-timeout-cap'
  | 'focused-managed-ai-gateway'
  | 'focused-model-stream-retry'
  | 'focused-session-queue-runtime'
  | 'focused-packaged-smoke'
  | 'isolated-managed-ai-gateway-profile'
  | 'isolated-session-queue-profile'
  | 'packaged-smoke-launch-mode'
  | 'live-managed-ai-auth';

export type PilotSelectionRejectionCode =
  | 'focused-managed-ai-gateway'
  | 'focused-model-stream-retry'
  | 'focused-session-queue-runtime'
  | 'focused-packaged-smoke'
  | 'session-queue-existing-profile'
  | 'packaged-smoke-launch-mode'
  | 'managed-ai-gateway-existing-profile'
  | 'managed-ai-gateway-custom-opencode-home'
  | 'live-managed-ai-existing-profile'
  | 'live-managed-ai-custom-opencode-home';

export type PilotSelectionSignals = {
  scenarioNames: readonly string[];
  suite: string | null;
  profileMode: PilotProfileMode;
  hasPackagedSmokeLaunch: boolean;
  needsAutomationSecondaryWorkspace: boolean;
  needsSkillRegistryAuthFixture: boolean;
  needsLegacySoulRuntime: boolean;
  needsSkillEnableInventoryFixture: boolean;
  needsGoogleMcpCatalogFixture: boolean;
  needsSharePointMcpCatalogFixture: boolean;
  needsManagedAiGatewayFixture: boolean;
  needsModelStreamRetryFixture: boolean;
  disablesDevAutostart: boolean;
  needsSkillRegistryWorkspaceEventFixture: boolean;
  needsRelaunchReconnectCheck: boolean;
  needsSessionQueueRuntimeFixture: boolean;
  requiresExplicitSessionRuntimeActivation: boolean;
  needsPackagedSmokeFixture: boolean;
  needsNoWorkspaceProfile: boolean;
  needsPortContentionFixture: boolean;
  requiresLiveManagedAiAuth: boolean;
};

export type PilotSelectionPlan = {
  schema: typeof PILOT_SELECTION_PLAN_SCHEMA;
  scenarios: readonly string[];
  suite: string | null;
  profile: {
    mode: PilotProfileMode;
    defaultWorkspace: 'seeded' | 'none';
  };
  auth: PilotAuthMode;
  fixtures: readonly PilotFixtureName[];
  environment: readonly PilotEnvironmentMutation[];
  preconditions: readonly PilotSelectionPrecondition[];
  launch: {
    devAutostart: 'enabled' | 'disabled';
    scenarioTimeout: 'default' | 'canonical-live';
    relaunch: 'none' | 'vslo-270';
  };
  successArtifacts: readonly ('live-inference' | 'session-render')[];
  rejection: PilotSelectionRejectionCode | null;
};

export type CompilePilotSelectionPlanOptions = {
  scenarios: readonly string[];
  suite?: string | null;
  env?: Record<string, string | undefined>;
};

const LIVE_MANAGED_AI_SCENARIOS = new Set([
  'global-unpublished-draft',
  'gpt-5-6-sol-three-message-roundtrip',
  'message-send-registry-degraded',
  'live-skills-finder-roundtrip',
  'model-stream-retry-no-progress',
  'pending-session-instance-isolation',
  'runtime-cold-start-session-handoff',
  'sidebar-session-retention',
  'startup-sidebar-existing-sessions',
  'vslo-270-stop-reload-reconnect',
  'vslo-271-windows-idle-runtime-chain-recovery',
]);

const SESSION_QUEUE_SCENARIOS = new Set([
  'session-queue-durability',
  'session-render-stability',
  'session-run-truthfulness',
]);

const DEV_AUTOSTART_DISABLED_SCENARIOS = new Set([
  'runtime-cold-start-session-handoff',
  'vslo-235-local-host-child-exit',
  'vslo-270-stop-reload-reconnect',
  'global-managed-ai-model-policy',
  'packaged-smoke',
  ...[...LIVE_MANAGED_AI_SCENARIOS].filter((name) => name !== 'message-send-registry-degraded'),
]);

function scenarioName(value: string): string {
  return basename(value.replaceAll('\\', '/')).replace(/\.toml$/i, '');
}

function hasScenario(names: readonly string[], name: string): boolean {
  return names.includes(name);
}

function resolveProfileMode(
  env: Record<string, string | undefined>,
  hasPackagedSmokeFixture: boolean,
): PilotProfileMode {
  if (env.E2E_USE_EXISTING_PROFILE?.trim() === '1') return 'existing-profile';
  if (env.E2E_OPENCODE_HOME?.trim()) return 'custom-opencode-home';
  return hasPackagedSmokeFixture ? 'packaged-smoke' : 'isolated';
}

export function inferPilotSelectionSignals(
  options: CompilePilotSelectionPlanOptions,
): PilotSelectionSignals {
  const scenarioNames = options.scenarios.map(scenarioName);
  const env = options.env ?? {};
  const needsManagedAiGatewayFixture = hasScenario(scenarioNames, 'global-managed-ai-model-policy');
  const needsModelStreamRetryFixture = hasScenario(scenarioNames, 'model-stream-retry-no-progress') ||
    hasScenario(scenarioNames, 'vslo-270-stop-reload-reconnect');
  const needsSessionQueueRuntimeFixture = scenarioNames.some((name) => SESSION_QUEUE_SCENARIOS.has(name));
  const needsPackagedSmokeFixture = hasScenario(scenarioNames, 'packaged-smoke');
  const requiresLiveManagedAiAuth = scenarioNames.some((name) => LIVE_MANAGED_AI_SCENARIOS.has(name));

  return {
    scenarioNames,
    suite: options.suite?.trim() || null,
    profileMode: resolveProfileMode(env, needsPackagedSmokeFixture),
    hasPackagedSmokeLaunch: env.VESLO_PACKAGED_SMOKE?.trim() === '1',
    needsAutomationSecondaryWorkspace: hasScenario(scenarioNames, 'automations'),
    needsSkillRegistryAuthFixture: hasScenario(scenarioNames, 'soul-dashboard') || hasScenario(scenarioNames, 'soul-den-local'),
    needsLegacySoulRuntime: hasScenario(scenarioNames, 'soul-den-local'),
    needsSkillEnableInventoryFixture: hasScenario(scenarioNames, 'skills-enabled-state'),
    needsGoogleMcpCatalogFixture: hasScenario(scenarioNames, 'google-mcp-connectors'),
    needsSharePointMcpCatalogFixture: hasScenario(scenarioNames, 'sharepoint-mcp-connectors'),
    needsManagedAiGatewayFixture,
    needsModelStreamRetryFixture,
    disablesDevAutostart: scenarioNames.some((name) => DEV_AUTOSTART_DISABLED_SCENARIOS.has(name)),
    needsSkillRegistryWorkspaceEventFixture: hasScenario(scenarioNames, 'vslo-270-stop-reload-reconnect'),
    needsRelaunchReconnectCheck: hasScenario(scenarioNames, 'vslo-270-stop-reload-reconnect'),
    needsSessionQueueRuntimeFixture,
    requiresExplicitSessionRuntimeActivation:
      hasScenario(scenarioNames, 'session-render-stability') || hasScenario(scenarioNames, 'session-run-truthfulness'),
    needsPackagedSmokeFixture,
    needsNoWorkspaceProfile: hasScenario(scenarioNames, 'vslo-235-local-host-no-workspace'),
    needsPortContentionFixture: hasScenario(scenarioNames, 'vslo-235-local-host-port-contention'),
    requiresLiveManagedAiAuth,
  };
}

function selectionRejection(signals: PilotSelectionSignals): PilotSelectionRejectionCode | null {
  if (signals.needsManagedAiGatewayFixture && signals.scenarioNames.length > 1) {
    return 'focused-managed-ai-gateway';
  }
  if (signals.needsModelStreamRetryFixture && signals.scenarioNames.length > 1) {
    return 'focused-model-stream-retry';
  }
  if (signals.needsSessionQueueRuntimeFixture && signals.scenarioNames.length > 1) {
    return 'focused-session-queue-runtime';
  }
  if (signals.needsPackagedSmokeFixture && signals.scenarioNames.length > 1) {
    return 'focused-packaged-smoke';
  }
  if (signals.needsSessionQueueRuntimeFixture && signals.profileMode === 'existing-profile') {
    return 'session-queue-existing-profile';
  }
  if (signals.needsPackagedSmokeFixture && !signals.hasPackagedSmokeLaunch) {
    return 'packaged-smoke-launch-mode';
  }
  if (signals.needsManagedAiGatewayFixture && signals.profileMode === 'existing-profile') {
    return 'managed-ai-gateway-existing-profile';
  }
  if (signals.needsManagedAiGatewayFixture && signals.profileMode === 'custom-opencode-home') {
    return 'managed-ai-gateway-custom-opencode-home';
  }
  if (signals.requiresLiveManagedAiAuth && signals.profileMode === 'existing-profile') {
    return 'live-managed-ai-existing-profile';
  }
  if (signals.requiresLiveManagedAiAuth && signals.profileMode === 'custom-opencode-home') {
    return 'live-managed-ai-custom-opencode-home';
  }
  return null;
}

function addMutation(
  mutations: PilotEnvironmentMutation[],
  key: string,
  operation: PilotEnvironmentMutation['operation'],
  value?: string,
): void {
  if (mutations.some((mutation) => mutation.key === key && mutation.operation === operation && mutation.value === value)) {
    return;
  }
  mutations.push(value === undefined ? { key, operation } : { key, operation, value });
}

export function buildPilotSelectionPlan(signals: PilotSelectionSignals): PilotSelectionPlan {
  const fixtures: PilotFixtureName[] = [];
  const environment: PilotEnvironmentMutation[] = [];
  const preconditions: PilotSelectionPrecondition[] = [];

  const addFixture = (enabled: boolean, fixture: PilotFixtureName) => {
    if (enabled) fixtures.push(fixture);
  };
  addFixture(signals.needsAutomationSecondaryWorkspace, 'automation-secondary-workspace');
  addFixture(signals.needsSkillRegistryAuthFixture, 'skill-registry-auth');
  addFixture(signals.needsLegacySoulRuntime, 'legacy-soul-runtime');
  addFixture(signals.needsSkillEnableInventoryFixture, 'skill-enable-inventory');
  addFixture(signals.needsGoogleMcpCatalogFixture, 'google-mcp-catalog');
  addFixture(signals.needsSharePointMcpCatalogFixture, 'sharepoint-mcp-catalog');
  addFixture(signals.needsManagedAiGatewayFixture, 'managed-ai-gateway');
  addFixture(signals.needsModelStreamRetryFixture, 'model-stream-retry');
  addFixture(signals.needsSkillRegistryWorkspaceEventFixture, 'skill-registry-workspace-events');
  addFixture(signals.needsSessionQueueRuntimeFixture, 'session-queue-runtime');
  addFixture(signals.needsPackagedSmokeFixture, 'packaged-smoke-model');
  addFixture(signals.needsPortContentionFixture, 'port-contention');

  if (signals.needsAutomationSecondaryWorkspace) {
    addMutation(environment, 'E2E_SEED_AUTOMATIONS_SECONDARY_WORKSPACE', 'set-if-empty', '1');
  }
  if (signals.needsSkillRegistryAuthFixture) {
    addMutation(environment, 'E2E_SKILL_REGISTRY_AUTH_BASE', 'set-if-empty', 'fixture');
  }
  if (signals.needsLegacySoulRuntime) {
    addMutation(environment, 'E2E_SEED_LEGACY_SOUL_RUNTIME', 'set-if-empty', '1');
  }
  if (signals.needsSkillEnableInventoryFixture) {
    addMutation(environment, 'E2E_SEED_SKILL_ENABLE_INVENTORY', 'set-if-empty', '1');
  }
  if (signals.needsGoogleMcpCatalogFixture) {
    addMutation(environment, 'E2E_GOOGLE_MCP_CATALOG_FIXTURE', 'set-if-empty', '1');
  }
  if (signals.needsSharePointMcpCatalogFixture) {
    addMutation(environment, 'E2E_SHAREPOINT_MCP_CATALOG_FIXTURE', 'set-if-empty', '1');
    addMutation(environment, 'E2E_SKILL_REGISTRY_FIXTURE', 'set-if-empty', '1');
    addMutation(environment, 'E2E_SKILL_REGISTRY_AUTH_BASE', 'set-if-empty', 'fixture');
  }
  if (signals.needsModelStreamRetryFixture) {
    addMutation(environment, 'E2E_RUN_ACTIVITY_PROBE_MODE', 'set-if-empty', 'model-retry-no-progress');
    addMutation(environment, 'E2E_MANAGED_AI_RESPONSE_DELAY_MS', 'set-if-empty', '30000');
    addMutation(environment, 'VESLO_AI_GATEWAY_PROVIDER_START_TIMEOUT_MS', 'set-if-empty', '90000');
    addMutation(environment, 'VESLO_MODEL_RETRY_NO_PROGRESS_HARD_MS', 'set-if-empty', '10000');
  }
  if (signals.requiresLiveManagedAiAuth) {
    addMutation(environment, 'VESLO_AI_GATEWAY_PROVIDER_START_TIMEOUT_MS', 'set-if-empty', '90000');
    addMutation(environment, 'E2E_LIVE_PARITY_RUNTIME_PREFERENCES_SOURCE', 'preserve-or-default');
  }
  if (signals.needsSkillRegistryWorkspaceEventFixture) {
    addMutation(environment, 'E2E_SKILL_REGISTRY_EVENTS_MODE', 'set-if-empty', 'workspace-update-repeat');
  }
  if (signals.disablesDevAutostart) {
    addMutation(environment, 'VESLO_DISABLE_DEV_AUTOSTART', 'set-if-empty', '1');
  }
  if (signals.needsNoWorkspaceProfile) {
    addMutation(environment, 'E2E_SKIP_DEFAULT_WORKSPACE_STATE', 'set-if-empty', '1');
  }
  if (signals.needsManagedAiGatewayFixture) {
    for (const key of [
      'E2E_MANAGED_AI_GATEWAY_FIXTURE',
      'VESLO_E2E_DEN_AUTH_JSON',
      'E2E_DEN_AUTH_JSON',
      'VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE',
      'E2E_DEN_AUTH_SNAPSHOT_FILE',
      'VESLO_DEN_AUTH_SNAPSHOT_PATH',
    ]) {
      addMutation(environment, key, key === 'E2E_MANAGED_AI_GATEWAY_FIXTURE' ? 'set' : 'clear',
        key === 'E2E_MANAGED_AI_GATEWAY_FIXTURE' ? '1' : '');
    }
  }
  if (signals.needsSessionQueueRuntimeFixture) {
    for (const key of [
      'E2E_SESSION_QUEUE_FIXTURE_BASE_URL',
      'E2E_SESSION_QUEUE_VESLO_SERVER_URL',
      'E2E_SESSION_QUEUE_VESLO_SERVER_TOKEN',
      'E2E_SESSION_QUEUE_VESLO_WORKSPACE_ID',
      'VESLO_DEV_SERVER_URL',
      'VESLO_DEV_SERVER_TOKEN',
    ]) {
      addMutation(environment, key, 'fixture-value');
    }
    if (signals.requiresExplicitSessionRuntimeActivation) {
      addMutation(environment, 'E2E_SESSION_RUNTIME_REQUIRE_EXPLICIT_ACTIVATION', 'set', '1');
    }
    addMutation(environment, 'VESLO_E2E_DEN_AUTH_JSON', 'set', '{}');
    addMutation(environment, 'VESLO_DISABLE_DEV_AUTOSTART', 'set', '1');
  }
  if (signals.needsPackagedSmokeFixture) {
    addMutation(environment, 'E2E_PACKAGED_SMOKE_MODEL_BASE_URL', 'fixture-value');
    addMutation(environment, 'E2E_PACKAGED_SMOKE_MODEL_ID', 'fixture-value');
    for (const key of [
      'VESLO_E2E_DEN_AUTH_JSON',
      'E2E_DEN_AUTH_JSON',
      'VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE',
      'E2E_DEN_AUTH_SNAPSHOT_FILE',
      'VESLO_DEN_AUTH_SNAPSHOT_PATH',
    ]) {
      addMutation(environment, key, 'clear', '');
    }
  }
  if (signals.suite === 'live-inference') {
    for (const [key, value] of [
      ['E2E_MANAGED_AI_GATEWAY_FIXTURE', '0'],
      ['E2E_SKILL_REGISTRY_FIXTURE', '0'],
      ['E2E_SKILL_REGISTRY_SERVER_ENV', '0'],
      ['E2E_SKILL_REGISTRY_AUTH_BASE', ''],
      ['E2E_GOOGLE_MCP_CATALOG_FIXTURE', '0'],
      ['E2E_SHAREPOINT_MCP_CATALOG_FIXTURE', '0'],
      ['E2E_RUN_ACTIVITY_PROBE_MODE', ''],
      ['E2E_MANAGED_AI_RESPONSE_DELAY_MS', ''],
      ['E2E_SKILL_REGISTRY_EVENTS_MODE', ''],
      ['VESLO_DISABLE_DEV_AUTOSTART', ''],
      ['E2E_FORWARD_APP_LOGS', ''],
      ['VESLO_SEND_WORKFLOW_TRACE', '1'],
      ['VESLO_SEND_WORKFLOW_TRACE_CONSOLE', ''],
    ] as const) {
      addMutation(environment, key, key === 'E2E_FORWARD_APP_LOGS' ? 'preserve-or-default' : value ? 'set' : 'clear', value || undefined);
    }
  }

  if (signals.suite === 'live-inference') preconditions.push('canonical-timeout-cap');
  if (signals.needsManagedAiGatewayFixture) {
    preconditions.push('focused-managed-ai-gateway', 'isolated-managed-ai-gateway-profile');
  }
  if (signals.needsModelStreamRetryFixture) preconditions.push('focused-model-stream-retry');
  if (signals.needsSessionQueueRuntimeFixture) {
    preconditions.push('focused-session-queue-runtime', 'isolated-session-queue-profile');
  }
  if (signals.needsPackagedSmokeFixture) {
    preconditions.push('focused-packaged-smoke', 'packaged-smoke-launch-mode');
  }
  if (signals.requiresLiveManagedAiAuth) preconditions.push('live-managed-ai-auth');

  return {
    schema: PILOT_SELECTION_PLAN_SCHEMA,
    scenarios: signals.scenarioNames,
    suite: signals.suite,
    profile: {
      mode: signals.profileMode,
      defaultWorkspace: signals.needsNoWorkspaceProfile ? 'none' : 'seeded',
    },
    auth: signals.needsManagedAiGatewayFixture
      ? 'fixture'
      : signals.requiresLiveManagedAiAuth
        ? 'live-den'
        : 'none',
    fixtures,
    environment,
    preconditions,
    launch: {
      devAutostart: signals.disablesDevAutostart ? 'disabled' : 'enabled',
      scenarioTimeout: signals.suite === 'live-inference' ? 'canonical-live' : 'default',
      relaunch: signals.needsRelaunchReconnectCheck ? 'vslo-270' : 'none',
    },
    successArtifacts: [
      ...(signals.suite === 'live-inference' ? ['live-inference' as const] : []),
      ...(hasScenario(signals.scenarioNames, 'session-render-stability') ? ['session-render' as const] : []),
    ],
    rejection: selectionRejection(signals),
  };
}

export function compilePilotSelectionPlan(
  options: CompilePilotSelectionPlanOptions,
): PilotSelectionPlan {
  return buildPilotSelectionPlan(inferPilotSelectionSignals(options));
}
