import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPilotBrowserPreludeScript,
  PILOT_BROWSER_PRELUDE_SCHEMA,
  PILOT_BROWSER_PRELUDE_STORAGE_KEY,
} from './pilot-browser-prelude.js';

test('Pilot browser prelude is a self-contained parseable browser script', () => {
  const script = buildPilotBrowserPreludeScript();

  assert.doesNotThrow(() => new Function(script));
  assert.match(script, new RegExp(PILOT_BROWSER_PRELUDE_SCHEMA));
  assert.match(script, /window\.__vesloPilotE2E = Object\.freeze/);
  assert.match(script, /insertContenteditableThroughBrowser/);
  assert.match(script, /recentTraceSummary/);
  assert.match(script, new RegExp(PILOT_BROWSER_PRELUDE_STORAGE_KEY));
  assert.match(script, /window\.sessionStorage\?\.setItem/);
});

test('Pilot browser prelude exposes no click helper and uses the browser editing path', () => {
  const script = buildPilotBrowserPreludeScript();

  assert.doesNotMatch(script, /\.click\(/);
  assert.doesNotMatch(script, /dispatchEvent\(new (?:PointerEvent|MouseEvent)/);
  assert.match(script, /document\.execCommand\(command, false, content \|\| null\)/);
  assert.doesNotMatch(script, /replaceChildren\(/);
  assert.doesNotMatch(script, /new InputEvent\('input'/);
});
