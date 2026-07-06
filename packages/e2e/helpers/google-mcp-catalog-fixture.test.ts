import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGoogleMcpCatalogDenAuthJson,
  buildE2EGoogleMcpConnectors,
  buildE2ESharePointMcpConnectors,
  E2E_SKILL_REGISTRY_ORG_ID,
  E2E_SKILL_REGISTRY_TOKEN,
  shouldUseGoogleMcpCatalogFixture,
  shouldUseSharePointMcpCatalogFixture,
  startSkillRegistryFixture,
  stopSkillRegistryFixture,
} from './skill-registry-fixture.js';

test('shouldUseGoogleMcpCatalogFixture only enables the Google catalog when explicitly requested', () => {
  assert.equal(shouldUseGoogleMcpCatalogFixture({ E2E_GOOGLE_MCP_CATALOG_FIXTURE: '1' }), true);
  assert.equal(shouldUseGoogleMcpCatalogFixture({ E2E_GOOGLE_MCP_CATALOG_FIXTURE: 'true' }), false);
  assert.equal(shouldUseGoogleMcpCatalogFixture({}), false);
});

test('shouldUseSharePointMcpCatalogFixture only enables the SharePoint catalog when explicitly requested', () => {
  assert.equal(shouldUseSharePointMcpCatalogFixture({ E2E_SHAREPOINT_MCP_CATALOG_FIXTURE: '1' }), true);
  assert.equal(shouldUseSharePointMcpCatalogFixture({ E2E_SHAREPOINT_MCP_CATALOG_FIXTURE: 'true' }), false);
  assert.equal(shouldUseSharePointMcpCatalogFixture({}), false);
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
  const previousSharePointFlag = process.env.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE;
  delete process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE;
  delete process.env.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE;

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
    if (previousSharePointFlag === undefined) {
      delete process.env.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE;
    } else {
      process.env.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE = previousSharePointFlag;
    }
    await stopSkillRegistryFixture();
  }
});

