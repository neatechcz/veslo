import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

const ADMIN_BASE = normalizeBase(process.env.VESLO_E2E_DEN_ADMIN_BASE ?? 'http://127.0.0.1:8788');
const PLATFORM_EMAIL = process.env.VESLO_E2E_DEN_PLATFORM_ADMIN_EMAIL ?? 'vaclav.soukup@neotech.cz';
const PLATFORM_PASSWORD = process.env.VESLO_E2E_DEN_PLATFORM_ADMIN_PASSWORD ?? 'VesloAdmin123!';
const ORG_ADMIN_EMAIL = process.env.VESLO_E2E_DEN_ORG_ADMIN_EMAIL ?? 'org.admin@example.com';
const ORG_ADMIN_PASSWORD = process.env.VESLO_E2E_DEN_ORG_ADMIN_PASSWORD ?? 'VesloOrg123!';

test.describe('Integrated Den admin billing UI', () => {
  test.beforeEach(async ({ request }) => {
    const health = await request.get(`${ADMIN_BASE}/health`);
    expect(health.ok(), `Expected Den backend health check to pass at ${ADMIN_BASE}/health`).toBe(true);
  });

  test('platform admin can sign in, inspect billing, and navigate to users', async ({ page }, testInfo) => {
    const errors = collectConsoleErrors(page);

    await page.goto(`${ADMIN_BASE}/admin/billing/platform`, { waitUntil: 'domcontentloaded' });
    await signIn(page, PLATFORM_EMAIL, PLATFORM_PASSWORD);

    await expect(page.getByRole('heading', { name: 'Organization billing' })).toBeVisible();
    await expect(page.locator('#page-eyebrow')).toHaveText('Platform Admin');
    await expect(page.locator('#auth-user')).toContainText('platform admin');
    await expect(page.locator('[data-billing-view="platform"]')).toHaveClass(/active/);
    await expect(page.locator('#billing-organization-list')).toContainText(/Vaclav|Organization|No organizations/);
    await expect(page.getByRole('button', { name: 'Stop renewal' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Revoke access now' })).toBeVisible();
    await expectVisibleNav(page, [
      'Overview',
      'Organization',
      'Users',
      'Billing',
      'Credentials',
      'Sessions',
      'Usage',
      'Alerts',
      'Audit',
    ]);
    await screenshot(page, testInfo, 'platform-billing');

    await page.getByRole('link', { name: 'Users' }).click();
    await expect(page).toHaveURL(`${ADMIN_BASE}/admin/users`);
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
    await expect(page.locator('#user-list')).toContainText(PLATFORM_EMAIL);
    await expect(page.locator('#user-list')).toContainText(ORG_ADMIN_EMAIL);
    await screenshot(page, testInfo, 'platform-users');

    expect(errors.filter((entry) => !isExpectedLocalOptionalEndpointError(entry))).toEqual([]);
  });

  test('organization admin sees only organization-scoped billing and users', async ({ page }, testInfo) => {
    const errors = collectConsoleErrors(page);

    await page.goto(`${ADMIN_BASE}/admin/billing/platform`, { waitUntil: 'domcontentloaded' });
    await signIn(page, ORG_ADMIN_EMAIL, ORG_ADMIN_PASSWORD);

    await expect(page.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible();
    await expect(page.locator('#page-eyebrow')).toHaveText('Organization Admin');
    await expect(page.locator('#auth-user')).toContainText('organization admin');
    await expect(page.locator('[data-billing-view="platform"]')).toBeDisabled();
    await expect(page.locator('#billing-notice-title')).toContainText('Billing is not configured');
    await expect(page.locator('#billing-managed-ai')).toHaveText('Blocked');
    await expectVisibleNav(page, ['Overview', 'Organization', 'Users', 'Billing']);
    await expect(page.getByRole('link', { name: 'Credentials' })).toBeHidden();
    await screenshot(page, testInfo, 'org-admin-billing');

    await page.getByRole('link', { name: 'Users' }).click();
    await expect(page).toHaveURL(`${ADMIN_BASE}/admin/users`);
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
    await expect(page.locator('#user-list')).toContainText(ORG_ADMIN_EMAIL);
    await expect(page.getByRole('link', { name: 'Credentials' })).toBeHidden();
    await screenshot(page, testInfo, 'org-admin-users');

    expect(errors.filter((entry) => !isExpectedLocalOptionalEndpointError(entry))).toEqual([]);
  });

  test('browser sign-in button starts the desktop auth handoff instead of being inert', async ({ page }, testInfo) => {
    const errors = collectConsoleErrors(page);

    await page.goto(`${ADMIN_BASE}/admin/billing/platform`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'Sign in with Browser' })).toBeVisible();

    await page.getByRole('button', { name: 'Sign in with Browser' }).click();
    await page.waitForURL(/desktopOnboarding=1/, { timeout: 10_000 });
    await expect(page).toHaveURL(/127\.0\.0\.1:8788\/\?desktopOnboarding=1/);
    await expect(page.locator('body')).toContainText(/Sign in|Email/i);
    await screenshot(page, testInfo, 'browser-handoff');

    expect(errors.filter((entry) => !isExpectedLocalOptionalEndpointError(entry))).toEqual([]);
  });
});

async function signIn(page: Page, email: string, password: string) {
  await expect(page.locator('#admin-login-email')).toBeVisible();
  await page.locator('#admin-login-email').fill(email);
  await page.locator('#admin-login-password').fill(password);
  await page.locator('#admin-login-submit').click();
  await expect(page.locator('#auth-state')).toHaveText('Signed in');
}

async function expectVisibleNav(page: Page, expected: string[]) {
  await expect.poll(async () => {
    return (await page.locator('.nav-item:not(.hidden)').allTextContents())
      .map((entry) => entry.trim())
      .filter(Boolean);
  }).toEqual(expected);
}

function collectConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  return errors;
}

function isExpectedLocalOptionalEndpointError(message: string) {
  return message.includes('501 (Not Implemented)');
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}

function normalizeBase(value: string) {
  return value.trim().replace(/\/+$/, '');
}
