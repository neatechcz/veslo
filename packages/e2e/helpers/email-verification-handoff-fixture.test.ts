import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildEmailVerificationHandoffRuntimeCleanupScript,
  buildEmailVerificationHandoffSignedOutUiProbeScript,
  buildEmailVerificationHandoffWebViewSetupScript,
  parseEmailVerificationHandoffFixture,
  pendingDesktopAuthStorageValue,
} from './email-verification-handoff-fixture.js';

const fixtureInput = {
  schema: 'veslo-email-verification-handoff-fixture/v1',
  denBaseUrl: 'http://127.0.0.1:43123',
  unverified: {
    email: 'unverified@example.test',
    transactionId: 'unverified-transaction',
    status: 'pending',
    code: null,
    authorizeStatus: 403,
    authorizeError: 'email_verification_required',
  },
  verified: {
    email: 'verified@example.test',
    userId: 'verified-user',
    transactionId: 'verified-transaction',
    state: 'verified-state',
    codeVerifier: 'verified-code-verifier',
    deepLink: 'veslo://auth-complete?code=one-time-code&transactionId=verified-transaction&state=verified-state',
  },
};

test('email verification handoff fixture accepts only the blocked/verified acceptance topology', () => {
  const fixture = parseEmailVerificationHandoffFixture(fixtureInput);

  assert.equal(fixture.denBaseUrl, fixtureInput.denBaseUrl);
  assert.deepEqual(fixture.unverified, fixtureInput.unverified);
  assert.deepEqual(fixture.verified, fixtureInput.verified);
});

test('email verification handoff fixture rejects non-loopback or already-authorized unverified inputs', () => {
  assert.throws(
    () => parseEmailVerificationHandoffFixture({ ...fixtureInput, denBaseUrl: 'https://api.veslo.work' }),
    /loopback/i,
  );
  assert.throws(
    () => parseEmailVerificationHandoffFixture({
      ...fixtureInput,
      unverified: { ...fixtureInput.unverified, status: 'authorized', code: 'unexpected-code' },
    }),
    /unverified transaction must remain pending without a code/i,
  );
});

test('pending desktop auth seed preserves the verified PKCE proof without the handoff code', () => {
  const fixture = parseEmailVerificationHandoffFixture(fixtureInput);
  assert.deepEqual(pendingDesktopAuthStorageValue(fixture), {
    sessionId: 'verified-transaction',
    state: 'verified-state',
    codeVerifier: 'verified-code-verifier',
    expiresAt: 4_102_444_800_000,
  });
});

test('WebView setup clears stale auth and seeds only endpoint, expected identity, and PKCE proof', () => {
  const fixture = parseEmailVerificationHandoffFixture(fixtureInput);
  const script = buildEmailVerificationHandoffWebViewSetupScript(fixture);

  assert.match(script, /veslo\.den\.auth/);
  assert.match(script, /veslo\.den\.apiBaseOverride/);
  assert.match(script, /veslo\.den\.desktopAuthPending/);
  assert.match(script, /den_auth_snapshot_read/);
  assert.match(script, /verified@example\.test/);
  assert.match(script, /verified-code-verifier/);
  assert.doesNotMatch(script, /one-time-code/);
  assert.doesNotMatch(script, /veslo:\/\/auth-complete/);
});

test('runtime cleanup stops only the desktop-managed workspace services and verifies their exit', () => {
  const script = buildEmailVerificationHandoffRuntimeCleanupScript();

  assert.match(script, /veslo_server_info/);
  assert.match(script, /engine_stop/);
  assert.match(script, /running/);
  assert.match(script, /did not stop/i);
  assert.doesNotMatch(script, /kill|pkill|taskkill/i);
});

test('signed-out UI probe waits for the rendered browser-login boundary before native delivery', () => {
  const script = buildEmailVerificationHandoffSignedOutUiProbeScript();

  assert.match(script, /Sign in with Browser/);
  assert.match(script, /den_auth_snapshot_read/);
  assert.match(script, /veslo\.den\.desktopAuthPending/);
  assert.match(script, /getBoundingClientRect/);
});

test('Pilot handoff polling runs asynchronously behind a native wait step', () => {
  const scenario = readFileSync(
    new URL('../pilot-scenarios/email-verification-handoff.toml', import.meta.url),
    'utf8',
  );

  assert.match(scenario, /void \(async \(\) => \{/);
  assert.match(
    scenario,
    /action = "wait"\s+target = "\[data-testid=\\"email-verification-handoff-complete\\"\], \[data-testid=\\"email-verification-handoff-error\\"\]"\s+timeout_ms = 75000/,
  );
  assert.match(scenario, /email-verification-handoff-error/);
});
