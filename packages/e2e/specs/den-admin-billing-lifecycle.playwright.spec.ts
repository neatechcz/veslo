import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page, type Route } from '@playwright/test';

const ADMIN_TOKEN_STORAGE_KEY = 'veslo.den.admin.token';
const TEST_TOKEN = 'billing-lifecycle-token';
const SPEC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SPEC_DIR, '../../..');
const ADMIN_PUBLIC_ROOT = join(REPO_ROOT, 'services/den/public-admin');
const ORG_ID = 'org_billing_main';

let adminServer: { origin: string; server: Server };

test.beforeAll(async () => {
  adminServer = await startStaticAdminServer();
});

test.afterAll(async () => {
  await closeServer(adminServer.server);
});

test.describe('Den admin billing subscription lifecycle UI', () => {
  test('starts Stripe Checkout for a new subscription and validates empty quantities', async ({ page }) => {
    const harness = await installBillingHarness(page, {
      organizations: [organization(ORG_ID, 'Acme Billing')],
      billingByOrgId: {
        [ORG_ID]: billingNone({ activeUserCount: 2 }),
      },
    });

    await openBilling(page, 'organization');

    await expect(page.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible();
    await expect(page.locator('#billing-notice-title')).toHaveText('Managed AI is blocked');
    await expect(page.locator('#billing-managed-ai')).toHaveText('Blocked');
    await expect(page.locator('#billing-license-total')).toHaveText('0');
    await expect(page.locator('#billing-update-button')).toHaveText('Start checkout');
    await expect(page.locator('#billing-portal-button')).toBeDisabled();

    await page.locator('#billing-basic-quantity').fill('0');
    await page.locator('#billing-extended-quantity').fill('0');
    await page.locator('#billing-update-button').click();
    await expect(page.locator('#billing-action-status')).toHaveText('Choose at least one Basic or Extended license.');
    expect(harness.checkoutRequests).toEqual([]);

    await page.getByRole('button', { name: 'Annual' }).click();
    await page.locator('#billing-basic-quantity').fill('2');
    await Promise.all([
      page.waitForURL('https://checkout.stripe.test/session/org_billing_main'),
      page.locator('#billing-update-button').click(),
    ]);

    expect(harness.checkoutRequests).toEqual([
      {
        interval: 'annual',
        quantities: { managedAiBasic: 2, managedAiExtended: 0 },
      },
    ]);
    await expect(page.getByRole('heading', { name: 'Stripe Checkout' })).toBeVisible();
  });

  test('keeps billing blocked after a canceled checkout and shows active access after webhook-backed return', async ({ page }) => {
    const harness = await installBillingHarness(page, {
      organizations: [organization(ORG_ID, 'Acme Billing')],
      billingByOrgId: {
        [ORG_ID]: billingNone({ activeUserCount: 2 }),
      },
    });

    await openBilling(page, 'organization');
    await page.locator('#billing-basic-quantity').fill('2');
    await Promise.all([
      page.waitForURL('https://checkout.stripe.test/session/org_billing_main'),
      page.locator('#billing-update-button').click(),
    ]);

    await page.goto(`${adminServer.origin}/admin/billing/organization`);
    await expectReady(page);
    await expect(page.locator('#billing-notice-title')).toHaveText('Managed AI is blocked');
    await expect(page.locator('#billing-license-total')).toHaveText('0');

    harness.setBilling(
      ORG_ID,
      billingAccount({
        activeUserCount: 2,
        basic: 2,
        extended: 1,
        interval: 'annual',
        status: 'active',
        source: 'stripe_checkout',
        customerConfigured: true,
        subscriptionConfigured: true,
        canUseManagedAi: true,
      }),
    );

    await page.goto(`${adminServer.origin}/admin/billing/organization`);
    await expectReady(page);
    await expect(page.locator('#billing-notice-title')).toHaveText('AI inference is enabled');
    await expect(page.locator('#billing-managed-ai')).toHaveText('Allowed');
    await expect(page.locator('#billing-license-total')).toHaveText('3');
    await expect(page.locator('#billing-license-detail')).toHaveText('2 Basic, 1 Extended');
    await expect(page.locator('#billing-interval')).toHaveText('annual');
    await expect(page.locator('#billing-update-button')).toHaveText('Update licenses');
    await expect(page.locator('#billing-portal-button')).toBeEnabled();
  });

  test('updates subscription quantities and rejects reductions below active users', async ({ page }) => {
    const harness = await installBillingHarness(page, {
      organizations: [organization(ORG_ID, 'Acme Billing')],
      billingByOrgId: {
        [ORG_ID]: billingAccount({
          activeUserCount: 2,
          basic: 2,
          extended: 0,
          status: 'active',
          customerConfigured: true,
          subscriptionConfigured: true,
          canUseManagedAi: true,
        }),
      },
    });

    await openBilling(page, 'organization');
    await expect(page.locator('#billing-update-button')).toHaveText('Update licenses');

    await page.locator('#billing-basic-quantity').fill('3');
    await page.locator('#billing-extended-quantity').fill('1');
    await page.locator('#billing-update-button').click();

    await expect(page.locator('#billing-action-status')).toHaveText('Subscription quantities updated.');
    await expect(page.locator('#billing-license-total')).toHaveText('4');
    await expect(page.locator('#billing-license-detail')).toHaveText('3 Basic, 1 Extended');
    expect(harness.planRequests).toEqual([
      { quantities: { managedAiBasic: 3, managedAiExtended: 1 } },
    ]);

    await page.locator('#billing-basic-quantity').fill('1');
    await page.locator('#billing-extended-quantity').fill('0');
    await page.locator('#billing-update-button').click();

    await expect(page.locator('#billing-action-status')).toHaveText(
      'Unable to update billing: requested_license_limit_below_active_users',
    );
    await expect(page.locator('#billing-license-total')).toHaveText('4');
    await expect(page.locator('#billing-license-detail')).toHaveText('3 Basic, 1 Extended');
  });

  test('opens Stripe Portal and reflects cancel-at-period-end and canceled subscription states', async ({ page }) => {
    const harness = await installBillingHarness(page, {
      organizations: [organization(ORG_ID, 'Acme Billing')],
      billingByOrgId: {
        [ORG_ID]: billingAccount({
          activeUserCount: 2,
          basic: 3,
          status: 'active',
          customerConfigured: true,
          subscriptionConfigured: true,
          canUseManagedAi: true,
        }),
      },
    });

    await openBilling(page, 'organization');
    await Promise.all([
      page.waitForURL('https://portal.stripe.test/session/org_billing_main'),
      page.locator('#billing-portal-button').click(),
    ]);
    expect(harness.portalRequests).toEqual([{}]);
    await expect(page.getByRole('heading', { name: 'Stripe Customer Portal' })).toBeVisible();

    harness.setBilling(
      ORG_ID,
      billingAccount({
        activeUserCount: 2,
        basic: 3,
        status: 'active',
        cancelAtPeriodEnd: true,
        customerConfigured: true,
        subscriptionConfigured: true,
        canUseManagedAi: true,
      }),
    );
    await page.goto(`${adminServer.origin}/admin/billing/organization`);
    await expectReady(page);
    await expect(page.locator('#billing-renewal')).toHaveText('Canceling');
    await expect(page.locator('#billing-managed-ai')).toHaveText('Allowed');

    harness.setBilling(
      ORG_ID,
      billingAccount({
        activeUserCount: 2,
        basic: 0,
        status: 'canceled',
        customerConfigured: true,
        subscriptionConfigured: false,
        canUseManagedAi: false,
        managedAiBlockingReason: 'payment_required',
      }),
    );
    await page.goto(`${adminServer.origin}/admin/billing/organization`);
    await expectReady(page);
    await expect(page.locator('#billing-status-chip')).toHaveText('canceled');
    await expect(page.locator('#billing-license-total')).toHaveText('0');
    await expect(page.locator('#billing-managed-ai')).toHaveText('Blocked');
  });

  test('shows payment failure and recovery after Stripe invoice webhooks', async ({ page }) => {
    const harness = await installBillingHarness(page, {
      organizations: [organization(ORG_ID, 'Acme Billing')],
      billingByOrgId: {
        [ORG_ID]: billingAccount({
          activeUserCount: 2,
          basic: 2,
          status: 'past_due',
          paymentProblem: { code: 'invoice_payment_failed', message: 'Payment issue' },
          customerConfigured: true,
          subscriptionConfigured: true,
          canUseManagedAi: false,
          managedAiBlockingReason: 'payment_failed',
        }),
      },
    });

    await openBilling(page, 'organization');
    await expect(page.locator('#billing-status-chip')).toHaveText('past_due');
    await expect(page.locator('#billing-payment-state')).toHaveText('Payment issue');
    await expect(page.locator('#billing-notice-title')).toHaveText('Managed AI is blocked');
    await expect(page.locator('#billing-managed-ai')).toHaveText('Blocked');

    harness.setBilling(
      ORG_ID,
      billingAccount({
        activeUserCount: 2,
        basic: 2,
        status: 'active',
        customerConfigured: true,
        subscriptionConfigured: true,
        canUseManagedAi: true,
      }),
    );
    await page.goto(`${adminServer.origin}/admin/billing/organization`);
    await expectReady(page);
    await expect(page.locator('#billing-status-chip')).toHaveText('active');
    await expect(page.locator('#billing-payment-state')).toHaveText('Active');
    await expect(page.locator('#billing-managed-ai')).toHaveText('Allowed');
  });

  test('keeps organization admins out of platform billing and lets platform admins switch organizations', async ({ page }) => {
    await installBillingHarness(page, {
      platformAdmin: false,
      organizations: [organization(ORG_ID, 'Acme Billing')],
      billingByOrgId: {
        [ORG_ID]: billingNone({ activeUserCount: 1 }),
      },
    });

    await openBilling(page, 'platform');
    await expect(page.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible();
    await expect(page.locator('#page-eyebrow')).toHaveText('Organization Admin');
    await expect(page.locator('[data-billing-view="platform"]')).toBeDisabled();

    await page.close();

    const platformPage = await page.context().newPage();
    await installBillingHarness(platformPage, {
      platformAdmin: true,
      organizations: [
        organization('org_active', 'Active Co'),
        organization('org_past_due', 'Past Due Co'),
      ],
      billingByOrgId: {
        org_active: billingAccount({ activeUserCount: 1, basic: 2, status: 'active', canUseManagedAi: true }),
        org_past_due: billingAccount({
          activeUserCount: 1,
          basic: 2,
          status: 'past_due',
          paymentProblem: { code: 'invoice_payment_failed', message: 'Payment issue' },
          canUseManagedAi: false,
          managedAiBlockingReason: 'payment_failed',
        }),
      },
    });

    await openBilling(platformPage, 'platform');
    await expect(platformPage.getByRole('heading', { name: 'Organization billing' })).toBeVisible();
    await platformPage.locator('#billing-org-search').fill('past');
    await expect(platformPage.locator('#billing-organization-list')).toContainText('Past Due Co');
    await platformPage.locator('[data-billing-org-id="org_past_due"]').click();
    await expect(platformPage.locator('#billing-target-name')).toHaveText('Past Due Co');
    await expect(platformPage.locator('#billing-status-chip')).toHaveText('past_due');
  });

  test('filters platform billing list by exact payment status', async ({ page }) => {
    await installBillingHarness(page, {
      platformAdmin: true,
      organizations: [
        organization('org_active', 'Active Co'),
        organization('org_past_due', 'Past Due Co'),
        organization('org_unpaid', 'Unpaid Co'),
      ],
      billingByOrgId: {
        org_active: billingAccount({ activeUserCount: 1, basic: 2, status: 'active', canUseManagedAi: true }),
        org_past_due: billingAccount({
          activeUserCount: 1,
          basic: 2,
          status: 'past_due',
          paymentProblem: { code: 'invoice_payment_failed', message: 'Payment issue' },
          canUseManagedAi: false,
          managedAiBlockingReason: 'payment_failed',
        }),
        org_unpaid: billingAccount({
          activeUserCount: 1,
          basic: 0,
          status: 'unpaid',
          canUseManagedAi: false,
          managedAiBlockingReason: 'payment_failed',
        }),
      },
    });

    await openBilling(page, 'platform');
    await page.locator('#billing-status-filter').selectOption('past_due');

    await expect(page.locator('#billing-organization-list')).toContainText('Past Due Co');
    await expect(page.locator('#billing-organization-list')).not.toContainText('Active Co');
    await expect(page.locator('#billing-organization-list')).not.toContainText('Unpaid Co');
  });

  test('shows checkout, portal, and quantity validation errors without changing visible state', async ({ page }) => {
    const harness = await installBillingHarness(page, {
      organizations: [organization(ORG_ID, 'Acme Billing')],
      billingByOrgId: {
        [ORG_ID]: billingNone({ activeUserCount: 2 }),
      },
    });

    await openBilling(page, 'organization');
    await page.locator('#billing-basic-quantity').fill('1.5');
    await page.locator('#billing-update-button').click();
    await expect(page.locator('#billing-action-status')).toHaveText('License quantities must be whole numbers.');

    harness.checkoutMode = 'missing-url';
    await page.locator('#billing-basic-quantity').fill('2');
    await page.locator('#billing-update-button').click();
    await expect(page.locator('#billing-action-status')).toHaveText('Unable to update billing: checkout_url_missing');
    await expect(page.locator('#billing-license-total')).toHaveText('0');

    harness.setBilling(
      ORG_ID,
      billingAccount({
        activeUserCount: 2,
        basic: 2,
        status: 'active',
        customerConfigured: true,
        subscriptionConfigured: true,
        canUseManagedAi: true,
      }),
    );
    await page.goto(`${adminServer.origin}/admin/billing/organization`);
    await expectReady(page);
    harness.portalMode = 'missing-url';
    await page.locator('#billing-portal-button').click();
    await expect(page.locator('#billing-action-status')).toHaveText('Unable to open portal: portal_url_missing');
    await expect(page.locator('#billing-managed-ai')).toHaveText('Allowed');
  });
});

async function openBilling(page: Page, view: 'organization' | 'platform') {
  await page.goto(`${adminServer.origin}/admin/billing/${view}`, { waitUntil: 'domcontentloaded' });
  await expectReady(page);
}

async function expectReady(page: Page) {
  await expect(page.locator('#auth-state')).toHaveText('Signed in');
  await expect(page.locator('#billing-update-button')).toBeVisible();
}

async function installBillingHarness(page: Page, input: {
  platformAdmin?: boolean;
  organizations: TestOrganization[];
  billingByOrgId: Record<string, BillingPayload>;
}) {
  const state = {
    platformAdmin: input.platformAdmin === true,
    organizations: input.organizations,
    billingByOrgId: { ...input.billingByOrgId },
    checkoutMode: 'ok' as 'ok' | 'missing-url' | 'error',
    portalMode: 'ok' as 'ok' | 'missing-url' | 'error',
    checkoutRequests: [] as unknown[],
    portalRequests: [] as unknown[],
    planRequests: [] as unknown[],
  };

  await page.addInitScript(([storageKey, token]) => {
    window.localStorage.setItem(storageKey, token);
  }, [ADMIN_TOKEN_STORAGE_KEY, TEST_TOKEN]);

  await page.route('https://checkout.stripe.test/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><h1>Stripe Checkout</h1></body></html>',
    });
  });
  await page.route('https://portal.stripe.test/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><h1>Stripe Customer Portal</h1></body></html>',
    });
  });
  await page.route(`${adminServer.origin}/admin/api/**`, async (route) => {
    await handleAdminApi(route, state);
  });

  return {
    get checkoutRequests() {
      return state.checkoutRequests;
    },
    get portalRequests() {
      return state.portalRequests;
    },
    get planRequests() {
      return state.planRequests;
    },
    set checkoutMode(value: typeof state.checkoutMode) {
      state.checkoutMode = value;
    },
    set portalMode(value: typeof state.portalMode) {
      state.portalMode = value;
    },
    setBilling(orgId: string, billing: BillingPayload) {
      state.billingByOrgId[orgId] = billing;
    },
  };
}

