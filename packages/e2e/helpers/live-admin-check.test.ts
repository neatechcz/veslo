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
