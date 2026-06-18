import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGoogleMcpCatalogDenAuthJson,
  E2E_GOOGLE_MCP_CONNECTORS,
  E2E_SKILL_REGISTRY_ORG_ID,
  E2E_SKILL_REGISTRY_TOKEN,
  shouldUseGoogleMcpCatalogFixture,
  startSkillRegistryFixture,
  stopSkillRegistryFixture,
} from './skill-registry-fixture.js';

test('shouldUseGoogleMcpCatalogFixture only enables the Google catalog when explicitly requested', () => {
  assert.equal(shouldUseGoogleMcpCatalogFixture({ E2E_GOOGLE_MCP_CATALOG_FIXTURE: '1' }), true);
  assert.equal(shouldUseGoogleMcpCatalogFixture({ E2E_GOOGLE_MCP_CATALOG_FIXTURE: 'true' }), false);
  assert.equal(shouldUseGoogleMcpCatalogFixture({}), false);
});

test('createGoogleMcpCatalogDenAuthJson seeds desktop Den auth against the local fixture', () => {
  const auth = JSON.parse(createGoogleMcpCatalogDenAuthJson('http://127.0.0.1:54321/')) as {
    denApiBase?: unknown;
    token?: unknown;
    orgId?: unknown;
    user?: { id?: unknown; email?: unknown };
    org?: { id?: unknown; slug?: unknown };
  };

  assert.equal(auth.denApiBase, 'http://127.0.0.1:54321');
  assert.equal(auth.token, E2E_SKILL_REGISTRY_TOKEN);
  assert.equal(auth.orgId, E2E_SKILL_REGISTRY_ORG_ID);
  assert.equal(auth.user?.id, 'user_veslo_google_mcp_e2e');
  assert.equal(auth.user?.email, 'veslo-google-mcp-e2e@example.test');
  assert.equal(auth.org?.id, E2E_SKILL_REGISTRY_ORG_ID);
  assert.equal(auth.org?.slug, 'veslo-google-mcp-e2e');
});

test('skill registry fixture hides the Google MCP catalog unless the fixture flag is set', async () => {
  const previousFlag = process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE;
  delete process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE;

  try {
    const baseUrl = await startSkillRegistryFixture();
    const response = await fetch(`${baseUrl}/v1/orgs/${E2E_SKILL_REGISTRY_ORG_ID}/mcp/catalog`, {
      headers: {
        Authorization: `Bearer ${E2E_SKILL_REGISTRY_TOKEN}`,
      },
    });

    assert.equal(response.status, 404);
  } finally {
    if (previousFlag === undefined) {
      delete process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE;
    } else {
      process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE = previousFlag;
    }
    await stopSkillRegistryFixture();
  }
});

test('skill registry fixture serves the Den-compatible Google MCP catalog when enabled', async () => {
  const previousFlag = process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE;
  process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE = '1';

  try {
    const baseUrl = await startSkillRegistryFixture();
    const response = await fetch(`${baseUrl}/v1/orgs/${E2E_SKILL_REGISTRY_ORG_ID}/mcp/catalog`, {
      headers: {
        Authorization: `Bearer ${E2E_SKILL_REGISTRY_TOKEN}`,
      },
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as { items?: typeof E2E_GOOGLE_MCP_CONNECTORS };
    assert.deepEqual(
      payload.items?.map((item) => item.id),
      ['google-gmail', 'google-calendar', 'google-drive'],
    );
    assert.equal(payload.items?.[0]?.config.url, 'https://gmailmcp.googleapis.com/mcp/v1');
    assert.equal(payload.items?.[0]?.config.oauth.clientId, '{env:VESLO_GOOGLE_MCP_CLIENT_ID}');
    assert.equal(payload.items?.[0]?.provider?.group, 'Google');
  } finally {
    if (previousFlag === undefined) {
      delete process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE;
    } else {
      process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE = previousFlag;
    }
    await stopSkillRegistryFixture();
  }
});