async function handleAdminApi(
  route: Route,
  state: {
    platformAdmin: boolean;
    organizations: TestOrganization[];
    billingByOrgId: Record<string, BillingPayload>;
    checkoutMode: 'ok' | 'missing-url' | 'error';
    portalMode: 'ok' | 'missing-url' | 'error';
    checkoutRequests: unknown[];
    portalRequests: unknown[];
    planRequests: unknown[];
  },
) {
  const request = route.request();
  const url = new URL(request.url());
  const apiPath = decodeURIComponent(url.pathname.replace('/admin/api', ''));

  if (apiPath === '/session') {
    await fulfillJson(route, 200, {
      user: {
        id: state.platformAdmin ? 'user_platform' : 'user_org_admin',
        email: state.platformAdmin ? 'platform@example.test' : 'org-admin@example.test',
        name: state.platformAdmin ? 'Platform Admin' : 'Org Admin',
      },
      platformAdmin: state.platformAdmin,
      activeOrgId: state.organizations[0]?.id ?? null,
      organizations: state.organizations,
      capabilities: state.platformAdmin
        ? ['organization', 'users', 'billing', 'credentials', 'sessions', 'usage', 'alerts', 'audit']
        : ['organization', 'users', 'billing'],
      allowedPages: state.platformAdmin
        ? ['overview', 'organization', 'users', 'billing', 'credentials', 'sessions', 'usage', 'alerts', 'audit']
        : ['overview', 'organization', 'users', 'billing'],
    });
    return;
  }

  if (apiPath === '/users') {
    await fulfillJson(route, 200, { users: usersForOrganizations(state.organizations, state.platformAdmin) });
    return;
  }

  if (['/credentials', '/sessions', '/alerts', '/audit', '/usage'].includes(apiPath)) {
    await fulfillJson(route, 501, { error: 'not_implemented' });
    return;
  }

  const billingMatch = apiPath.match(/^\/organizations\/([^/]+)\/billing(?:\/([^/]+))?$/);
  if (billingMatch) {
    const orgId = billingMatch[1];
    const action = billingMatch[2] ?? '';
    const billing = state.billingByOrgId[orgId];
    if (!billing) {
      await fulfillJson(route, 404, { error: 'organization_not_found' });
      return;
    }

    if (request.method() === 'GET' && !action) {
      await fulfillJson(route, 200, { billing });
      return;
    }

    if (request.method() === 'POST' && action === 'checkout') {
      if (state.checkoutMode === 'error') {
        await fulfillJson(route, 503, { error: 'stripe_billing_disabled' });
        return;
      }
      const body = request.postDataJSON();
      state.checkoutRequests.push(body);
      await fulfillJson(route, 200, {
        checkout: state.checkoutMode === 'missing-url'
          ? { id: 'cs_missing', url: null }
          : { id: `cs_${orgId}`, url: `https://checkout.stripe.test/session/${orgId}` },
      });
      return;
    }

    if (request.method() === 'POST' && action === 'portal') {
      if (state.portalMode === 'error') {
        await fulfillJson(route, 503, { error: 'stripe_customer_required' });
        return;
      }
      state.portalRequests.push({});
      await fulfillJson(route, 200, {
        portal: state.portalMode === 'missing-url'
          ? { id: 'bps_missing', url: null }
          : { id: `bps_${orgId}`, url: `https://portal.stripe.test/session/${orgId}` },
      });
      return;
    }

    if (request.method() === 'PATCH' && action === 'plan') {
      const body = request.postDataJSON() as { quantities?: BillingQuantities };
      const quantities = body.quantities ?? { managedAiBasic: 0, managedAiExtended: 0 };
      if (quantities.managedAiBasic + quantities.managedAiExtended < billing.activeUserCount) {
        await fulfillJson(route, 409, {
          error: 'requested_license_limit_below_active_users',
          details: {
            requestedLicenseLimit: quantities.managedAiBasic + quantities.managedAiExtended,
            activeUserCount: billing.activeUserCount,
          },
        });
        return;
      }

      state.planRequests.push(body);
      state.billingByOrgId[orgId] = billingAccount({
        activeUserCount: billing.activeUserCount,
        basic: quantities.managedAiBasic,
        extended: quantities.managedAiExtended,
        interval: billing.account?.billingInterval === 'annual' ? 'annual' : 'monthly',
        status: 'active',
        customerConfigured: true,
        subscriptionConfigured: true,
        canUseManagedAi: true,
      });
      await fulfillJson(route, 200, { billing: state.billingByOrgId[orgId] });
      return;
    }
  }

  await fulfillJson(route, 404, { error: 'not_found' });
}

