import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';

const ADMIN_BASE = normalizeBase(process.env.VESLO_E2E_DEN_ADMIN_BASE ?? 'http://127.0.0.1:8788');
const ORG_ADMIN_EMAIL = process.env.VESLO_E2E_DEN_ORG_ADMIN_EMAIL ?? 'org.admin@example.com';
const ORG_ADMIN_PASSWORD = process.env.VESLO_E2E_DEN_ORG_ADMIN_PASSWORD ?? 'VesloOrg123!';
const BILLING_ORG_ID = process.env.VESLO_E2E_DEN_BILLING_ORG_ID ?? '';
const DEN_DB_CONTAINER = process.env.VESLO_E2E_DEN_DB_CONTAINER ?? '';

test.describe('Den admin billing live Stripe sandbox', () => {
  test.skip(process.env.VESLO_E2E_STRIPE_SANDBOX_LIVE !== '1', 'set VESLO_E2E_STRIPE_SANDBOX_LIVE=1 to create Stripe test-mode subscriptions');
  test.setTimeout(180_000);

  test.beforeEach(async ({ request }) => {
    const health = await request.get(`${ADMIN_BASE}/health`);
    expect(health.ok(), `Expected Den backend health check to pass at ${ADMIN_BASE}/health`).toBe(true);
    resetLocalBillingState();
  });

  test('org admin buys a subscription through Stripe Checkout and Den updates from the webhook', async ({ page }) => {
    await page.goto(`${ADMIN_BASE}/admin/billing/organization`, { waitUntil: 'domcontentloaded' });
    await signIn(page, ORG_ADMIN_EMAIL, ORG_ADMIN_PASSWORD);

    await expect(page.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible();
    await expect(page.locator('#billing-update-button')).toHaveText('Start checkout');
    await expect(page.locator('#billing-managed-ai')).toHaveText('Blocked');

    await page.locator('#billing-basic-quantity').fill('2');
    await Promise.all([
      page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 }),
      page.locator('#billing-update-button').click(),
    ]);

    await completeStripeCheckout(page);

    expect(new URL(page.url()).origin).toBe(new URL(ADMIN_BASE).origin);
    await expect(page.locator('#auth-state')).toHaveText('Signed in', { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#auth-state')).toHaveText('Signed in', { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible();

    await expect.poll(async () => {
      const billingResponse = page.waitForResponse((response) =>
        response.url().includes('/organizations/') &&
        response.url().endsWith('/billing') &&
        response.status() === 200,
      { timeout: 10_000 }).catch(() => null);
      await page.goto(`${ADMIN_BASE}/admin/billing/organization`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('#auth-state')).toHaveText('Signed in');
      await billingResponse;
      return {
        managedAi: await page.locator('#billing-managed-ai').textContent(),
        licenses: await page.locator('#billing-license-total').textContent(),
        status: await page.locator('#billing-status-chip').textContent(),
      };
    }, {
      intervals: [1_000, 2_000, 3_000, 5_000],
      timeout: 45_000,
    }).toEqual({
      managedAi: 'Allowed',
      licenses: '2',
      status: 'active',
    });

    await page.locator('#billing-basic-quantity').fill('3');
    await page.locator('#billing-update-button').click();
    await expect(page.locator('#billing-action-status')).toHaveText('Subscription quantities updated.', { timeout: 30_000 });

    await expect.poll(async () => {
      const billingResponse = page.waitForResponse((response) =>
        response.url().includes('/organizations/') &&
        response.url().endsWith('/billing') &&
        response.status() === 200,
      { timeout: 10_000 }).catch(() => null);
      await page.goto(`${ADMIN_BASE}/admin/billing/organization`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('#auth-state')).toHaveText('Signed in');
      await billingResponse;
      return {
        managedAi: await page.locator('#billing-managed-ai').textContent(),
        licenses: await page.locator('#billing-license-total').textContent(),
        status: await page.locator('#billing-status-chip').textContent(),
      };
    }, {
      intervals: [1_000, 2_000, 3_000, 5_000],
      timeout: 45_000,
    }).toEqual({
      managedAi: 'Allowed',
      licenses: '3',
      status: 'active',
    });
  });
});

async function completeStripeCheckout(page: Page) {
  await fillFirstVisible(page, [
    page.getByLabel(/email/i),
    page.locator('input[name="email"]'),
  ], `veslo-stripe-${Date.now()}@example.com`);

  await openStripeCardPaymentMethod(page);

  await fillFirstVisible(page, [
    page.getByLabel(/card number/i),
    page.locator('input[name="cardNumber"]'),
    page.locator('input[name="cardnumber"]'),
    page.frameLocator('iframe').getByLabel(/card number/i),
    page.frameLocator('iframe').locator('input[name="cardNumber"]'),
    page.frameLocator('iframe').locator('input[name="cardnumber"]'),
  ], '4242424242424242');
  await fillFirstVisible(page, [
    page.getByLabel(/expiration/i),
    page.getByLabel(/expiry/i),
    page.locator('input[name="cardExpiry"]'),
    page.locator('input[name="exp-date"]'),
    page.frameLocator('iframe').getByLabel(/expiration/i),
    page.frameLocator('iframe').locator('input[name="cardExpiry"]'),
    page.frameLocator('iframe').locator('input[name="exp-date"]'),
  ], '1234');
  await fillFirstVisible(page, [
    page.getByLabel(/cvc/i),
    page.locator('input[name="cardCvc"]'),
    page.locator('input[name="cvc"]'),
    page.frameLocator('iframe').getByLabel(/cvc/i),
    page.frameLocator('iframe').locator('input[name="cardCvc"]'),
    page.frameLocator('iframe').locator('input[name="cvc"]'),
  ], '123');
  await fillFirstVisible(page, [
    page.getByLabel(/cardholder name/i),
    page.locator('input[name="billingName"]'),
  ], 'Veslo Test Buyer', { optional: true });
  await fillFirstVisible(page, [
    page.getByLabel(/country/i),
    page.locator('select[name="billingCountry"]'),
  ], 'CZ', { optional: true });
  await acknowledgeStripeAgentCheckout(page);

  const hostedPayButton = page.locator('button[data-testid="hosted-payment-submit-button"]').first();
  const payButton = await hostedPayButton.count() > 0
    ? hostedPayButton
    : page.getByRole('button', { name: /pay|subscribe|start trial|confirm/i }).first();
  await expect(payButton).toBeEnabled({ timeout: 30_000 });
  await Promise.all([
    page.waitForURL(/\/admin\/billing/, { timeout: 120_000 }),
    payButton.click(),
  ]);
}

async function openStripeCardPaymentMethod(page: Page) {
  const cardNumber = page.locator('input[name="cardNumber"], input[name="cardnumber"]');
  if (await cardNumber.first().isVisible().catch(() => false)) {
    return;
  }

  const cardAccordionButton = page.locator('button[data-testid="card-accordion-item-button"]')
    .or(page.getByRole('button', { name: /^pay with card$/i }))
    .first();
  await cardAccordionButton.waitFor({ state: 'attached', timeout: 15_000 });
  await cardAccordionButton.evaluate((button) => {
    if (!(button instanceof HTMLElement)) {
      throw new Error('stripe_card_button_not_html_element');
    }
    button.click();
  });
  await expect(cardNumber.first()).toBeVisible({ timeout: 15_000 });
}

async function acknowledgeStripeAgentCheckout(page: Page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.evaluate(() => {
      const agentCheckboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'))
        .filter((input): input is HTMLInputElement =>
          input instanceof HTMLInputElement && input.name !== 'enableStripePass',
        );
      for (const checkbox of agentCheckboxes) {
        if (!checkbox.checked) {
          checkbox.click();
        }
      }
    });
    await page.waitForTimeout(500);
  }
}

