import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  legacyPilotSelectionContract,
  legacyPilotSelectionSignals,
  pilotScenarioSuiteNames,
  resolvePilotScenarioSelection,
} from './pilot-runner.js';
import {
  compilePilotSelectionPlan,
  inferPilotSelectionSignals,
} from './pilot-scenario-plan.js';

const e2eRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scenarioRoot = join(e2eRoot, 'pilot-scenarios');
const selectionFixturePath = fileURLToPath(
  new URL('./__fixtures__/pilot-selection-contract.v1.json', import.meta.url),
);

type SelectionFixture = {
  schema: string;
  cases: Array<{
    id: string;
    suite?: string;
    scenarios: string[];
    env: Record<string, string | undefined>;
    plan: unknown;
  }>;
};

function baselineEnvFor(scenarios: readonly string[]): Record<string, string | undefined> {
  return scenarios.some((scenario) => scenario.endsWith('/packaged-smoke.toml'))
    ? { VESLO_PACKAGED_SMOKE: '1' }
    : {};
}

function assertContractParity(options: {
  scenarios: string[];
  suite?: string;
  env?: Record<string, string | undefined>;
}): void {
  const env = options.env ?? baselineEnvFor(options.scenarios);
  const legacySignals = legacyPilotSelectionSignals({ ...options, env });
  const compiledSignals = inferPilotSelectionSignals({ ...options, env });
  assert.deepEqual(compiledSignals, legacySignals, `signals drifted for ${options.suite ?? options.scenarios.join(', ')}`);
  assert.deepEqual(
    compilePilotSelectionPlan({ ...options, env }),
    legacyPilotSelectionContract({ ...options, env }),
    `SelectionPlan drifted for ${options.suite ?? options.scenarios.join(', ')}`,
  );
}

test('SelectionPlan compiler characterizes every standalone Pilot TOML', () => {
  const scenarios = readdirSync(scenarioRoot)
    .filter((entry) => entry.endsWith('.toml'))
    .sort()
    .map((entry) => join(scenarioRoot, entry));

  assert.equal(scenarios.length, 81, 'update the matrix deliberately when a scenario is added or removed');
  for (const scenario of scenarios) {
    assert.equal(existsSync(scenario), true, `missing scenario: ${scenario}`);
    assertContractParity({ scenarios: [scenario] });
  }
});

test('SelectionPlan compiler characterizes every named Pilot suite', () => {
  for (const suite of ['current-gate', 'live-inference', 'live-inference-lifecycle']) {
    const scenarios = resolvePilotScenarioSelection({ suite }, e2eRoot);
    assert.deepEqual(
      scenarios.map((scenario) => scenario.replaceAll('\\', '/').split('/').at(-1)?.replace('.toml', '')),
      pilotScenarioSuiteNames(suite),
    );
    assertContractParity({ suite, scenarios });
  }
});

test('SelectionPlan compiler characterizes topology-sensitive multi-scenario and profile cases', () => {
  const scenario = (name: string) => join(scenarioRoot, `${name}.toml`);
  const cases: Array<{
    scenarios: string[];
    suite?: string;
    env?: Record<string, string | undefined>;
  }> = [
    { scenarios: [scenario('global-managed-ai-model-policy'), scenario('smoke')] },
    { scenarios: [scenario('model-stream-retry-no-progress'), scenario('smoke')] },
    { scenarios: [scenario('session-queue-durability'), scenario('smoke')] },
    {
      scenarios: [scenario('packaged-smoke'), scenario('smoke')],
      env: { VESLO_PACKAGED_SMOKE: '1' },
    },
    {
      scenarios: [scenario('session-queue-durability')],
      env: { E2E_USE_EXISTING_PROFILE: '1' },
    },
    {
      scenarios: [scenario('global-managed-ai-model-policy')],
      env: { E2E_USE_EXISTING_PROFILE: '1' },
    },
    {
      scenarios: [scenario('global-managed-ai-model-policy')],
      env: { E2E_OPENCODE_HOME: '/tmp/custom-profile' },
    },
    {
      scenarios: [scenario('message-send-registry-degraded')],
      env: { E2E_USE_EXISTING_PROFILE: '1' },
    },
    {
      scenarios: [scenario('message-send-registry-degraded')],
      env: { E2E_OPENCODE_HOME: '/tmp/custom-profile' },
    },
    { scenarios: [scenario('packaged-smoke')], env: {} },
  ];

  for (const options of cases) assertContractParity(options);
});

test('checked-in SelectionPlan matrix freezes every suite, standalone scenario, and topology exception', () => {
  const fixture = JSON.parse(readFileSync(selectionFixturePath, 'utf8')) as SelectionFixture;
  assert.equal(fixture.schema, 'veslo-tauri-pilot-selection-contract/v1');
  assert.equal(fixture.cases.length, 94, 'regenerate the fixture deliberately when the policy matrix changes');

  for (const fixtureCase of fixture.cases) {
    const scenarios = fixtureCase.scenarios.map((name) => join(scenarioRoot, `${name}.toml`));
    const options = { scenarios, suite: fixtureCase.suite, env: fixtureCase.env };
    const compiled = compilePilotSelectionPlan(options);
    const legacy = legacyPilotSelectionContract(options);

    assert.deepEqual(compiled, fixtureCase.plan, `compiler drifted for ${fixtureCase.id}`);
    assert.deepEqual(legacy, fixtureCase.plan, `legacy policy drifted for ${fixtureCase.id}`);
  }
});