function billingNone(input: { activeUserCount: number }): BillingPayload {
  return {
    account: null,
    entitlement: {
      mode: 'none',
      effectiveMode: 'none',
      status: 'none',
      canUseManagedAi: false,
      canUseByokOrLocalProvider: false,
      canReadHistory: true,
      licenseLimit: 0,
      activeUserCount: input.activeUserCount,
      isInGracePeriod: false,
      warning: null,
      managedAiBlockingReason: 'payment_required',
      byokOrLocalProviderBlockingReason: 'payment_required',
    },
    activeUserCount: input.activeUserCount,
    licenseLimit: 0,
  };
}

function billingAccount(input: {
  activeUserCount: number;
  basic?: number;
  extended?: number;
  interval?: 'monthly' | 'annual';
  status?: 'active' | 'trialing' | 'past_due' | 'unpaid' | 'canceled' | 'incomplete';
  source?: string;
  paymentProblem?: { code: string; message: string } | null;
  cancelAtPeriodEnd?: boolean;
  customerConfigured?: boolean;
  subscriptionConfigured?: boolean;
  canUseManagedAi?: boolean;
  managedAiBlockingReason?: string | null;
}): BillingPayload {
  const basic = input.basic ?? 0;
  const extended = input.extended ?? 0;
  const licenseLimit = basic + extended;
  const status = input.status ?? 'active';
  const canUseManagedAi = input.canUseManagedAi ?? false;
  const blockingReason = input.managedAiBlockingReason ?? (canUseManagedAi ? null : 'payment_required');

  return {
    account: {
      mode: 'managed_ai',
      source: input.source ?? 'stripe_subscription',
      status,
      billingInterval: input.interval ?? 'monthly',
      quantities: {
        managedAiBasic: basic,
        managedAiExtended: extended,
        localModels: 0,
      },
      stripe: {
        customerConfigured: input.customerConfigured ?? true,
        subscriptionConfigured: input.subscriptionConfigured ?? true,
      },
      paymentProblem: input.paymentProblem ?? null,
      cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
      updatedAt: '2026-07-03T08:00:00.000Z',
    },
    entitlement: {
      mode: 'managed_ai',
      effectiveMode: 'managed_ai',
      status,
      canUseManagedAi,
      canUseByokOrLocalProvider: canUseManagedAi,
      canReadHistory: true,
      licenseLimit,
      activeUserCount: input.activeUserCount,
      isInGracePeriod: false,
      warning: null,
      managedAiBlockingReason: blockingReason,
      byokOrLocalProviderBlockingReason: blockingReason,
    },
    activeUserCount: input.activeUserCount,
    licenseLimit,
  };
}

