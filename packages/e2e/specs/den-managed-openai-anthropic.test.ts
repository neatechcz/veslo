import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pilotScenarioSuiteNames } from '../helpers/pilot-runner.js';

const scenario = readFileSync(new URL('../pilot-scenarios/den-managed-openai-anthropic.toml', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
};

test('live managed AI roundtrip has an opt-in Tauri Pilot scenario', () => {
  assert.match(
    packageJson.scripts['test:pilot:den-managed-openai-anthropic'],
    /pilot-runner\.ts --scenario den-managed-openai-anthropic/,
  );
  assert.equal(pilotScenarioSuiteNames('current-gate').includes('den-managed-openai-anthropic'), false);
});

test('live managed AI Pilot scenario waits for the desktop session surface without starting a second engine', () => {
  assert.match(scenario, /name = "den-managed-openai-anthropic"/);
  assert.match(scenario, /\/session/);
  assert.match(scenario, /textarea, \[role="textbox"\], \[contenteditable="true"\]/);
  assert.doesNotMatch(scenario, /engine_start|New session|Nová relace|聊天|\.click\(\)/);
});

test('live managed AI Pilot scenario keeps language deterministic for localized desktop profiles', () => {
  assert.match(scenario, /window\.localStorage\.setItem\("veslo\.language", "en"\)/);
});