test('skill registry fixture serves the Den-compatible Google MCP catalog when enabled', async () => {
  const previousFlag = process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE;
  const previousSharePointFlag = process.env.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE;
  process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE = '1';
  delete process.env.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE;

  try {
    const baseUrl = await startSkillRegistryFixture();
    const response = await fetch(`${baseUrl}/v1/orgs/${E2E_SKILL_REGISTRY_ORG_ID}/mcp/catalog`, {
      headers: {
        Authorization: `Bearer ${E2E_SKILL_REGISTRY_TOKEN}`,
      },
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as { items?: ReturnType<typeof buildE2EGoogleMcpConnectors> };
    assert.deepEqual(
      payload.items?.map((item) => item.id),
      ['google-gmail', 'google-calendar', 'google-drive'],
    );
    assert.match(payload.items?.[0]?.config.url ?? '', /\/v1\/orgs\/org_veslo_e2e_default\/integrations\/google\/google-gmail\/mcp$/);
    assert.equal(payload.items?.[0]?.config.oauth, false);
    assert.equal(payload.items?.[0]?.config.headers?.['X-Veslo-Connector'], 'google-gmail');
    assert.equal(payload.items?.[0]?.authorization?.type, 'veslo-server-oauth');
    assert.match(payload.items?.[0]?.authorization?.runtimeTokenPath ?? '', /\/v1\/orgs\/org_veslo_e2e_default\/integrations\/google\/google-gmail\/runtime-token$/);
    assert.equal(payload.items?.[0]?.provider?.group, 'Google');
  } finally {
    if (previousFlag === undefined) {
      delete process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE;
    } else {
      process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE = previousFlag;
    }
    if (previousSharePointFlag === undefined) {
      delete process.env.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE;
    } else {
      process.env.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE = previousSharePointFlag;
    }
    await stopSkillRegistryFixture();
  }
});

test('skill registry fixture serves the Den-compatible SharePoint MCP catalog when enabled', async () => {
  const previousGoogleFlag = process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE;
  const previousSharePointFlag = process.env.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE;
  delete process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE;
  process.env.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE = '1';

  try {
    const baseUrl = await startSkillRegistryFixture();
    const response = await fetch(`${baseUrl}/v1/orgs/${E2E_SKILL_REGISTRY_ORG_ID}/mcp/catalog`, {
      headers: {
        Authorization: `Bearer ${E2E_SKILL_REGISTRY_TOKEN}`,
      },
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as { items?: ReturnType<typeof buildE2ESharePointMcpConnectors> };
    assert.deepEqual(payload.items?.map((item) => item.id), ['microsoft-sharepoint']);

    const item = payload.items?.[0];
    assert.equal(item?.name, 'Microsoft SharePoint');
    assert.equal(item?.provider?.id, 'microsoft');
    assert.equal(item?.provider?.group, 'Microsoft');
    assert.deepEqual(item?.source, { scope: 'platform' });
    assert.match(item?.config.url ?? '', /\/v1\/orgs\/org_veslo_e2e_default\/integrations\/microsoft\/microsoft-sharepoint\/mcp$/);
    assert.equal(item?.config.oauth, false);
    assert.deepEqual(item?.config.headers, { 'X-Veslo-Connector': 'microsoft-sharepoint' });
    assert.equal(item?.authorization?.type, 'veslo-server-oauth');
    assert.equal(item?.authorization?.provider, 'microsoft');
    assert.equal(item?.authorization?.connectorId, 'microsoft-sharepoint');
    assert.deepEqual(item?.authorization?.scopes, [
      'openid',
      'profile',
      'offline_access',
      'https://graph.microsoft.com/Files.Read.All',
      'https://graph.microsoft.com/Sites.Read.All',
    ]);
    assert.match(item?.authorization?.startPath ?? '', /\/v1\/orgs\/org_veslo_e2e_default\/integrations\/microsoft\/microsoft-sharepoint\/oauth\/start$/);
    assert.match(item?.authorization?.runtimeTokenPath ?? '', /\/v1\/orgs\/org_veslo_e2e_default\/integrations\/microsoft\/microsoft-sharepoint\/runtime-token$/);
    assert.match(item?.authorization?.statusPath ?? '', /\/v1\/orgs\/org_veslo_e2e_default\/integrations\/microsoft\/connections$/);
    assert.match(item?.authorization?.disconnectPath ?? '', /\/v1\/orgs\/org_veslo_e2e_default\/integrations\/microsoft\/microsoft-sharepoint\/connection$/);

    const serializedPayload = JSON.stringify(payload);
    assert.doesNotMatch(serializedPayload, /MICROSOFT_CLIENT_SECRET/);
    assert.doesNotMatch(serializedPayload, /clientSecret/);
    assert.doesNotMatch(serializedPayload, /X-Veslo-Connector-Token/);
  } finally {
    if (previousGoogleFlag === undefined) {
      delete process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE;
    } else {
      process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE = previousGoogleFlag;
    }
    if (previousSharePointFlag === undefined) {
      delete process.env.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE;
    } else {
      process.env.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE = previousSharePointFlag;
    }
    await stopSkillRegistryFixture();
  }
});

test('skill registry fixture serves Google MCP runtime token and OAuth start routes when enabled', async () => {
  const previousFlag = process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE;
  const previousSharePointFlag = process.env.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE;
  process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE = '1';
  delete process.env.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE;

  try {
    const baseUrl = await startSkillRegistryFixture();
    const runtimeResponse = await fetch(`${baseUrl}/v1/orgs/${E2E_SKILL_REGISTRY_ORG_ID}/integrations/google/google-gmail/runtime-token`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${E2E_SKILL_REGISTRY_TOKEN}`,
      },
    });

    assert.equal(runtimeResponse.status, 200);
    const runtimePayload = await runtimeResponse.json() as { token?: string; connectorId?: string };
    assert.equal(runtimePayload.token, 'e2e-runtime-token-google-gmail');
    assert.equal(runtimePayload.connectorId, 'google-gmail');

    const startResponse = await fetch(`${baseUrl}/v1/orgs/${E2E_SKILL_REGISTRY_ORG_ID}/integrations/google/google-gmail/oauth/start`, {
      headers: {
        Authorization: `Bearer ${E2E_SKILL_REGISTRY_TOKEN}`,
      },
    });

    assert.equal(startResponse.status, 200);
    const startPayload = await startResponse.json() as { authorizeUrl?: string; connectorId?: string };
    assert.match(startPayload.authorizeUrl ?? '', /\/__e2e\/google-oauth\/google-gmail$/);
    assert.equal(startPayload.connectorId, 'google-gmail');
  } finally {
    if (previousFlag === undefined) {
      delete process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE;
    } else {
      process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE = previousFlag;
    }
    if (previousSharePointFlag === undefined) {
      delete process.env.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE;
    } else {
      process.env.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE = previousSharePointFlag;
    }
    await stopSkillRegistryFixture();
  }
});

test('skill registry fixture serves SharePoint MCP runtime token and OAuth routes when enabled', async () => {
  const previousGoogleFlag = process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE;
  const previousSharePointFlag = process.env.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE;
  delete process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE;
  process.env.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE = '1';

  try {
    const baseUrl = await startSkillRegistryFixture();
    const runtimeResponse = await fetch(`${baseUrl}/v1/orgs/${E2E_SKILL_REGISTRY_ORG_ID}/integrations/microsoft/microsoft-sharepoint/runtime-token`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${E2E_SKILL_REGISTRY_TOKEN}`,
      },
    });

    assert.equal(runtimeResponse.status, 200);
    const runtimePayload = await runtimeResponse.json() as { token?: string; connectorId?: string };
    assert.equal(runtimePayload.token, 'e2e-runtime-token-microsoft-sharepoint');
    assert.equal(runtimePayload.connectorId, 'microsoft-sharepoint');

    const startResponse = await fetch(`${baseUrl}/v1/orgs/${E2E_SKILL_REGISTRY_ORG_ID}/integrations/microsoft/microsoft-sharepoint/oauth/start`, {
      headers: {
        Authorization: `Bearer ${E2E_SKILL_REGISTRY_TOKEN}`,
      },
    });

    assert.equal(startResponse.status, 200);
    assert.equal(startResponse.headers.get('access-control-allow-origin'), '*');
    const startPayload = await startResponse.json() as { authorizeUrl?: string; connectorId?: string };
    assert.match(startPayload.authorizeUrl ?? '', /\/__e2e\/microsoft-oauth\/microsoft-sharepoint$/);
    assert.equal(startPayload.connectorId, 'microsoft-sharepoint');

    const preflightResponse = await fetch(`${baseUrl}/v1/orgs/${E2E_SKILL_REGISTRY_ORG_ID}/integrations/microsoft/microsoft-sharepoint/oauth/start`, {
      method: 'OPTIONS',
      headers: {
        'Access-Control-Request-Headers': 'authorization',
        'Access-Control-Request-Method': 'GET',
        Origin: 'tauri://localhost',
      },
    });
    assert.equal(preflightResponse.status, 204);
    assert.equal(preflightResponse.headers.get('access-control-allow-origin'), '*');

    const oauthPageResponse = await fetch(startPayload.authorizeUrl ?? '');
    assert.equal(oauthPageResponse.status, 200);
    assert.match(oauthPageResponse.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await oauthPageResponse.text(), /OAuth fixture ready/);
  } finally {
    if (previousGoogleFlag === undefined) {
      delete process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE;
    } else {
      process.env.E2E_GOOGLE_MCP_CATALOG_FIXTURE = previousGoogleFlag;
    }
    if (previousSharePointFlag === undefined) {
      delete process.env.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE;
    } else {
      process.env.E2E_SHAREPOINT_MCP_CATALOG_FIXTURE = previousSharePointFlag;
    }
    await stopSkillRegistryFixture();
  }
});