function organization(id: string, name: string): TestOrganization {
  return {
    id,
    name,
    slug: id.replace(/^org_/, ''),
  };
}

function usersForOrganizations(organizations: TestOrganization[], platformAdmin: boolean) {
  const users = organizations.flatMap((org, orgIndex) => [
    {
      id: `user_${org.id}_admin`,
      email: `${org.slug}.admin@example.test`,
      name: `${org.name} Admin`,
      disabled: false,
      platformAdmin: platformAdmin && orgIndex === 0,
      memberships: [
        {
          orgId: org.id,
          orgName: org.name,
          orgSlug: org.slug,
          role: 'organization_admin',
          status: 'active',
        },
      ],
    },
  ]);

  if (organizations[0]) {
    users.push({
      id: `user_${organizations[0].id}_member`,
      email: `${organizations[0].slug}.member@example.test`,
      name: `${organizations[0].name} Member`,
      disabled: false,
      platformAdmin: false,
      memberships: [
        {
          orgId: organizations[0].id,
          orgName: organizations[0].name,
          orgSlug: organizations[0].slug,
          role: 'member',
          status: 'active',
        },
      ],
    });
  }

  return users;
}

async function fulfillJson(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function startStaticAdminServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    const assetPath =
      pathname === '/admin/app.js' ? join(ADMIN_PUBLIC_ROOT, 'app.js') :
      pathname === '/admin/app.css' ? join(ADMIN_PUBLIC_ROOT, 'app.css') :
      join(ADMIN_PUBLIC_ROOT, 'index.html');

    try {
      const body = await readFile(assetPath);
      res.writeHead(200, { 'content-type': contentTypeFor(assetPath) });
      res.end(body);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(error instanceof Error ? error.message : 'static admin fixture failed');
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, server };
}

