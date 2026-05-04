import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('./den-managed-openai-anthropic.spec.ts', import.meta.url), 'utf8');

test('live managed AI spec does not create a workspace while waiting for the composer', () => {
  const start = source.indexOf('async function waitForComposer');
  const end = source.indexOf('async function openPrivateWorkspaceComposerIfVisible');
  assert.ok(start >= 0 && end > start, 'waitForComposer helper should be present before the explicit private workspace helper');
  const waitForComposerSource = source.slice(start, end);
  assert.doesNotMatch(
    waitForComposerSource,
    /New session|Nová relace|\.click\(\)/,
    'waitForComposer should only wait and diagnose; clicking New can create or switch workspaces before send',
  );
});

test('live managed AI spec waits for the desktop-managed engine instead of invoking engine_start directly', () => {
  const start = source.indexOf('async function ensureLocalEngineReady');
  const end = source.indexOf('async function waitForSessionRuntimeReady');
  assert.ok(start >= 0 && end > start, 'ensureLocalEngineReady helper should be present before session runtime wait helper');
  const ensureLocalEngineReadySource = source.slice(start, end);
  assert.doesNotMatch(
    ensureLocalEngineReadySource,
    /tauriInvoke<EngineInfo>\('engine_start'/,
    'ensureLocalEngineReady should wait for the app-managed engine lifecycle instead of starting a second engine instance from the spec',
  );
});

test('live managed AI spec treats auth-error assistant output as a failed roundtrip', () => {
  assert.match(
    source,
    /const assistantResponseLower = assistantResponse\.toLowerCase\(\);[\s\S]*?expect\(assistantResponseLower\)\.not\.toContain\('authentication failed'\);[\s\S]*?expect\(assistantResponseLower\)\.not\.toContain\('invalid bearer token'\);/,
    'the live roundtrip must fail when the assistant output is an auth error instead of a real model response',
  );
});

test('live managed AI spec can click localized send buttons', () => {
  assert.match(
    source,
    /button\[title="Send"\], button\[title="Odeslat"\]/,
    'live managed AI roundtrip should work with English and Czech desktop profiles',
  );
});
