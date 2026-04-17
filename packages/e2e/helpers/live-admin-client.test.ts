import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAdminUser,
  exchangeAdminBrowserSession,
  findAdminUserByEmail,
  getAdminSession,
  listAdminCredentials,
  listAdminUsers,
  startAdminBrowserSession,
  upsertAdminUserAiAccess,
} from './live-admin-client.js';

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('startAdminBrowserSession posts the PKCE payload and returns the browser handoff fields', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return jsonResponse(200, {
      authorizeUrl: 'https://den.example.test/admin/auth',
      sessionId: 'admin_session_123',
    });
  };

  const result = await startAdminBrowserSession(fetchImpl, 'https://veslo-ai-gateway-dev.onrender.com/', {
    intent: 'signin',
    redirectUri: 'http://127.0.0.1:8789/admin-callback',
    state: 'state_123',
    codeChallenge: 'challenge_123',
  });

  assert.deepEqual(result, {
    authorizeUrl: 'https://den.example.test/admin/auth',
    sessionId: 'admin_session_123',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://veslo-ai-gateway-dev.onrender.com/admin/api/auth/browser/start');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    intent: 'signin',
    redirectUri: 'http://127.0.0.1:8789/admin-callback',
    state: 'state_123',
    codeChallenge: 'challenge_123',
  });
});

test('exchangeAdminBrowserSession returns the admin bearer token', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return jsonResponse(200, { token: 'admin_token_123' });
  };

  const token = await exchangeAdminBrowserSession(fetchImpl, 'https://veslo-ai-gateway-dev.onrender.com', {
    code: 'code_123',
    sessionId: 'session_123',
    state: 'state_123',
    codeVerifier: 'verifier_123',
  });

  assert.equal(token, 'admin_token_123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://veslo-ai-gateway-dev.onrender.com/admin/api/auth/browser/exchange');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    code: 'code_123',
    sessionId: 'session_123',
    state: 'state_123',
    codeVerifier: 'verifier_123',
  });
});

test('admin client lists users, credentials, and upserts ai access with bearer auth', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const url = String(input);

    if (url.endsWith('/admin/api/session')) {
      return jsonResponse(200, {
        user: { id: 'admin_123', email: 'admin@example.test' },
        organizations: [],
      });
    }
    if (url.endsWith('/admin/api/users')) {
      if (init?.method === 'POST') {
        return jsonResponse(201, {
          user: {
            id: 'user_created',
            email: 'new.user@example.test',
            name: 'New User',
          },
        });
      }
      return jsonResponse(200, {
        users: [
          {
            id: 'user_123',
            email: 'member@example.test',
            name: 'Member',
          },
        ],
      });
    }
    if (url.endsWith('/admin/api/credentials')) {
      return jsonResponse(200, {
        credentials: [
          {
            id: 'cred_openai',
            provider: 'openai',
            state: 'healthy',
          },
        ],
      });
    }
    if (url.endsWith('/admin/api/users/user_123/ai-access')) {
      return jsonResponse(200, {
        aiAccess: {
          id: 'ai_access_123',
          userId: 'user_123',
          enabled: true,
          provider: 'codex_oauth',
          defaultModel: 'gpt-5.4',
          allowedModels: ['gpt-5.4'],
          credentialId: 'cred_codex_shared_1',
        },
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  };

  const token = 'admin_token_123';
  const gatewayBase = 'https://veslo-ai-gateway-dev.onrender.com';

  const [session, users, credentials, createdUser, aiAccess] = await Promise.all([
    getAdminSession(fetchImpl, gatewayBase, token),
    listAdminUsers(fetchImpl, gatewayBase, token),
    listAdminCredentials(fetchImpl, gatewayBase, token),
    createAdminUser(fetchImpl, gatewayBase, token, {
      email: 'new.user@example.test',
      name: 'New User',
      platformAdmin: false,
      orgId: null,
      orgRole: 'member',
    }),
    upsertAdminUserAiAccess(fetchImpl, gatewayBase, token, 'user_123', {
      enabled: true,
      provider: 'codex_oauth',
      defaultModel: 'gpt-5.4',
      allowedModels: ['gpt-5.4'],
      credentialId: 'cred_codex_shared_1',
    }),
  ]);

  assert.equal(session.user?.email, 'admin@example.test');
  assert.equal(users.length, 1);
  assert.equal(findAdminUserByEmail(users, 'MEMBER@example.test')?.id, 'user_123');
  assert.equal(credentials[0]?.provider, 'openai');
  assert.equal(createdUser.id, 'user_created');
  assert.equal(aiAccess.provider, 'codex_oauth');
  assert.equal(aiAccess.credentialId, 'cred_codex_shared_1');
  assert.equal(calls.length, 5);

  for (const call of calls) {
    if (!call.url.endsWith('/admin/api/auth/browser/start') && !call.url.endsWith('/admin/api/auth/browser/exchange')) {
      assert.equal(call.init?.headers && (call.init.headers as Record<string, string>).authorization, `Bearer ${token}`);
    }
  }

  const aiAccessCall = calls.find((call) => call.url.endsWith('/admin/api/users/user_123/ai-access'));
  assert.equal(aiAccessCall?.init?.method, 'PUT');
  assert.deepEqual(JSON.parse(String(aiAccessCall?.init?.body)), {
    enabled: true,
    provider: 'codex_oauth',
    defaultModel: 'gpt-5.4',
    allowedModels: ['gpt-5.4'],
    credentialId: 'cred_codex_shared_1',
  });
});
