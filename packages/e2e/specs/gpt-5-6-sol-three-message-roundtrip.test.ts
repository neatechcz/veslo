import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  resolvePilotScenarioSelection,
  scenarioSelectionDisablesDevAutostart,
  scenarioSelectionNeedsManagedAiGatewayFixture,
  scenarioSelectionRequiresLiveManagedAiAuth,
} from '../helpers/pilot-runner.js';

const scenarioUrl = new URL('../pilot-scenarios/gpt-5-6-sol-three-message-roundtrip.toml', import.meta.url);
const scenarioPath = fileURLToPath(scenarioUrl);
const scenario = existsSync(scenarioPath) ? readFileSync(scenarioPath, 'utf8') : '';

test('GPT-5.6 Sol three-message roundtrip is a focused live-auth Pilot scenario', () => {
  assert.equal(existsSync(scenarioPath), true, 'the dedicated Tauri Pilot scenario must exist');

  const selected = resolvePilotScenarioSelection(
    { scenario: ['gpt-5-6-sol-three-message-roundtrip'] },
    fileURLToPath(new URL('..', import.meta.url)),
  );
  assert.equal(scenarioSelectionRequiresLiveManagedAiAuth(selected), true);
  assert.equal(scenarioSelectionNeedsManagedAiGatewayFixture(selected), false);
  assert.equal(scenarioSelectionDisablesDevAutostart(selected), true);
});

test('scenario requires the live Codex access policy for GPT-5.6 Sol', () => {
  assert.match(scenario, /ai-gateway\/me\/ai-access/);
  assert.match(scenario, /aiAccess\?\.provider === "codex_oauth"/);
  assert.match(scenario, /aiAccess\?\.defaultModel === "gpt-5\.6-sol"/);
  assert.match(scenario, /!auth\.email\.endsWith\("@example\.test"\)/);
});

test('scenario sends three exact-response prompts in one workspace and records separate timings', () => {
  assert.match(scenario, /const initialWorkspace = await waitForActiveLocalWorkspace\(\)/);
  assert.match(scenario, /assertSameWorkspace\(initialWorkspace/);
  assert.match(scenario, /label: "cold run"/);
  assert.match(scenario, /label: "run 2"/);
  assert.match(scenario, /label: "run 3"/);
  assert.match(scenario, /Reply with exactly \$\{token\}\. Do not use tools\. No other words\./);
  assert.match(scenario, /const turns = \[/);
  assert.match(scenario, /firstAssistantVisibleMs/);
  assert.match(scenario, /settledMs/);
  assert.match(scenario, /value === token/);
  assert.match(scenario, /const stopButton = Array\.from\(document\.querySelectorAll\("button"\)\)/);
  assert.match(scenario, /return normalize\(nextComposer\.textContent\) === "" && !stopButton;/);
  assert.doesNotMatch(scenario, /normalize\(nextComposer\.textContent\) === "" && Boolean\(findSendButton/);
});

test('scenario fails closed on known inference errors and never starts or inspects an engine directly', () => {
  assert.match(scenario, /Send failed\|model_not_allowed\|codex_runtime_incompatible/i);
  assert.doesNotMatch(
    scenario,
    /tauriInvoke\("(?:engine_start|engine_info|orchestrator_workspace_activate|opencode_debug_[^"]*)"/,
  );
});
