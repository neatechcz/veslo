import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./live-admin-codex-roundtrip.spec.ts', import.meta.url), 'utf8');

test('live admin Codex spec strips a UTF-8 BOM before parsing the saved desktop auth snapshot', () => {
  assert.match(
    source,
    /readFileSync\(snapshotPath, 'utf8'\)\.replace\(\/\^\\uFEFF\/, ''\)/,
    'live admin Codex spec should tolerate BOM-prefixed desktop auth snapshot files',
  );
});

test('live admin Codex spec accepts desktop-runtime snapshots in addition to live browser seeds', () => {
  assert.match(
    source,
    /const acceptedSources = new Set\(\['e2e-live-browser', 'desktop-runtime'\]\);[\s\S]*?if \(!acceptedSources\.has\(source \?\? ''\)\)/,
    'live admin Codex spec should allow saved desktop-runtime auth snapshots for reruns',
  );
});

test('live admin Codex spec is skipped unless the live smoke is explicitly enabled', () => {
  assert.match(
    source,
    /const LIVE_SMOKE_ENABLED = process\.env\.E2E_LIVE_ADMIN_CODEX_ROUNDTRIP\?\.trim\(\) === '1';/,
    'live admin Codex spec should require an explicit live smoke flag',
  );
  assert.match(
    source,
    /const maybeLiveIt = LIVE_SMOKE_ENABLED \? it : it\.skip;[\s\S]*?maybeLiveIt\('should send a real Codex prompt/,
    'live admin Codex test should skip before reading required live auth env by default',
  );
});

test('live admin Codex spec forces managed-access refreshes while waiting for the assigned provider/model to appear', () => {
  assert.match(
    source,
    /async function waitForExpectedManagedAiAssignment[\s\S]*?await navigateToHash\('\/dashboard\/settings'\);[\s\S]*?const now = Date\.now\(\);[\s\S]*?window\.dispatchEvent\(new Event\('focus'\)\);/s,
    'live admin Codex spec should re-focus the app while waiting so fresh admin assignments become visible without restarting',
  );
});
