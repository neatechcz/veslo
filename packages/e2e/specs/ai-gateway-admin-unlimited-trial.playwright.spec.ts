import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { expect, test, type Route } from '@playwright/test';

const SPEC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SPEC_DIR, '../../..');
const ADMIN_PUBLIC_ROOT = join(REPO_ROOT, 'services/ai-gateway/public-admin');
const ORG_ID = 'org_unlimited_trial';

let adminServer: { origin: string; server: Server };

test.beforeAll(async () => {
  adminServer = await startStaticAdminServer();
});

test.afterAll(async () => {
  adminServer.server.close();
  await once(adminServer.server, 'close');
});

test('platform admin grants, sees, and revokes an unlimited organization trial', async ({ page }) => {
  const platformRequests: unknown[] = [];
  let billing = blockedBilling();

  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 204 }));
  await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 204 }));
  await page.route('**/readiness', (route) => fulfillJson(route, 200, { ok: true, status: 'ready' }));
  await page.route('**/admin/api/**', async (route) => {
    const request = route.request();
    const path = decodeURIComponent(new URL(request.url()).pathname.replace('/admin/api', ''));

    if (path === '/session') {
      await fulfillJson(route, 200, {
        user: { id: 'user_platform', email: 'platform@example.test', name: 'Platform Admin' },
        platformAdmin: true,
        activeOrgId: ORG_ID,
        organizations: [organization()],
        capabilities: ['organization', 'users', 'credentials', 'usage', 'alerts', 'audit', 'managedAiUserAccess'],
        allowedPages: ['organization', 'users', 'credentials', 'usage', 'alerts', 'audit'],
      });
      return;
    }
    if (path === '/organizations') {
      await fulfillJson(route, 200, { organizations: [organization()] });
      return;
    }
    if (path === `/organizations/${ORG_ID}`) {
      await fulfillJson(route, 200, { organization: organization() });
      return;
    }
    if (path === `/organizations/${ORG_ID}/billing` && request.method() === 'GET') {
      await fulfillJson(route, 200, { billing });
      return;
    }
    if (path === `/organizations/${ORG_ID}/billing/platform` && request.method() === 'PATCH') {
      const body = request.postDataJSON();
      platformRequests.push(body);
      billing = body.manualAccess?.unlimited === true ? unlimitedBilling() : blockedBilling();
      await fulfillJson(route, 200, { billing });
      return;
    }

    await fulfillJson(route, 404, { error: 'unexpected_test_route', path });
  });

  await page.goto(`${adminServer.origin}/admin/organizations/${ORG_ID}/billing`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#auth-state')).toHaveText('Signed in');
  await expect(page.locator('#organization-billing-status')).toHaveText('Billing loaded.');
  await expect(page.locator('#organization-billing-manual-unlimited')).toBeVisible();
  await expect(page.locator('#organization-billing-manual-unlimited')).not.toBeChecked();

  await page.locator('#organization-billing-manual-unlimited').check();
  await expect(page.locator('#organization-billing-manual-expires')).toBeDisabled();
  await page.locator('#organization-billing-platform-save').click();

  await expect(page.locator('#organization-billing-summary')).toContainText('Unlimited trial');
  await expect(page.locator('#organization-billing-summary')).toContainText('Unlimited');
  expect(platformRequests[0]).toEqual({
    mode: 'manual_access',
    source: 'manual_trial',
    status: 'trialing',
    quantities: { managedAiBasic: 0, managedAiExtended: 0 },
    manualAccess: { enabled: true, unlimited: true, expiresAt: null, licenseLimit: 0 },
  });

  await expect(page.locator('#organization-billing-unlimited-revoke')).toBeVisible();
  await page.locator('#organization-billing-unlimited-revoke').click();

  await expect(page.locator('#organization-billing-summary')).toContainText('Blocked');
  await expect(page.locator('#organization-billing-manual-unlimited')).not.toBeChecked();
  expect(platformRequests[1]).toEqual({
    mode: 'none',
    source: null,
    status: 'none',
    quantities: { managedAiBasic: 0, managedAiExtended: 0 },
    manualAccess: { enabled: false, unlimited: false, expiresAt: null, licenseLimit: 0 },
  });
});

function organization() {
  return {
    id: ORG_ID,
    name: 'Unlimited Trial Co',
    slug: 'unlimited-trial-co',
    ownerUserId: 'user_platform',
    role: 'organization_admin',
    status: 'active',
  };
}

function blockedBilling() {
  return {
    account: {
      mode: 'none',
      source: null,
      status: 'none',
      billingInterval: null,
      quantities: { managedAiBasic: 0, managedAiExtended: 0, localModels: 0 },
      manualAccess: { enabled: false, unlimited: false, expiresAt: null },
    },
    entitlement: {
      effectiveMode: 'none',
      canUseManagedAi: false,
      managedAiBlockingReason: 'payment_required',
      isUnlimited: false,
      licenseLimit: 0,
      activeUserCount: 3,
    },
    activeUserCount: 3,
    licenseLimit: 0,
  };
}

function unlimitedBilling() {
  return {
    account: {
      mode: 'manual_access',
      source: 'manual_trial',
      status: 'trialing',
      billingInterval: null,
      quantities: { managedAiBasic: 0, managedAiExtended: 0, localModels: 0 },
      manualAccess: { enabled: true, unlimited: true, expiresAt: null },
    },
    entitlement: {
      effectiveMode: 'manual_access',
      canUseManagedAi: true,
      managedAiBlockingReason: null,
      isUnlimited: true,
      licenseLimit: null,
      activeUserCount: 3,
    },
    activeUserCount: 3,
    licenseLimit: null,
  };
}

async function startStaticAdminServer() {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const relativePath = pathname.startsWith('/admin/') && extname(pathname)
      ? pathname.slice('/admin/'.length)
      : 'index.html';
    const filePath = join(ADMIN_PUBLIC_ROOT, relativePath);

    try {
      const body = await readFile(filePath);
      response.statusCode = 200;
      response.setHeader('Content-Type', contentType(filePath));
      response.end(body);
    } catch {
      response.statusCode = 404;
      response.end('not found');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

function contentType(path: string) {
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'text/html; charset=utf-8';
}

async function fulfillJson(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}