async function closeServer(server: Server) {
  server.close();
  await once(server, 'close');
}

function contentTypeFor(path: string) {
  switch (extname(path)) {
    case '.css':
      return 'text/css';
    case '.js':
      return 'application/javascript';
    case '.html':
      return 'text/html';
    default:
      return 'application/octet-stream';
  }
}

type TestOrganization = {
  id: string;
  name: string;
  slug: string;
};

type BillingQuantities = {
  managedAiBasic: number;
  managedAiExtended: number;
};

type BillingPayload = {
  account: null | {
    mode: string;
    source: string;
    status: string;
    billingInterval: string;
    quantities: BillingQuantities & { localModels: number };
    stripe: {
      customerConfigured: boolean;
      subscriptionConfigured: boolean;
    };
    paymentProblem: null | { code: string; message: string };
    cancelAtPeriodEnd: boolean;
    updatedAt: string;
  };
  entitlement: {
    mode: string;
    effectiveMode: string;
    status: string;
    canUseManagedAi: boolean;
    canUseByokOrLocalProvider: boolean;
    canReadHistory: boolean;
    licenseLimit: number;
    activeUserCount: number;
    isInGracePeriod: boolean;
    warning: string | null;
    managedAiBlockingReason: string | null;
    byokOrLocalProviderBlockingReason: string | null;
  };
  activeUserCount: number;
  licenseLimit: number;
};
