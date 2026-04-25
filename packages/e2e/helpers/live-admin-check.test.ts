import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForAdminBrowserCallback } from './live-admin-check.js';

test('waitForAdminBrowserCallback resolves the callback payload without depending on server.address after close', async () => {
  const callback = waitForAdminBrowserCallback({
    timeoutMs: 2_000,
    onReady: async ({ redirectUri }) => {
      const url = new URL(redirectUri);
      url.searchParams.set('code', 'admin-code-123');
      url.searchParams.set('transactionId', 'admin-session-456');
      const response = await fetch(url, { redirect: 'manual' });
      assert.equal(response.status, 200);
    },
  });

  const result = await callback;

  assert.equal(result.code, 'admin-code-123');
  assert.equal(result.sessionId, 'admin-session-456');
  assert.match(result.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/admin-callback$/);
});

test('waitForAdminBrowserCallback ignores bare callback hits until code and session id are present', async () => {
  const callback = waitForAdminBrowserCallback({
    timeoutMs: 2_000,
    onReady: async ({ redirectUri }) => {
      const bareUrl = new URL(redirectUri);
      const bareResponse = await fetch(bareUrl, { redirect: 'manual' });
      assert.equal(bareResponse.status, 200);

      const authUrl = new URL(redirectUri);
      authUrl.searchParams.set('code', 'admin-code-789');
      authUrl.searchParams.set('sessionId', 'admin-session-987');
      const authResponse = await fetch(authUrl, { redirect: 'manual' });
      assert.equal(authResponse.status, 200);
    },
  });

  const result = await callback;

  assert.equal(result.code, 'admin-code-789');
  assert.equal(result.sessionId, 'admin-session-987');
  assert.match(result.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/admin-callback$/);
});
