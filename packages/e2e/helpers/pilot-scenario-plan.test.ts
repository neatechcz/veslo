import assert from 'node:assert/strict';
import test from 'node:test';

import { compilePilotSelectionPlan } from './pilot-scenario-plan.js';

test('canonical live inference remains a real-auth isolated selection with no fallback fixture', () => {
  const plan = compilePilotSelectionPlan({
    suite: 'live-inference',
    scenarios: ['/repo/packages/e2e/pilot-scenarios/message-send-registry-degraded.toml'],
  });

  assert.equal(plan.auth, 'live-den');
  assert.equal(plan.profile.mode, 'isolated');
  assert.deepEqual(plan.fixtures, []);
  assert.deepEqual(plan.launch, {
    devAutostart: 'enabled',
    scenarioTimeout: 'canonical-live',
    relaunch: 'none',
  });
  assert.deepEqual(plan.successArtifacts, ['live-inference']);
  assert.equal(plan.rejection, null);
  assert.equal(
    plan.environment.find((mutation) => mutation.key === 'E2E_MANAGED_AI_GATEWAY_FIXTURE')?.value,
    '0',
  );
});

test('VSLO-270 keeps retry, real auth, workspace-event, and relaunch topology together', () => {
  const plan = compilePilotSelectionPlan({
    scenarios: ['/repo/packages/e2e/pilot-scenarios/vslo-270-stop-reload-reconnect.toml'],
  });

  assert.equal(plan.auth, 'live-den');
  assert.deepEqual(plan.fixtures, [
    'model-stream-retry',
    'skill-registry-workspace-events',
  ]);
  assert.deepEqual(plan.launch, {
    devAutostart: 'disabled',
    scenarioTimeout: 'default',
    relaunch: 'vslo-270',
  });
  assert.equal(plan.rejection, null);
});

test('selection compiler preserves the existing focused-isolation rejection order', () => {
  const scenarios = [
    '/repo/packages/e2e/pilot-scenarios/global-managed-ai-model-policy.toml',
    '/repo/packages/e2e/pilot-scenarios/smoke.toml',
  ];
  assert.equal(compilePilotSelectionPlan({ scenarios }).rejection, 'focused-managed-ai-gateway');
  assert.equal(
    compilePilotSelectionPlan({
      scenarios: ['/repo/packages/e2e/pilot-scenarios/session-queue-durability.toml'],
      env: { E2E_USE_EXISTING_PROFILE: '1' },
    }).rejection,
    'session-queue-existing-profile',
  );
  assert.equal(
    compilePilotSelectionPlan({
      scenarios: ['/repo/packages/e2e/pilot-scenarios/packaged-smoke.toml'],
    }).rejection,
    'packaged-smoke-launch-mode',
  );
});

test('email verification handoff is a focused isolated DEN fixture with no seeded auth', () => {
  const scenario = '/repo/packages/e2e/pilot-scenarios/email-verification-handoff.toml';
  const plan = compilePilotSelectionPlan({ scenarios: [scenario] });

  assert.equal(plan.auth, 'fixture');
  assert.equal(plan.profile.mode, 'isolated');
  assert.equal(plan.profile.defaultWorkspace, 'seeded');
  assert.deepEqual(plan.fixtures, ['email-verification-handoff']);
  assert.deepEqual(plan.preconditions, [
    'focused-email-verification-handoff',
    'isolated-email-verification-handoff-profile',
  ]);
  assert.deepEqual(
    plan.environment.find((mutation) => mutation.key === 'VESLO_E2E_DISABLE_UPDATER'),
    { key: 'VESLO_E2E_DISABLE_UPDATER', operation: 'set-if-empty', value: '1' },
  );
  for (const key of [
    'VESLO_E2E_DEN_AUTH_JSON',
    'E2E_DEN_AUTH_JSON',
    'VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE',
    'E2E_DEN_AUTH_SNAPSHOT_FILE',
    'VESLO_DEN_AUTH_SNAPSHOT_PATH',
  ]) {
    assert.deepEqual(
      plan.environment.find((mutation) => mutation.key === key),
      { key, operation: 'clear', value: '' },
    );
  }
  assert.equal(plan.rejection, null);

  assert.equal(
    compilePilotSelectionPlan({ scenarios: [scenario, '/repo/packages/e2e/pilot-scenarios/smoke.toml'] }).rejection,
    'focused-email-verification-handoff',
  );
  assert.equal(
    compilePilotSelectionPlan({ scenarios: [scenario], env: { E2E_USE_EXISTING_PROFILE: '1' } }).rejection,
    'email-verification-handoff-existing-profile',
  );
});
