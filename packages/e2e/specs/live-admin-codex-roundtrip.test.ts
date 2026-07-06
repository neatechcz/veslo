import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { pilotScenarioSuiteNames } from '../helpers/pilot-runner.js';

const scenario = readFileSync(new URL('../pilot-scenarios/live-admin-codex-roundtrip.toml', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
};

test('live admin Codex roundtrip has an opt-in Tauri Pilot scenario', () => {
  assert.match(
    packageJson.scripts['test:pilot:live-admin-codex-roundtrip'],
    /pilot-runner\.ts --scenario live-admin-codex-roundtrip/,
  );
  assert.equal(pilotScenarioSuiteNames('current-gate').includes('live-admin-codex-roundtrip'), false);
});

test('live admin Codex Pilot scenario waits for the desktop session composer', () => {
  assert.match(scenario, /name = "live-admin-codex-roundtrip"/);
  assert.match(scenario, /\/session/);
  assert.match(scenario, /textarea, \[role="textbox"\], \[contenteditable="true"\]/);
});

test('live admin Codex Pilot scenario does not directly start a second engine', () => {
  assert.doesNotMatch(scenario, /engine_start|New session|Nová relace|聊天|\.click\(\)/);
});
