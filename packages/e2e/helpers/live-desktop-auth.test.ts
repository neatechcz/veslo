import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_DESKTOP_AUTH_REDIRECT_URI,
  exchangeLiveDesktopAuthCode,
  seedDesktopAuthSnapshotViaLiveBrowser,
  startLiveDesktopAuthTransaction,
  waitForLiveDesktopAuthCode,
} from './live-desktop-auth.js';

test('startLiveDesktopAuthTransaction uses the v2 start endpoint and PKCE payload', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        authorizeUrl: 'https://den.example.test/?desktopOnboarding=1&tid=dat_123',
        transactionId: 'dat_123',
        expiresAt: '2026-04-08T12:00:00.000Z',
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };

  const result = await startLiveDesktopAuthTransaction(fetchImpl, {
    denApiBase: 'https://den.example.test/',
  });

  assert.equal(result.authorizeUrl, 'https://den.example.test/?desktopOnboarding=1&tid=dat_123');
  assert.equal(result.transactionId, 'dat_123');
  assert.equal(calls[0]?.url, 'https://den.example.test/v2/desktop-auth/start');
  const body = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, string>;
  assert.equal(body.redirectUri, DEFAULT_DESKTOP_AUTH_REDIRECT_URI);
  assert.equal(body.intent, 'signin');
  assert.equal(body.codeChallengeMethod, 'S256');
  assert.equal(typeof body.state, 'string');
  assert.equal(typeof body.codeChallenge, 'string');
});

test('waitForLiveDesktopAuthCode polls until the transaction is authorized', async () => {
  const responses = [
    { status: 'pending' },
    { status: 'authorized', code: 'desktop-code-123' },
  ];
  const fetchImpl: typeof fetch = async () => {
    const next = responses.shift() ?? { status: 'pending' };
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const code = await waitForLiveDesktopAuthCode(fetchImpl, 'https://den.example.test', 'dat_123', {
    pollIntervalMs: 0,
    timeoutMs: 50,
    sleep: async () => {},
  });

  assert.equal(code, 'desktop-code-123');
});

test('exchangeLiveDesktopAuthCode enriches the auth state when /v1/me supplies an email', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/v2/desktop-auth/exchange')) {
      return new Response(
        JSON.stringify({
          token: 'token-123',
          user: { id: 'user-1', name: 'Michal' },
          org: { id: 'org-1', name: 'Neatech', slug: 'neatech' },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    return new Response(
      JSON.stringify({
        user: { id: 'user-1', name: 'Michal', email: 'michal.sara@neatech.cz' },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };

  const result = await exchangeLiveDesktopAuthCode(fetchImpl, {
    denApiBase: 'https://den.example.test',
    code: 'desktop-code-123',
    transactionId: 'dat_123',
    state: 'proof-state',
    codeVerifier: 'proof-verifier',
  });

  assert.equal(result.user.email, 'michal.sara@neatech.cz');
  assert.deepEqual(calls, [
    'https://den.example.test/v2/desktop-auth/exchange',
    'https://den.example.test/v1/me',
  ]);
});

test('seedDesktopAuthSnapshotViaLiveBrowser writes an authenticated desktop snapshot', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'veslo-live-auth-seed-'));
  const opencodeHome = join(tempRoot, '.tmp-opencode-home');
  const openedUrls: string[] = [];
  const statuses = [
    { status: 'pending' },
    { status: 'authorized', code: 'desktop-code-456' },
  ];

  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/v2/desktop-auth/start')) {
      return new Response(
        JSON.stringify({
          authorizeUrl: 'https://den.example.test/?desktopOnboarding=1&tid=dat_456',
          transactionId: 'dat_456',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/v2/desktop-auth/status?transactionId=')) {
      return new Response(JSON.stringify(statuses.shift() ?? { status: 'pending' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/v2/desktop-auth/exchange')) {
      return new Response(
        JSON.stringify({
          token: 'token-456',
          user: { id: 'user-456', name: 'Michal' },
          org: { id: 'org-456', name: 'Neatech', slug: 'neatech', role: 'member' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        user: { id: 'user-456', name: 'Michal', email: 'michal.sara@neatech.cz' },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  const result = await seedDesktopAuthSnapshotViaLiveBrowser({
    opencodeHome,
    denApiBase: 'https://den.example.test',
    fetchImpl,
    openBrowser: async (url) => {
      openedUrls.push(url);
    },
    pollIntervalMs: 0,
    timeoutMs: 50,
    sleep: async () => {},
  });

  const snapshot = JSON.parse(readFileSync(result.snapshotPath, 'utf8')) as {
    authJson: string;
    keepSignedIn: boolean;
    language: string;
    onboardingComplete: boolean;
    source: string;
  };
  const auth = JSON.parse(snapshot.authJson) as { user: { email?: string } };

  assert.deepEqual(openedUrls, ['https://den.example.test/?desktopOnboarding=1&tid=dat_456']);
  assert.equal(snapshot.keepSignedIn, true);
  assert.equal(snapshot.language, 'en');
  assert.equal(snapshot.onboardingComplete, true);
  assert.equal(snapshot.source, 'e2e-live-browser');
  assert.equal(auth.user.email, 'michal.sara@neatech.cz');

  rmSync(tempRoot, { recursive: true, force: true });
});