async function fillFirstVisible(
  page: Page,
  locators: Array<ReturnType<Page['locator']>>,
  value: string,
  options: { optional?: boolean } = {},
) {
  for (const locator of locators) {
    const candidate = locator.first();
    try {
      await candidate.waitFor({ state: 'visible', timeout: 2_000 });
      const tagName = await candidate.evaluate((node) => node.tagName.toLowerCase());
      if (tagName === 'select') {
        await candidate.selectOption(value);
      } else {
        await candidate.fill(value);
      }
      return;
    } catch {
      // Try the next known Stripe Checkout selector.
    }
  }

  if (!options.optional) {
    throw new Error(`Unable to fill Stripe Checkout field with value marker ${value.slice(0, 4)}`);
  }
}

async function signIn(page: Page, email: string, password: string) {
  await expect(page.locator('#admin-login-email')).toBeVisible();
  await page.locator('#admin-login-email').fill(email);
  await page.locator('#admin-login-password').fill(password);
  await page.locator('#admin-login-submit').click();
  await expect(page.locator('#auth-state')).toHaveText('Signed in');
}

function resetLocalBillingState() {
  if (!DEN_DB_CONTAINER || !BILLING_ORG_ID) {
    return;
  }

  const sql = [
    'DELETE FROM organization_billing_event WHERE org_id = ?;',
    'DELETE FROM organization_billing_account WHERE org_id = ?;',
  ].join(' ');
  execFileSync('docker', [
    'exec',
    '-i',
    DEN_DB_CONTAINER,
    'mysql',
    '-uden',
    '-pden',
    'den',
    '--execute',
    sql.replaceAll('?', `'${BILLING_ORG_ID.replaceAll("'", "''")}'`),
  ], { stdio: 'pipe' });
}

function normalizeBase(value: string) {
  return value.trim().replace(/\/+$/, '');
}
