import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAdminUser,
  exchangeAdminBrowserSession,
  findAdminUserByEmail,
  getAdminSession,
  listAdminCredentials,
  listAdminUsers,
  resolveAdminUserActiveOrganizationId,
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
    if (url.endsWith('/admin/api/organizations/org%2F123/members/user%2F123/ai-access')) {
      return jsonResponse(200, {
        aiAccess: {
          id: 'ai_access_123',
          userId: 'user_123',
          enabled: true,
          provider: 'codex_oauth',
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
    upsertAdminUserAiAccess(fetchImpl, gatewayBase, token, 'org/123', 'user/123', {
      enabled: true,
      provider: 'codex_oauth',
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

  const aiAccessCall = calls.find((call) => call.url.endsWith('/admin/api/organizations/org%2F123/members/user%2F123/ai-access'));
  assert.equal(aiAccessCall?.init?.method, 'PUT');
  assert.deepEqual(JSON.parse(String(aiAccessCall?.init?.body)), {
    enabled: true,
    provider: 'codex_oauth',
    credentialId: 'cred_codex_shared_1',
  });
  assert.equal(Object.hasOwn(JSON.parse(String(aiAccessCall?.init?.body)), 'organizationId'), false);
});

function scopedMember(overrides: Partial<Record<'membershipId' | 'userId' | 'status', unknown>> = {}) {
  return {
    membershipId: 'membership_123',
    userId: 'user_123',
    status: 'active',
    ...overrides,
  };
}

test('active organization resolution validates a preferred organization through scoped members', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input));
    return jsonResponse(200, { members: [scopedMember()] });
  };

  const organizationId = await resolveAdminUserActiveOrganizationId(
    fetchImpl,
    'https://gateway.example.test/',
    'admin_token',
    { id: 'user_123', memberships: [{ orgId: 'org_projection_only' }] },
    'org/preferred',
  );

  assert.equal(organizationId, 'org/preferred');
  assert.deepEqual(calls, ['https://gateway.example.test/admin/api/organizations/org%2Fpreferred/members']);
});

test('active organization resolution rejects inactive or missing preferred membership', async () => {
  for (const members of [
    [scopedMember({ status: 'disabled' })],
    [scopedMember({ status: 'removed' })],
    [scopedMember({ userId: 'different_user' })],
  ]) {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return jsonResponse(200, { members });
    };

    await assert.rejects(
      resolveAdminUserActiveOrganizationId(
        fetchImpl,
        'https://gateway.example.test',
        'admin_token',
        { id: 'user_123' },
        'org_1',
      ),
      /admin_user_active_organization_not_found/,
    );
    assert.equal(calls.filter((url) => url.endsWith('/ai-access')).length, 0);
  }
});

test('active organization resolution chooses one active candidate and ignores inactive candidates', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/organizations/org_active/')) {
      return jsonResponse(200, { members: [scopedMember()] });
    }
    return jsonResponse(200, { members: [scopedMember({ status: 'disabled' })] });
  };

  const organizationId = await resolveAdminUserActiveOrganizationId(fetchImpl, 'https://gateway.example.test', 'admin_token', {
    id: 'user_123',
    memberships: [{ orgId: 'org_inactive' }, { orgId: 'org_active' }, { orgId: 'org_active' }],
  });

  assert.equal(organizationId, 'org_active');
  assert.deepEqual(calls.sort(), [
    'https://gateway.example.test/admin/api/organizations/org_active/members',
    'https://gateway.example.test/admin/api/organizations/org_inactive/members',
  ]);
});

test('active organization resolution reports zero and multiple active organizations stably', async () => {
  const zeroFetch: typeof fetch = async () => jsonResponse(200, {
    members: [scopedMember({ status: 'removed' })],
  });
  await assert.rejects(
    resolveAdminUserActiveOrganizationId(zeroFetch, 'https://gateway.example.test', 'admin_token', {
      id: 'user_123',
      memberships: [{ orgId: 'org_removed' }],
    }),
    /admin_user_active_organization_not_found/,
  );

  const multipleFetch: typeof fetch = async () => jsonResponse(200, { members: [scopedMember()] });
  await assert.rejects(
    resolveAdminUserActiveOrganizationId(multipleFetch, 'https://gateway.example.test', 'admin_token', {
      id: 'user_123',
      memberships: [{ orgId: 'org_a' }, { orgId: 'org_b' }],
    }),
    /admin_user_active_organization_ambiguous/,
  );
});

test('active organization resolution fails safely on malformed or duplicate scoped members without PUT', async () => {
  for (const payload of [
    { members: [scopedMember({ status: undefined })] },
    { members: [scopedMember({ status: 'pending' })] },
    { members: [scopedMember(), scopedMember({ membershipId: 'membership_456' })] },
    { members: 'private-invalid-response' },
  ]) {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), method: String(init?.method || 'GET') });
      return jsonResponse(200, payload);
    };

    await assert.rejects(
      (async () => {
        const organizationId = await resolveAdminUserActiveOrganizationId(fetchImpl, 'https://gateway.example.test', 'admin_token', {
          id: 'user_123',
          memberships: [{ orgId: 'org_candidate' }],
        });
        await upsertAdminUserAiAccess(fetchImpl, 'https://gateway.example.test', 'admin_token', organizationId, 'user_123', {
          enabled: true,
          provider: 'codex_oauth',
          credentialId: 'cred_123',
        });
      })(),
      /admin_organization_members_invalid_response/,
    );
    assert.equal(calls.some((call) => call.method === 'PUT' || call.url.endsWith('/ai-access')), false);
  }
});
