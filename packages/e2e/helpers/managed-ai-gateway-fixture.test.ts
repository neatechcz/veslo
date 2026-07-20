import assert from 'node:assert/strict';
import test from 'node:test';

import {
  E2E_MANAGED_AI_GATEWAY_ACCESS_TOKEN,
  E2E_MANAGED_AI_TOKEN,
  startManagedAiGatewayFixture,
  stopManagedAiGatewayFixture,
} from './managed-ai-gateway-fixture.js';

test('managed AI fixture exposes two enabled models and exactly one active model', async () => {
  const fixture = await startManagedAiGatewayFixture();
  try {
    const response = await fetch(`${fixture.baseUrl}/__e2e/model-policy`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      enabledModels: [
        { provider: 'codex_oauth', model: 'gpt-5.4' },
        { provider: 'codex_oauth', model: 'gpt-5.3-codex' },
      ],
      activeModel: { provider: 'codex_oauth', model: 'gpt-5.4' },
    });
  } finally {
    await stopManagedAiGatewayFixture(fixture);
  }
});

test('managed AI fixture resolves distinct users to the same active model', async () => {
  const fixture = await startManagedAiGatewayFixture();
  try {
    const readAccess = async (token: string) => {
      const response = await fetch(`${fixture.baseUrl}/api/me/ai-access`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 200);
      return await response.json() as {
        aiAccess: { userId: string; effectiveModel: { provider: string; model: string } };
      };
    };

    const primary = await readAccess(E2E_MANAGED_AI_TOKEN);
    const secondary = await readAccess('veslo-e2e-managed-ai-second-token');

    assert.notEqual(primary.aiAccess.userId, secondary.aiAccess.userId);
    assert.deepEqual(primary.aiAccess.effectiveModel, secondary.aiAccess.effectiveModel);
  } finally {
    await stopManagedAiGatewayFixture(fixture);
  }
});

test('managed AI fixture accepts an explicit model from the authorized roster', async () => {
  const fixture = await startManagedAiGatewayFixture();
  try {
    const response = await fetch(`${fixture.baseUrl}/providers/codex_oauth/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${E2E_MANAGED_AI_GATEWAY_ACCESS_TOKEN}`,
        'content-type': 'application/json',
        'x-veslo-session-id': 'session_override_probe',
      },
      body: JSON.stringify({
        model: 'gpt-5.3-codex',
        messages: [{ role: 'user', content: 'override probe' }],
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as { model?: unknown };
    assert.equal(body.model, 'gpt-5.3-codex');
  } finally {
    await stopManagedAiGatewayFixture(fixture);
  }
});

test('managed AI fixture diagnostics never retain authorization values', async () => {
  const fixture = await startManagedAiGatewayFixture();
  try {
    const response = await fetch(`${fixture.baseUrl}/providers/codex_oauth/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${E2E_MANAGED_AI_TOKEN}`,
        'content-type': 'application/json',
        'x-veslo-session-id': 'session_sanitized_probe',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'sanitized probe global-model-policy-1783865000000' }] }),
    });
    assert.equal(response.status, 200);

    const diagnostics = await fetch(`${fixture.baseUrl}/__e2e/requests`).then((entry) => entry.json()) as {
      requests: Array<Record<string, unknown>>;
    };
    assert.equal(diagnostics.requests.length, 1);
    assert.equal(diagnostics.requests[0]?.authorizationPresent, true);
    assert.equal('authorization' in diagnostics.requests[0]!, false);
    assert.equal(diagnostics.requests[0]?.promptNonce, 'global-model-policy-1783865000000');
    assert.equal('promptText' in diagnostics.requests[0]!, false);
  } finally {
    await stopManagedAiGatewayFixture(fixture);
  }
});
