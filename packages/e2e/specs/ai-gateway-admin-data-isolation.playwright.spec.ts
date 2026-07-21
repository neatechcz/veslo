import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Route } from '@playwright/test';

const ADMIN_TOKEN_STORAGE_KEY = 'veslo.ai-gateway.admin.token';
const TEST_TOKEN = 'admin-data-isolation-token';
const SPEC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SPEC_DIR, '../../..');
const ADMIN_PUBLIC_ROOT = join(REPO_ROOT, 'services/ai-gateway/public-admin');

const ORG_A_SLUG_MARKER = 'ORGANIZATION-A-PRIVATE-SLUG-MARKER';
const ORG_A = organization('org-a', 'ORGANIZATION-A-NAME', ORG_A_SLUG_MARKER, 11_001);
const ORG_B = organization('org-b', 'ORGANIZATION-B-NAME', 'organization-b', 22_002);
const GLOBAL_USERS = [
  globalUser('global-alice', 'GLOBAL-ALICE', 'global-alice@example.test', ORG_A, true),
  globalUser('global-bob', 'GLOBAL-BOB', 'global-bob@example.test', ORG_B, false),
];
const ORG_MEMBERS = {
  [ORG_A.id]: [
    organizationMember('membership-a', 'org-a/user@example.test', 'ORG-A-ALICE', 'org-a-alice@example.test'),
    organizationMember('membership-a-second', 'org-a-second', 'ORG-A-SECOND', 'org-a-second@example.test'),
  ],
  [ORG_B.id]: [organizationMember('membership-b', 'org-b-bob', 'ORG-B-BOB', 'org-b-bob@example.test')],
};

let adminServer: { origin: string; server: Server };
const unexpectedPageErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  unexpectedPageErrors.set(page, errors);
  page.on('pageerror', (error) => {
    errors.push(error.stack || error.message);
  });
});

test.afterEach(async ({ page }) => {
  expect(unexpectedPageErrors.get(page) || [], 'unexpected browser page errors').toEqual([]);
});

test.beforeAll(async () => {
  adminServer = await startStaticAdminServer();
});

test.afterAll(async () => {
  await closeServer(adminServer.server);
});

test.describe('AI Gateway admin data isolation', () => {
  test('negative control proves the frame and mutation leak observer detects visible and semantic stale data', async ({ page }) => {
    const harness = await installAdminHarness(page);
    await openAdmin(page, '/admin/platform-users');
    await expect(page.locator('#user-list').getByText('GLOBAL-ALICE', { exact: true })).toBeVisible();

    await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'leak-observer-negative-control';
      button.textContent = 'Inject controlled leak';
      button.addEventListener('click', () => {
        const leak = document.createElement('p');
        leak.id = 'controlled-leak';
        leak.textContent = 'CONTROLLED-FORBIDDEN-TEXT';
        document.body.append(leak);
      });
      document.body.append(button);
    });

    await armLeakObserver(page, ['CONTROLLED-FORBIDDEN-TEXT'], 'click');
    await page.locator('#leak-observer-negative-control').click();
    await expect.poll(() => leakRecords(page)).not.toEqual([]);
    const records = await stopLeakObserver(page);

    expect(records.some((record) => record.token === 'CONTROLLED-FORBIDDEN-TEXT')).toBe(true);
    expect(records.some((record) => record.channel === 'visible')).toBe(true);
    expect(records.some((record) => record.channel === 'semantic')).toBe(true);
    expect(harness.records.some((record) => record.path === '/admin/api/users')).toBe(true);
  });

  test('negative control proves the observer detects semantic-only stale data outside visible text', async ({ page }) => {
    await installAdminHarness(page);
    await openAdmin(page, '/admin/platform-users');

    await page.evaluate(() => {
      const trigger = document.createElement('button');
      trigger.id = 'semantic-leak-observer-negative-control';
      trigger.textContent = 'Inject semantic-only leak';
      trigger.addEventListener('click', () => {
        const leak = document.createElement('button');
        leak.id = 'controlled-semantic-leak';
        leak.textContent = 'Unrelated visible action';
        leak.setAttribute('aria-label', 'CONTROLLED-SEMANTIC-ONLY');
        document.body.append(leak);
      });
      document.body.append(trigger);
    });

    await armLeakObserver(page, ['CONTROLLED-SEMANTIC-ONLY'], 'click');
    await page.locator('#semantic-leak-observer-negative-control').click();
    await waitAnimationFrames(page, 2);
    const records = await stopLeakObserver(page);

    await expect(page.locator('body')).not.toContainText('CONTROLLED-SEMANTIC-ONLY');
    expect(records.some((record) => record.token === 'CONTROLLED-SEMANTIC-ONLY')).toBe(true);
    expect(records.some((record) => record.channel === 'semantic')).toBe(true);
    expect(records.some((record) => record.channel === 'visible')).toBe(false);
  });

  test('initial shell is fail closed and never exposes the removed sample metrics, people, incidents, audit, or chart data', async ({ page }) => {
    const harness = await installAdminHarness(page);
    const session = harness.delayNext('GET', '/admin/api/session');

    await page.goto(`${adminServer.origin}/admin`, { waitUntil: 'domcontentloaded' });
    await session.arrived;

    await expect(page.locator('#admin-page-state')).toHaveAttribute('data-state', 'loading');
    await expect(page.locator('#admin-page-state')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#admin-page-loading')).toHaveText('Loading data...');
    await expect(page.locator('#admin-page-skeleton')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#user-list')).toBeEmpty();
    await expect(page.locator('#alert-list')).toBeEmpty();
    await expect(page.locator('#audit-list')).toBeEmpty();
    await expect(page.locator('#usage-chart-bars')).toBeEmpty();

    const removedSeedText = [
      '2 credential alerts',
      '821k',
      '412k',
      'OpenAI org key',
      'Credential outage',
      'Usage spike',
      'Vaclav Soukup',
      'Václav Soukup',
      'Alena Novak',
      'Martin Kriz',
      'alena@studio.test',
    ];
    const documentText = await page.locator('body').textContent();
    for (const marker of removedSeedText) {
      expect(documentText).not.toContain(marker);
    }
    await expect(page.locator('[data-page="overview"] .hero-metrics strong')).toHaveText(['', '', '']);

    session.release(harness.responseFor('GET', '/admin/api/session'));
    await expect(page.locator('#auth-state')).toHaveText('Signed in');
  });

  test('Platform Users to organization Members clears global users synchronously and reveals only scoped members atomically', async ({ page }) => {
    const harness = await installAdminHarness(page);
    await openAdmin(page, '/admin/platform-users');
    const globalRequestCount = requestCount(harness.records, 'GET', '/admin/api/users');

    await armLeakObserver(page, ['GLOBAL-ALICE', 'GLOBAL-BOB'], 'click');
    await page.locator('[data-platform-route="organizations"]').click();
    await expect(page.locator('[data-user-id="global-alice"]')).toHaveCount(0);
    await expect(page.locator('[data-user-id="global-bob"]')).toHaveCount(0);
    await waitForPageReady(page);

    await page.locator(`[data-enter-organization-id="${ORG_A.id}"]`).click();
    await waitForPageReady(page);

    const organizationRequest = harness.delayNext('GET', `/admin/api/organizations/${ORG_A.id}`);
    const membersRequest = harness.delayNext('GET', `/admin/api/organizations/${ORG_A.id}/members`);
    await page.locator('[data-organization-route="members"]').click();
    await Promise.all([organizationRequest.arrived, membersRequest.arrived]);

    await expect(page.locator('#admin-page-state')).toHaveAttribute('data-state', 'loading');
    await expect(page.locator('#admin-page-state')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#admin-page-loading')).toHaveText('Loading data...');
    await expect(page.locator('#admin-page-skeleton')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#admin-page-skeleton')).toBeVisible();
    await expect(page.locator('#user-list')).toBeEmpty();
    await expect(page.locator('#admin-page-skeleton [data-user-id]')).toHaveCount(0);

    organizationRequest.release(harness.responseFor('GET', `/admin/api/organizations/${ORG_A.id}`));
    await expect(page.locator('#user-list')).toBeEmpty();
    membersRequest.release(harness.responseFor('GET', `/admin/api/organizations/${ORG_A.id}/members`));
    await waitForPageReady(page);

    await expect(page.locator('#user-list').getByText('ORG-A-ALICE', { exact: true })).toBeVisible();
    await expect(page.locator('#user-list')).not.toContainText('GLOBAL-ALICE');
    await expect(page.locator('#user-list')).not.toContainText('GLOBAL-BOB');
    expect(await stopLeakObserver(page)).toEqual([]);
    expect(requestCount(harness.records, 'GET', '/admin/api/users')).toBe(globalRequestCount);
  });

  test('organization A to B Members removes A in the initiating event and ignores accessible or visible stale frames', async ({ page }) => {
    const harness = await installAdminHarness(page);
    await openAdmin(page, `/admin/organizations/${ORG_A.id}/members`);
    await expect(page.locator('#user-list').getByText('ORG-A-ALICE', { exact: true })).toBeVisible();

    const organizationRequest = harness.delayNext('GET', `/admin/api/organizations/${ORG_B.id}`);
    const membersRequest = harness.delayNext('GET', `/admin/api/organizations/${ORG_B.id}/members`);
    await armLeakObserver(page, ['ORG-A-ALICE', 'org-a-alice@example.test'], 'change');
    await switchOrganization(page, ORG_B);

    await expect(page.locator('[data-user-id="org-a/user@example.test"]')).toHaveCount(0);
    await expect(page.locator('#user-list')).toBeEmpty();
    await Promise.all([organizationRequest.arrived, membersRequest.arrived]);
    organizationRequest.release(harness.responseFor('GET', `/admin/api/organizations/${ORG_B.id}`));
    await expect(page.locator('#user-list')).toBeEmpty();
    await expect(page.locator('#user-list')).not.toContainText('ORG-B-BOB');
    membersRequest.release(harness.responseFor('GET', `/admin/api/organizations/${ORG_B.id}/members`));
    await waitForPageReady(page);

    await expect(page).toHaveURL(new RegExp(`/admin/organizations/${ORG_B.id}/members$`));
    await expect(page.locator('#user-list').getByText('ORG-B-BOB', { exact: true })).toBeVisible();
    expect(await stopLeakObserver(page)).toEqual([]);
  });

  test('readiness delay and failure do not gate route requests or reveal, and an abandoned users response stays inert', async ({ page }) => {
    const harness = await installAdminHarness(page);
    const readiness = harness.delayNext('GET', '/readiness');
    const users = harness.delayNext('GET', '/admin/api/users');

    await page.goto(`${adminServer.origin}/admin/platform-users`, { waitUntil: 'domcontentloaded' });
    const [readinessRecord, usersRecord] = await Promise.all([readiness.arrived, users.arrived]);
    expect(readinessRecord.sequence).toBeLessThan(usersRecord.sequence);
    users.release(harness.responseFor('GET', '/admin/api/users'));
    await waitForPageReady(page);
    await expect(page.locator('#user-list')).toContainText('GLOBAL-ALICE');

    readiness.release(json(503, { ok: false, status: 'not_ready' }));
    await expect(page.locator('#readiness-label')).toHaveText('Inference unavailable');

    await page.locator('[data-platform-route="organizations"]').click();
    await waitForPageReady(page);
    const lateUsers = harness.delayNext('GET', '/admin/api/users');
    await page.locator('[data-platform-route="platform-users"]').click();
    await lateUsers.arrived;
    await page.locator('[data-platform-route="organizations"]').click();
    await waitForPageReady(page);
    lateUsers.release(harness.responseFor('GET', '/admin/api/users'));
    await waitAnimationFrames(page, 3);

    await expect(page.locator('#page-title')).toHaveText('Organizations');
    await expect(page.locator('#user-list')).toBeEmpty();
    await expect(page.locator('[data-user-id="global-alice"]')).toHaveCount(0);
  });

  test('platform admin organization slug stays server-side across overview save and directory rendering', async ({ page }) => {
    const harness = await installAdminHarness(page);
    await openAdmin(page, `/admin/organizations/${ORG_A.id}/overview`);

    const selector = page.locator('#organization-selector-input');
    await expect.soft(page.locator('#organization-slug')).toHaveCount(0);
    await expect.soft(selector).toHaveValue(`${ORG_A.name} - ${ORG_A.id}`);
    expect.soft(await selector.inputValue()).not.toContain(ORG_A_SLUG_MARKER);

    const savedName = 'ORGANIZATION-A-RENAMED-BY-PLATFORM';
    const savedSeatLimit = ORG_A.seatLimit + 7;
    await page.locator('#organization-name').fill(savedName);
    await page.locator('#organization-seat-limit').fill(String(savedSeatLimit));

    const patchPath = `/admin/api/organizations/${ORG_A.id}`;
    const patch = harness.delayNext('PATCH', patchPath);
    await page.locator('#organization-save-button').click();
    const patchRecord = await patch.arrived;
    expect.soft(patchRecord.body).toEqual({ name: savedName, seatLimit: savedSeatLimit });
    expect.soft(Object.prototype.hasOwnProperty.call(patchRecord.body, 'slug')).toBe(false);

    const savedOrganization = {
      ...ORG_A,
      name: savedName,
      seatLimit: savedSeatLimit,
      slug: ORG_A_SLUG_MARKER,
    };
    harness.state.organizations = harness.state.organizations.map((organization) => (
      organization.id === ORG_A.id ? savedOrganization : organization
    ));
    patch.release(json(200, { organization: savedOrganization }));

    await expect(page.locator('#organization-save-status')).toHaveText('Organization saved.');
    await expect(page.locator('#organization-name')).toHaveValue(savedName);
    await expect.soft(selector).toHaveValue(`${savedName} - ${ORG_A.id}`);
    expect.soft(await page.locator('body').innerText()).not.toContain(ORG_A_SLUG_MARKER);

    await page.locator('[data-platform-route="organizations"]').click();
    await waitForPageReady(page);
    const directory = page.locator('#organization-directory-list');
    await expect(directory).toContainText(savedName);
    await expect(directory).toContainText(ORG_A.id);
    await expect.soft(directory).not.toContainText(ORG_A_SLUG_MARKER);
  });

  test('platform SPA keeps a nameless organization slug private in directory, overview, selector, and attributes', async ({ page }) => {
    test.setTimeout(75_000);
    const harness = await installAdminHarness(page);
    const privateSlugMarker = 'NAMELESS-ORGANIZATION-PRIVATE-SLUG-MARKER';
    const namelessOrganization = organization(
      'org-nameless-spa',
      '',
      privateSlugMarker,
      33_003,
    );
    harness.state.organizations.push(namelessOrganization);
    harness.state.session.organizations.push({
      id: namelessOrganization.id,
      name: namelessOrganization.name,
      slug: namelessOrganization.slug,
      role: 'organization_admin',
    });

    await openAdmin(page, '/admin/organizations');
    const openButton = page.locator(
      `[data-enter-organization-id="${namelessOrganization.id}"]`,
    );
    const directoryCard = openButton.locator('..');
    await expect(directoryCard).toContainText(namelessOrganization.id);
    await expect.soft(directoryCard).not.toContainText(privateSlugMarker);
    await expect.soft(openButton).toHaveAttribute(
      'aria-label',
      `Open ${namelessOrganization.id} organization workspace`,
    );
    expect.soft(await openButton.getAttribute('aria-label')).not.toContain(privateSlugMarker);

    await openButton.click();
    await waitForPageReady(page);
    await expect(page).toHaveURL(
      new RegExp(`/admin/organizations/${namelessOrganization.id}/overview$`),
    );
    await expect.soft(page.locator('#operating-organization-label')).toHaveText(
      `Operating organization: ${namelessOrganization.id}`,
    );
    await expect.soft(page.locator('#organization-editor-title')).toHaveText(
      namelessOrganization.id,
    );

    const selector = page.locator('#organization-selector-input');
    await expect.soft(selector).toHaveValue(namelessOrganization.id);
    await expect.soft(selector).toHaveAttribute(
      'title',
      /Search by organization name (?:or|and) id\./i,
    );
    const selectorTitle = await selector.getAttribute('title');
    expect.soft(selectorTitle).not.toContain(privateSlugMarker);
    expect.soft(selectorTitle?.toLowerCase()).not.toContain('slug');

    const namelessOption = page.locator(
      `#organization-selector-options option[value*="${namelessOrganization.id}"]`,
    );
    await expect(namelessOption).toHaveCount(1);
    const optionAttributes = await namelessOption.evaluate((option) => Object.fromEntries(
      Array.from(option.attributes, (attribute) => [attribute.name, attribute.value]),
    ));
    expect.soft(optionAttributes.value).toBe(namelessOrganization.id);
    expect.soft(optionAttributes.label).toBe(namelessOrganization.id);
    for (const [attributeName, attributeValue] of Object.entries(optionAttributes)) {
      expect.soft(
        attributeValue,
        `datalist option ${attributeName} must not expose the private organization slug`,
      ).not.toContain(privateSlugMarker);
    }

    expect.soft(await page.locator('#operating-organization-label').innerText()).not.toContain(privateSlugMarker);
    expect.soft(await page.locator('#organization-editor-title').innerText()).not.toContain(privateSlugMarker);
    expect.soft(await selector.inputValue()).not.toContain(privateSlugMarker);
  });

  test('organization slug stays private while duplicate and nameless organization labels remain unique', async ({ page }) => {
    const harness = await installAdminHarness(page);
    const duplicateOrganization = organization(
      'org-a-duplicate',
      ORG_A.name,
      'DUPLICATE-ORGANIZATION-PRIVATE-SLUG-MARKER',
      44_004,
    );
    const namelessOrganization = organization(
      'org-nameless-labels',
      '',
      'NAMELESS-LABELS-PRIVATE-SLUG-MARKER',
      55_005,
    );
    for (const entry of [duplicateOrganization, namelessOrganization]) {
      harness.state.organizations.push(entry);
      harness.state.session.organizations.push({
        id: entry.id,
        name: entry.name,
        slug: entry.slug,
        role: 'organization_admin',
      });
    }

    await openAdmin(page, '/admin/organizations');

    for (const entry of [ORG_A, duplicateOrganization, namelessOrganization]) {
      const uniqueLabel = entry.name ? `${entry.name} - ${entry.id}` : entry.id;
      const openButton = page.locator(`[data-enter-organization-id="${entry.id}"]`);
      const directoryCard = openButton.locator('..');
      await expect(directoryCard).toContainText(entry.id);
      if (entry.name) await expect(directoryCard).toContainText(entry.name);
      await expect(openButton).toHaveAttribute(
        'aria-label',
        `Open ${uniqueLabel} organization workspace`,
      );
    }

    await page.locator('[data-platform-route="platform-users"]').click();
    await waitForPageReady(page);
    await page.locator('[data-user-id="global-alice"]').click();
    await expect(page.locator('#user-editor-modal')).toHaveAttribute('open', '');
    await expect(page.locator(`#user-org option[value="${ORG_A.id}"]`)).toHaveText(
      `${ORG_A.name} - ${ORG_A.id}`,
    );
    await expect(page.locator(`#user-org option[value="${duplicateOrganization.id}"]`)).toHaveText(
      `${duplicateOrganization.name} - ${duplicateOrganization.id}`,
    );
    await expect(page.locator(`#user-org option[value="${namelessOrganization.id}"]`)).toHaveText(
      namelessOrganization.id,
    );
    await page.locator('#user-modal-close').click();

    await openAdmin(page, `/admin/organizations/${ORG_A.id}/overview`);
    for (const entry of [ORG_A, duplicateOrganization, namelessOrganization]) {
      const uniqueLabel = entry.name ? `${entry.name} - ${entry.id}` : entry.id;
      const option = page.locator(`#organization-selector-options option[value="${uniqueLabel}"]`);
      await expect(option).toHaveCount(1);
      await expect(option).toHaveAttribute('label', uniqueLabel);
    }

    await switchOrganization(page, duplicateOrganization);
    await waitForPageReady(page);
    await expect(page).toHaveURL(
      new RegExp(`/admin/organizations/${duplicateOrganization.id}/overview$`),
    );

    const selector = page.locator('#organization-selector-input');
    await selector.evaluate((input, duplicateName) => {
      const control = input as HTMLInputElement;
      control.value = duplicateName;
      control.dispatchEvent(new Event('change', { bubbles: true }));
    }, ORG_A.name);

    await expect(page.locator('#organization-context-status')).toHaveText(/ambiguous|name and ID/i);
    await expect(page).toHaveURL(
      new RegExp(`/admin/organizations/${duplicateOrganization.id}/overview$`),
    );
    await expect(selector).toHaveValue(
      `${duplicateOrganization.name} - ${duplicateOrganization.id}`,
    );
  });

  test('organization admin organization slug stays server-side and PATCH submits only the editable name', async ({ page }) => {
    const harness = await installAdminHarness(page);
    harness.state.session = {
      user: {
        id: 'organization-admin',
        email: 'organization-admin@example.test',
        emailVerified: true,
        name: 'ORGANIZATION-ADMIN',
      },
      platformAdmin: false,
      activeOrgId: ORG_A.id,
      organizations: [{
        id: ORG_A.id,
        name: ORG_A.name,
        slug: ORG_A.slug,
        role: 'organization_admin',
      }],
      capabilities: ['organization', 'users'],
      allowedPages: ['organization', 'users'],
    };

    await openAdmin(page, `/admin/organizations/${ORG_A.id}/overview`);

    const selector = page.locator('#organization-selector-input');
    await expect.soft(page.locator('#organization-slug')).toHaveCount(0);
    await expect.soft(selector).toHaveValue(`${ORG_A.name} - ${ORG_A.id}`);
    expect.soft(await selector.inputValue()).not.toContain(ORG_A_SLUG_MARKER);

    const savedName = 'ORGANIZATION-A-RENAMED-BY-ORG-ADMIN';
    await page.locator('#organization-name').fill(savedName);
    const patchPath = `/admin/api/organizations/${ORG_A.id}`;
    const patch = harness.delayNext('PATCH', patchPath);
    await page.locator('#organization-save-button').click();
    const patchRecord = await patch.arrived;
    expect.soft(patchRecord.body).toEqual({ name: savedName });
    expect.soft(Object.prototype.hasOwnProperty.call(patchRecord.body, 'slug')).toBe(false);

    patch.release(json(200, {
      organization: {
        ...ORG_A,
        name: savedName,
        slug: ORG_A_SLUG_MARKER,
      },
    }));

    await expect(page.locator('#organization-save-status')).toHaveText('Organization saved.');
    await expect(page.locator('#organization-name')).toHaveValue(savedName);
    await expect.soft(selector).toHaveValue(`${savedName} - ${ORG_A.id}`);
    expect.soft(await page.locator('body').innerText()).not.toContain(ORG_A_SLUG_MARKER);
  });

  test('AI Access uses encoded organization-qualified GET and exact PUT, and delayed success cannot mutate a new organization', async ({ page }) => {
    const harness = await installAdminHarness(page);
    await openAdmin(page, `/admin/organizations/${ORG_A.id}/ai-access`);
    const member = ORG_MEMBERS[ORG_A.id][0];
    const qualifiedPath = qualifiedAiAccessPath(ORG_A.id, member.userId);
    const globalRequestCount = requestCount(harness.records, 'GET', '/admin/api/users');

    await page.locator(`[data-user-id="${member.userId}"]`).click();
    await expect.poll(() => requestCount(harness.records, 'GET', qualifiedPath)).toBe(1);
    await expect(page.locator('#user-editor-modal')).toHaveAttribute('open', '');
    await expect(page.locator('#user-ai-access-enabled')).toBeVisible();
    await expect(page.locator('#user-platform-admin')).toBeVisible();
    await expect(page.locator('#user-ai-access-provider')).toHaveCount(0);
    await expect(page.locator('#user-ai-access-credential')).toHaveCount(0);
    expect(qualifiedPath).toContain('%2F');
    expect(qualifiedPath).toContain('%40');

    await page.locator('#user-ai-access-enabled').uncheck();
    await page.locator('#user-platform-admin').check();
    const platformAdminPath = `/admin/api/users/${encodeURIComponent(member.userId)}`;
    const platformSave = harness.delayNext('PATCH', platformAdminPath);
    const save = harness.delayNext('PUT', qualifiedPath);
    await page.locator('#user-save-button').click();
    const platformSaveRecord = await platformSave.arrived;
    expect(platformSaveRecord.body).toEqual({ platformAdmin: true });
    platformSave.release(json(200, { user: { ...member, id: member.userId, platformAdmin: true } }));
    const saveRecord = await save.arrived;
    expect(saveRecord.body).toEqual({ enabled: false });

    await switchOrganization(page, ORG_B);
    await waitForPageReady(page);
    await expect(page.locator('#user-editor-modal')).not.toHaveAttribute('open', '');
    save.release(harness.responseFor('PUT', qualifiedPath, saveRecord.body));
    await waitAnimationFrames(page, 3);

    await expect(page).toHaveURL(new RegExp(`/admin/organizations/${ORG_B.id}/ai-access$`));
    await expect(page.locator('#user-list')).toContainText('ORG-B-BOB');
    await expect(page.locator('#user-save-status')).not.toHaveText('AI access saved.');
    expect(requestCount(harness.records, 'GET', '/admin/api/users')).toBe(globalRequestCount);
    expect(harness.records.some((record) => /^\/admin\/api\/users\/.+\/ai-access$/.test(record.path))).toBe(false);
  });

  test('organization admin can toggle AI access but cannot elevate platform admin', async ({ page }) => {
    const harness = await installAdminHarness(page);
    harness.state.session = {
      user: {
        id: 'organization-admin',
        email: 'organization-admin@example.test',
        emailVerified: true,
        name: 'ORGANIZATION-ADMIN',
      },
      platformAdmin: false,
      activeOrgId: ORG_A.id,
      organizations: [{ ...ORG_A, role: 'organization_admin' }],
      capabilities: ['organization', 'users', 'managedAiUserAccess'],
      allowedPages: ['organization', 'users'],
    };
    const member = ORG_MEMBERS[ORG_A.id][0];
    const qualifiedPath = qualifiedAiAccessPath(ORG_A.id, member.userId);

    await openAdmin(page, `/admin/organizations/${ORG_A.id}/ai-access`);
    await page.locator(`[data-user-id="${member.userId}"]`).click();
    await expect(page.locator('#user-platform-admin')).not.toBeVisible();
    await expect(page.locator('#user-platform-admin')).toBeDisabled();
    await page.locator('#user-ai-access-enabled').uncheck();
    await page.locator('#user-save-button').click();
    await expect.poll(() => requestCount(harness.records, 'PUT', qualifiedPath)).toBe(1);
    const putRecord = harness.records.find((record) => record.method === 'PUT' && record.path === qualifiedPath);
    expect(putRecord?.body).toEqual({ enabled: false });
    expect(harness.records.some((record) => record.method === 'PATCH' && /^\/admin\/api\/users\//.test(record.path))).toBe(false);
  });

  test('organization A to B transitions isolate Overview, domains, invites, billing, AI access, and audit until each destination is complete', async ({ page }) => {
    test.setTimeout(60_000);
    const harness = await installAdminHarness(page);
    const cases: Array<{
      page: 'overview' | 'domains-invites' | 'billing' | 'ai-access' | 'audit';
      paths: string[];
      forbidden: string[];
      expected: string[];
      oldSelectors: string[];
      initialVisible?: string[];
      initialValues?: Array<{ selector: string; value: string }>;
      clearedSelectors?: string[];
      expectedValues?: Array<{ selector: string; value: string }>;
    }> = [
      {
        page: 'overview',
        paths: [`/admin/api/organizations/${ORG_B.id}`],
        forbidden: [String(ORG_A.seatLimit)],
        expected: [],
        oldSelectors: [],
        initialVisible: [],
        initialValues: [{ selector: '#organization-seat-limit', value: String(ORG_A.seatLimit) }],
        clearedSelectors: ['#organization-seat-limit'],
        expectedValues: [{ selector: '#organization-seat-limit', value: String(ORG_B.seatLimit) }],
      },
      {
        page: 'domains-invites',
        paths: [
          `/admin/api/organizations/${ORG_B.id}`,
          `/admin/api/organizations/${ORG_B.id}/domains`,
          `/admin/api/organizations/${ORG_B.id}/invites`,
        ],
        forbidden: ['ORG-A-DOMAIN.example', 'ORG-A-INVITE@example.test'],
        expected: ['ORG-B-DOMAIN.example', 'ORG-B-INVITE@example.test'],
        oldSelectors: ['[data-domain-id="domain-a"]', '[data-invite-id="invite-a"]'],
      },
      {
        page: 'billing',
        paths: [
          `/admin/api/organizations/${ORG_B.id}`,
          `/admin/api/organizations/${ORG_B.id}/billing`,
        ],
        forbidden: ['ORG-A-BILLING'],
        expected: ['ORG-B-BILLING'],
        oldSelectors: ['#organization-billing-summary .metric-card'],
      },
      {
        page: 'ai-access',
        paths: [
          `/admin/api/organizations/${ORG_B.id}`,
          `/admin/api/organizations/${ORG_B.id}/members`,
        ],
        forbidden: ['ORG-A-ALICE', 'ORG-A-AI-CREDENTIAL'],
        expected: ['ORG-B-BOB'],
        oldSelectors: [`[data-user-id="${ORG_MEMBERS[ORG_A.id][0].userId}"]`],
      },
      {
        page: 'audit',
        paths: [
          `/admin/api/organizations/${ORG_B.id}`,
          `/admin/api/organizations/${ORG_B.id}/audit`,
        ],
        forbidden: ['ORG-A-AUDIT-ACTION', 'ORG-A-AUDIT-SUMMARY'],
        expected: ['ORG-B-AUDIT-ACTION', 'ORG-B-AUDIT-SUMMARY'],
        oldSelectors: ['#organization-audit-list .list-card'],
      },
    ];

    for (const scenario of cases) {
      await openAdmin(page, `/admin/organizations/${ORG_A.id}/${scenario.page}`);
      const initialVisible = scenario.initialVisible
        ?? scenario.forbidden.slice(0, scenario.page === 'ai-access' ? 1 : undefined);
      for (const marker of initialVisible) {
        await expect(page.locator('body')).toContainText(marker);
      }
      for (const control of scenario.initialValues || []) {
        await expect(page.locator(control.selector)).toHaveValue(control.value);
      }
      if (scenario.page === 'ai-access') {
        await page.locator(`[data-user-id="${ORG_MEMBERS[ORG_A.id][0].userId}"]`).click();
        await expect(page.locator('#user-ai-access-enabled')).toBeVisible();
        await expect(page.locator('#user-ai-access-provider')).toHaveCount(0);
        await expect(page.locator('#user-ai-access-credential')).toHaveCount(0);
      }

      const controls = scenario.paths.map((path) => harness.delayNext('GET', path));
      await armLeakObserver(page, scenario.forbidden, 'change');
      await switchOrganization(page, ORG_B);

      for (const selector of scenario.oldSelectors) {
        await expect(page.locator(selector)).toHaveCount(0);
      }
      for (const selector of scenario.clearedSelectors || []) {
        await expect(page.locator(selector)).toHaveValue('');
      }
      if (scenario.page === 'ai-access') {
        await expect(page.locator('#user-editor-modal')).not.toHaveAttribute('open', '');
      }
      await Promise.all(controls.map((control) => control.arrived));

      for (let index = 0; index < controls.length - 1; index += 1) {
        controls[index].release(harness.responseFor('GET', scenario.paths[index]));
      }
      for (const marker of scenario.expected) {
        await expect(page.locator('body')).not.toContainText(marker);
      }
      for (const control of scenario.expectedValues || []) {
        await expect(page.locator(control.selector)).not.toHaveValue(control.value);
      }
      const finalIndex = controls.length - 1;
      controls[finalIndex].release(harness.responseFor('GET', scenario.paths[finalIndex]));
      await waitForPageReady(page);

      for (const marker of scenario.expected) {
        await expect(page.locator('body')).toContainText(marker);
      }
      for (const control of scenario.expectedValues || []) {
        await expect(page.locator(control.selector)).toHaveValue(control.value);
      }
      expect(await stopLeakObserver(page)).toEqual([]);

      if (scenario.page === 'ai-access') {
        await page.locator(`[data-user-id="${ORG_MEMBERS[ORG_B.id][0].userId}"]`).click();
        await expect(page.locator('#user-ai-access-enabled')).toBeVisible();
        await page.locator('#user-modal-close').click();
      }
    }
  });

  test('loading, true empty, 5xx, network failure, and Retry remain distinct without real data under the skeleton', async ({ page }) => {
    const harness = await installAdminHarness(page);
    const organization = harness.delayNext('GET', `/admin/api/organizations/${ORG_A.id}`);
    const members = harness.delayNext('GET', `/admin/api/organizations/${ORG_A.id}/members`);

    await page.goto(`${adminServer.origin}/admin/organizations/${ORG_A.id}/members`, { waitUntil: 'domcontentloaded' });
    await Promise.all([organization.arrived, members.arrived]);
    await expect(page.locator('#admin-page-state')).toHaveAttribute('data-state', 'loading');
    await expect(page.locator('#admin-page-state')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#admin-page-loading')).toBeVisible();
    await expect(page.locator('#admin-page-loading')).toHaveAttribute('role', 'status');
    await expect(page.locator('#admin-page-loading')).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('#admin-page-skeleton')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('#admin-page-skeleton')).toBeVisible();
    await expect(page.locator('#admin-page-skeleton')).toHaveText('');
    await expect(page.locator('#user-list')).toBeEmpty();
    const loadingStyles = await page.evaluate(() => ({
      skeletonFilter: getComputedStyle(document.querySelector('#admin-page-skeleton') as Element).filter,
      routeFilter: getComputedStyle(document.querySelector('[data-page="users"]') as Element).filter,
      routeDisplay: getComputedStyle(document.querySelector('[data-page="users"]') as Element).display,
      skeletonContainsRoute: (document.querySelector('#admin-page-skeleton') as Element)
        .contains(document.querySelector('#user-list')),
    }));
    expect(loadingStyles.skeletonFilter).toContain('blur');
    expect(loadingStyles.routeFilter).toBe('none');
    expect(loadingStyles.routeDisplay).toBe('none');
    expect(loadingStyles.skeletonContainsRoute).toBe(false);

    organization.release(harness.responseFor('GET', `/admin/api/organizations/${ORG_A.id}`));
    members.release(harness.responseFor('GET', `/admin/api/organizations/${ORG_A.id}/members`));
    await waitForPageReady(page);
    await expect(page.locator('#admin-page-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('#user-list')).toContainText('ORG-A-ALICE');

    harness.respondNext('GET', `/admin/api/organizations/${ORG_B.id}`, json(500, { error: 'controlled_5xx' }));
    await switchOrganization(page, ORG_B);
    await expectPageError(page, 'Unable to load data. Retry this page.', true);
    await expect(page.locator(`[data-user-id="${ORG_MEMBERS[ORG_A.id][0].userId}"]`)).toHaveCount(0);
    await page.locator('#admin-page-retry').click();
    await waitForPageReady(page);
    await expect(page.locator('#user-list')).toContainText('ORG-B-BOB');

    harness.failNext('GET', `/admin/api/organizations/${ORG_A.id}`);
    await switchOrganization(page, ORG_A);
    await expectPageError(page, 'Unable to load data. Retry this page.', true);
    await expect(page.locator('[data-user-id="org-b-bob"]')).toHaveCount(0);
    await page.locator('#admin-page-retry').click();
    await waitForPageReady(page);
    await expect(page.locator('#user-list')).toContainText('ORG-A-ALICE');
  });

  test('true empty member response settles as empty rather than remaining loading', async ({ page }) => {
    const harness = await installAdminHarness(page);
    harness.state.membersByOrgId[ORG_A.id] = [];
    await page.goto(`${adminServer.origin}/admin/organizations/${ORG_A.id}/members`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#auth-state')).toHaveText('Signed in');
    await expect(page.locator('#admin-page-state')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#admin-page-state')).toHaveAttribute('data-state', 'empty');
    await expect(page.locator('#user-list')).toContainText('No users');
  });

  test('401 sign-in, 403 Access denied, and organization 404 are fail-closed and distinguishable', async ({ page }) => {
    const harness = await installAdminHarness(page);
    await openAdmin(page, `/admin/organizations/${ORG_A.id}/members`);

    harness.respondNext('GET', `/admin/api/organizations/${ORG_B.id}`, json(403, { error: 'forbidden' }));
    await switchOrganization(page, ORG_B);
    await expectPageError(page, 'Access denied', false);
    await expect(page.locator(`[data-user-id="${ORG_MEMBERS[ORG_A.id][0].userId}"]`)).toHaveCount(0);
    await expect(page.locator('#login-panel')).toHaveClass(/hidden/);

    await openAdmin(page, `/admin/organizations/${ORG_A.id}/members`);
    harness.respondNext('GET', `/admin/api/organizations/${ORG_B.id}`, json(401, { error: 'unauthorized' }));
    await switchOrganization(page, ORG_B);
    await expect(page.locator('#login-panel')).not.toHaveClass(/hidden/);
    await expect(page.locator('#login-error')).toHaveText('Your admin session has expired. Sign in again.');
    await expect(page.locator('#app-panel')).toHaveClass(/hidden/);
    await expect(page.locator('[data-user-id]')).toHaveCount(0);
    expect(await page.evaluate((key) => localStorage.getItem(key), ADMIN_TOKEN_STORAGE_KEY)).toBeNull();

    const missingOrg = 'org-missing';
    harness.respondNext('GET', `/admin/api/organizations/${missingOrg}`, json(404, { error: 'organization_not_found' }));
    await page.goto(`${adminServer.origin}/admin/organizations/${missingOrg}/members`, { waitUntil: 'domcontentloaded' });
    await expectPageError(page, 'Organization not found', false);
    await expect(page.locator('[data-user-id]')).toHaveCount(0);
  });

  test('verified-member domain conflict keeps the add modal usable and never adds an optimistic row', async ({ page }) => {
    const harness = await installAdminHarness(page);
    const domainsPath = `/admin/api/organizations/${ORG_A.id}/domains`;
    const rejectedDomain = 'unverified-domain.example';

    await openAdmin(page, `/admin/organizations/${ORG_A.id}/domains-invites`);
    await expect(page.locator('[data-domain-id]')).toHaveCount(1);
    await page.locator('#organization-domain-add-button').click();
    await expect(page.locator('#organization-domain-modal')).toHaveAttribute('open', '');
    await page.locator('#organization-domain-modal-domain').fill(rejectedDomain);

    const rejectedSave = harness.delayNext('POST', domainsPath);
    await page.locator('#organization-domain-modal-save').click();
    const request = await rejectedSave.arrived;
    expect(request.body).toEqual({
      domain: rejectedDomain,
      enabled: true,
      selfSignupEnabled: false,
    });
    await expect(page.locator('#organization-domain-modal-save')).toBeDisabled();
    await expect(page.locator('[data-domain-id]')).toHaveCount(1);
    await expect(page.locator('#organization-domain-list')).not.toContainText(rejectedDomain);

    rejectedSave.release(json(409, { error: 'domain_verified_member_required' }));

    await expect(page.locator('#organization-domain-modal')).toHaveAttribute('open', '');
    await expect(page.locator('#organization-domain-modal-status')).toHaveText(
      'Unable to save domain: Add and verify a member email from this domain before registering it.',
    );
    await expect(page.locator('#organization-domain-modal-status')).toHaveAttribute('data-tone', 'error');
    await expect(page.locator('#organization-domain-modal-save')).toBeEnabled();
    await expect(page.locator('#organization-domain-modal-domain')).toHaveValue(rejectedDomain);
    await expect(page.locator('[data-domain-id]')).toHaveCount(1);
    await expect(page.locator('#organization-domain-list')).not.toContainText(rejectedDomain);
    expect(requestCount(harness.records, 'GET', domainsPath)).toBe(1);
  });

  test('route-owned dialogs close immediately and late abandoned organization responses cannot restore selected content', async ({ page }) => {
    const harness = await installAdminHarness(page);
    await openAdmin(page, `/admin/organizations/${ORG_A.id}/domains-invites`);
    await page.locator('[data-domain-id="domain-a"]').click();
    await expect(page.locator('#organization-domain-modal')).toHaveAttribute('open', '');

    const membersOrganization = harness.delayNext('GET', `/admin/api/organizations/${ORG_A.id}`);
    const members = harness.delayNext('GET', `/admin/api/organizations/${ORG_A.id}/members`);
    await armLeakObserver(page, ['ORG-A-DOMAIN.example'], 'popstate');
    await navigateWithPopstate(page, `/admin/organizations/${ORG_A.id}/members`);
    await expect(page.locator('#organization-domain-modal')).not.toHaveAttribute('open', '');
    await expect(page.locator('[data-domain-id="domain-a"]')).toHaveCount(0);
    await Promise.all([membersOrganization.arrived, members.arrived]);
    membersOrganization.release(harness.responseFor('GET', `/admin/api/organizations/${ORG_A.id}`));
    members.release(harness.responseFor('GET', `/admin/api/organizations/${ORG_A.id}/members`));
    await waitForPageReady(page);
    expect(await stopLeakObserver(page)).toEqual([]);

    await page.locator(`[data-user-id="${ORG_MEMBERS[ORG_A.id][0].userId}"]`).click();
    await expect(page.locator('#user-editor-modal')).toHaveAttribute('open', '');
    const lateOrganization = harness.delayNext('GET', `/admin/api/organizations/${ORG_A.id}`);
    const lateDomains = harness.delayNext('GET', `/admin/api/organizations/${ORG_A.id}/domains`);
    const lateInvites = harness.delayNext('GET', `/admin/api/organizations/${ORG_A.id}/invites`);
    await armLeakObserver(page, ['ORG-A-ALICE', 'org-a-alice@example.test'], 'popstate');
    await navigateWithPopstate(page, `/admin/organizations/${ORG_A.id}/domains-invites`);
    await Promise.all([lateOrganization.arrived, lateDomains.arrived, lateInvites.arrived]);
    await expect(page.locator('#user-editor-modal')).not.toHaveAttribute('open', '');
    await expect(page.locator(`[data-user-id="${ORG_MEMBERS[ORG_A.id][0].userId}"]`)).toHaveCount(0);

    await page.locator('[data-platform-route="audit"]').click();
    await waitForPageReady(page);
    lateOrganization.release(harness.responseFor('GET', `/admin/api/organizations/${ORG_A.id}`));
    lateDomains.release(harness.responseFor('GET', `/admin/api/organizations/${ORG_A.id}/domains`));
    lateInvites.release(harness.responseFor('GET', `/admin/api/organizations/${ORG_A.id}/invites`));
    await waitAnimationFrames(page, 3);

    await expect(page.locator('#page-title')).toHaveText('Global Audit');
    await expect(page.locator('#organization-domain-modal')).not.toHaveAttribute('open', '');
    await expect(page.locator('#user-editor-modal')).not.toHaveAttribute('open', '');
    await expect(page.locator('[data-domain-id="domain-a"]')).toHaveCount(0);
    expect(await stopLeakObserver(page)).toEqual([]);
  });

  test('stale qualified AI Access error after member selection change is inert and the client never calls legacy routes', async ({ page }) => {
    const harness = await installAdminHarness(page);
    await openAdmin(page, `/admin/organizations/${ORG_A.id}/ai-access`);
    const first = ORG_MEMBERS[ORG_A.id][0];
    const second = ORG_MEMBERS[ORG_A.id][1];
    const firstPath = qualifiedAiAccessPath(ORG_A.id, first.userId);
    const secondPath = qualifiedAiAccessPath(ORG_A.id, second.userId);
    const delayedGet = harness.delayNext('GET', firstPath);

    await page.locator(`[data-user-id="${first.userId}"]`).click();
    await delayedGet.arrived;
    await expect(page.locator('#user-ai-access-provider')).toHaveCount(0);
    await expect(page.locator('#user-ai-access-credential')).toHaveCount(0);
    delayedGet.release(harness.responseFor('GET', firstPath));
    await expect(page.locator('#user-ai-access-enabled')).toBeChecked();

    const save = harness.delayNext('PUT', firstPath);
    await page.locator('#user-save-button').click();
    const saveRecord = await save.arrived;
    expect(saveRecord.body).toEqual({ enabled: true });
    await page.locator('#user-modal-close').click();
    await page.locator(`[data-user-id="${second.userId}"]`).click();
    await expect.poll(() => requestCount(harness.records, 'GET', secondPath)).toBe(1);
    await expect(page.locator('#user-editor-title')).toHaveText('ORG-A-SECOND');

    save.release(json(500, { error: 'controlled_stale_save_error' }));
    await waitAnimationFrames(page, 3);
    await expect(page.locator('#user-editor-title')).toHaveText('ORG-A-SECOND');
    await expect(page.locator('#user-save-status')).not.toContainText('controlled_stale_save_error');
    await expect(page.locator('#user-save-status')).not.toHaveText('AI access saved.');

    const legacyPath = `/admin/api/users/${encodeURIComponent(first.userId)}/ai-access`;
    expect(harness.records.filter((record) => record.path === legacyPath)).toHaveLength(0);
    expect(harness.records.some((record) => /^\/admin\/api\/users\/.+\/ai-access$/.test(record.path))).toBe(false);
  });

  test('wrong membershipId or userId in member PATCH responses cannot show success and forces scoped recovery', async ({ page }) => {
    const harness = await installAdminHarness(page);
    const member = ORG_MEMBERS[ORG_A.id][0];
    const patchPath = `/admin/api/organizations/${ORG_A.id}/members/${member.membershipId}`;
    const mismatches = [
      { ...member, membershipId: 'wrong-membership-id', role: 'organization_admin' },
      { ...member, userId: 'wrong-user-id', role: 'organization_admin' },
    ];

    for (const wrongMember of mismatches) {
      await openAdmin(page, `/admin/organizations/${ORG_A.id}/members`);
      const usersBefore = requestCount(harness.records, 'GET', '/admin/api/users');
      await page.locator(`[data-user-id="${member.userId}"]`).click();
      await page.locator('#user-role').selectOption('organization_admin');
      const patchResponse = harness.respondNext('PATCH', patchPath, json(200, { member: wrongMember }));
      const recoveryOrganization = harness.delayNext('GET', `/admin/api/organizations/${ORG_A.id}`);
      const recoveryMembers = harness.delayNext('GET', `/admin/api/organizations/${ORG_A.id}/members`);

      await page.locator('#user-save-button').click();
      const patchRecord = await patchResponse.arrived;
      expect(patchRecord.body).toEqual({ role: 'organization_admin' });
      await Promise.all([recoveryOrganization.arrived, recoveryMembers.arrived]);
      await expect(page.locator('#admin-page-state')).toHaveAttribute('data-state', 'loading');
      await expect(page.locator('#user-editor-modal')).not.toHaveAttribute('open', '');
      await expect(page.locator('#user-save-status')).not.toContainText('Organization membership saved.');
      expect(requestCount(harness.records, 'GET', '/admin/api/users')).toBe(usersBefore);

      recoveryOrganization.release(harness.responseFor('GET', `/admin/api/organizations/${ORG_A.id}`));
      recoveryMembers.release(harness.responseFor('GET', `/admin/api/organizations/${ORG_A.id}/members`));
      await waitForPageReady(page);
      await expect(page.locator('#user-list')).toContainText('ORG-A-ALICE');
      await expect(page.locator('#user-list')).not.toContainText('Organization membership saved.');
    }
  });
});

async function installAdminHarness(page: Page) {
  const state = createHarnessState();
  const queued = new Map<string, QueuedResponse[]>();

  await page.addInitScript(
    ({ storageKey, token }) => {
      window.localStorage.setItem(storageKey, token);

      type LeakRecord = {
        token: string;
        channel: 'visible' | 'semantic';
        source: string;
        sample: string;
      };
      let forbidden: string[] = [];
      let records: LeakRecord[] = [];
      let active = false;
      let pendingEvent: {
        name: string;
        captureListener: EventListener;
        bubbleListener: EventListener | null;
      } | null = null;

      const semanticallyHidden = (element: Element | null) => {
        for (let current = element; current; current = current.parentElement) {
          if (
            current.hasAttribute('hidden')
            || current.getAttribute('aria-hidden') === 'true'
            || current.hasAttribute('inert')
            || current.classList.contains('hidden')
          ) {
            return true;
          }
          const style = window.getComputedStyle(current);
          if (style.display === 'none' || style.visibility === 'hidden') return true;
        }
        return false;
      };

      const record = (tokenValue: string, channel: LeakRecord['channel'], source: string, sample: string) => {
        if (records.some((entry) => entry.token === tokenValue && entry.channel === channel)) return;
        records.push({ token: tokenValue, channel, source, sample: sample.slice(0, 240) });
      };

      const inspectSemanticValue = (element: Element, value: string | null | undefined, source: string) => {
        if (!value || semanticallyHidden(element)) return;
        for (const tokenValue of forbidden) {
          if (value.includes(tokenValue)) {
            record(tokenValue, 'semantic', source, value);
          }
        }
      };

      const referencedText = (ids: string | null) => (ids || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent || '')
        .join(' ');

      const inspect = (source: string) => {
        if (!active || !document.body) return;
        const visibleText = document.body.innerText || '';
        for (const tokenValue of forbidden) {
          if (visibleText.includes(tokenValue)) {
            record(tokenValue, 'visible', source, visibleText);
          }
        }

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.nodeValue || '';
          if (!text || semanticallyHidden(node.parentElement)) continue;
          for (const tokenValue of forbidden) {
            if (text.includes(tokenValue)) {
              record(tokenValue, 'semantic', source, text);
            }
          }
        }

        const semanticAttributes = ['aria-label', 'title', 'alt', 'aria-valuetext', 'placeholder'];
        for (const element of document.body.querySelectorAll('*')) {
          if (semanticallyHidden(element)) continue;
          for (const attribute of semanticAttributes) {
            inspectSemanticValue(element, element.getAttribute(attribute), `${source}:${attribute}`);
          }
          inspectSemanticValue(
            element,
            referencedText(element.getAttribute('aria-labelledby')),
            `${source}:aria-labelledby`,
          );
          inspectSemanticValue(
            element,
            referencedText(element.getAttribute('aria-describedby')),
            `${source}:aria-describedby`,
          );

          if (element instanceof HTMLInputElement) {
            if (element.type !== 'password') {
              inspectSemanticValue(element, element.value, `${source}:input-value`);
            }
            for (const label of Array.from(element.labels || [])) {
              inspectSemanticValue(element, label.textContent, `${source}:input-label`);
            }
          } else if (element instanceof HTMLTextAreaElement) {
            inspectSemanticValue(element, element.value, `${source}:textarea-value`);
            for (const label of Array.from(element.labels || [])) {
              inspectSemanticValue(element, label.textContent, `${source}:textarea-label`);
            }
          } else if (element instanceof HTMLSelectElement) {
            inspectSemanticValue(element, element.value, `${source}:select-value`);
            inspectSemanticValue(
              element,
              Array.from(element.selectedOptions).map((option) => option.textContent || '').join(' '),
              `${source}:selected-option`,
            );
            for (const label of Array.from(element.labels || [])) {
              inspectSemanticValue(element, label.textContent, `${source}:select-label`);
            }
          }
        }
      };

      const cancelPendingEvent = () => {
        if (!pendingEvent) return;
        document.removeEventListener(pendingEvent.name, pendingEvent.captureListener, true);
        if (pendingEvent.bubbleListener) {
          window.removeEventListener(pendingEvent.name, pendingEvent.bubbleListener);
        }
        pendingEvent = null;
      };

      const observer = new MutationObserver(() => inspect('mutation'));
      observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });

      const frame = () => {
        inspect('animation-frame');
        window.requestAnimationFrame(frame);
      };
      window.requestAnimationFrame(frame);

      Object.defineProperty(window, '__adminDataLeakObserver', {
        configurable: false,
        value: {
          armOnEvent(tokens: string[], eventName: string) {
            cancelPendingEvent();
            forbidden = [...tokens];
            records = [];
            active = false;
            const pending = {
              name: eventName,
              captureListener: null as unknown as EventListener,
              bubbleListener: null as EventListener | null,
            };
            if (eventName === 'popstate') {
              const bubbleListener: EventListener = () => {
                window.removeEventListener(eventName, bubbleListener);
                if (pendingEvent === pending) pendingEvent = null;
                active = true;
                inspect(`after-${eventName}`);
              };
              pending.captureListener = () => undefined;
              pending.bubbleListener = bubbleListener;
              pendingEvent = pending;
              window.addEventListener(eventName, bubbleListener);
              return;
            }
            const captureListener: EventListener = () => {
              document.removeEventListener(eventName, captureListener, true);
              const bubbleListener: EventListener = () => {
                window.removeEventListener(eventName, bubbleListener);
                if (pendingEvent === pending) pendingEvent = null;
                active = true;
                inspect(`after-${eventName}`);
              };
              pending.bubbleListener = bubbleListener;
              window.addEventListener(eventName, bubbleListener);
            };
            pending.captureListener = captureListener;
            pendingEvent = pending;
            document.addEventListener(eventName, captureListener, true);
          },
          start(tokens: string[]) {
            cancelPendingEvent();
            forbidden = [...tokens];
            records = [];
            active = true;
            inspect('manual-start');
          },
          records() {
            return records.map((entry) => ({ ...entry }));
          },
          stop() {
            cancelPendingEvent();
            active = false;
            return records.map((entry) => ({ ...entry }));
          },
        },
      });
    },
    { storageKey: ADMIN_TOKEN_STORAGE_KEY, token: TEST_TOKEN },
  );

  await page.route(`${adminServer.origin}/readiness`, async (route) => {
    await dispatchRoute(route, state, queued);
  });
  await page.route(`${adminServer.origin}/admin/api/**`, async (route) => {
    await dispatchRoute(route, state, queued);
  });

  return {
    state,
    get records() {
      return state.records;
    },
    delayNext(method: string, path: string) {
      return enqueueControlledResponse(queued, method, path);
    },
    respondNext(method: string, path: string, response: HarnessResponse) {
      const control = enqueueControlledResponse(queued, method, path);
      control.release(response);
      return control;
    },
    failNext(method: string, path: string) {
      const control = enqueueControlledResponse(queued, method, path);
      control.fail();
      return control;
    },
    responseFor(method: string, path: string, body: unknown = null) {
      return defaultResponse(state, {
        sequence: state.records.length + 1,
        method: method.toUpperCase(),
        url: `${adminServer.origin}${path}`,
        path,
        body,
      });
    },
  };
}

async function dispatchRoute(
  route: Route,
  state: HarnessState,
  queued: Map<string, QueuedResponse[]>,
) {
  const request = route.request();
  const url = new URL(request.url());
  const record: RequestRecord = {
    sequence: state.records.length + 1,
    method: request.method(),
    url: request.url(),
    path: `${url.pathname}${url.search}`,
    body: parseRequestBody(request.postData()),
  };
  state.records.push(record);

  const key = responseKey(record.method, record.path);
  const queue = queued.get(key) || [];
  const controlled = queue.shift();
  if (queue.length === 0) queued.delete(key);
  else queued.set(key, queue);

  let response: HarnessResponse;
  if (controlled) {
    controlled.markArrived(record);
    response = await controlled.response;
  } else {
    response = defaultResponse(state, record);
  }

  if ('networkError' in response) {
    await route.abort(response.networkError);
    return;
  }
  await route.fulfill({
    status: response.status,
    contentType: 'application/json',
    body: JSON.stringify(response.body),
  });
}

function defaultResponse(state: HarnessState, record: RequestRecord): HarnessResponse {
  const decodedPath = decodeURIComponent(record.path.split('?')[0]);
  if (record.path === '/readiness') {
    return json(200, { ok: true, status: 'ready' });
  }
  if (decodedPath === '/admin/api/session' && record.method === 'GET') {
    return json(200, state.session);
  }
  if (decodedPath === '/admin/api/users' && record.method === 'GET') {
    return json(200, { users: state.globalUsers });
  }
  const userMatch = decodedPath.match(/^\/admin\/api\/users\/(.+)$/);
  if (userMatch && record.method === 'PATCH') {
    const user = state.globalUsers.find((entry) => entry.id === userMatch[1]);
    return json(200, {
      user: {
        ...(user || { id: userMatch[1] }),
        platformAdmin: isObject(record.body) && record.body.platformAdmin === true,
      },
    });
  }
  if (decodedPath === '/admin/api/organizations' && record.method === 'GET') {
    return json(200, { organizations: state.organizations });
  }
  if (decodedPath === '/admin/api/credentials' && record.method === 'GET') {
    return json(200, { credentials: [] });
  }
  if (decodedPath === '/admin/api/alerts' && record.method === 'GET') {
    return json(200, { alerts: [] });
  }
  if (decodedPath === '/admin/api/audit' && record.method === 'GET') {
    return json(200, { events: [] });
  }
  if (decodedPath === '/admin/api/usage' && record.method === 'GET') {
    return json(200, emptyUsage());
  }

  const organizationMatch = decodedPath.match(/^\/admin\/api\/organizations\/([^/]+)$/);
  if (organizationMatch && record.method === 'GET') {
    const organization = state.organizations.find((entry) => entry.id === organizationMatch[1]);
    return organization
      ? json(200, { organization })
      : json(404, { error: 'organization_not_found' });
  }

  const membersMatch = decodedPath.match(/^\/admin\/api\/organizations\/([^/]+)\/members$/);
  if (membersMatch && record.method === 'GET') {
    return json(200, { members: state.membersByOrgId[membersMatch[1]] || [] });
  }

  const memberMatch = decodedPath.match(/^\/admin\/api\/organizations\/([^/]+)\/members\/([^/]+)$/);
  if (memberMatch && record.method === 'PATCH') {
    const member = (state.membersByOrgId[memberMatch[1]] || [])
      .find((entry) => entry.membershipId === memberMatch[2]);
    if (!member) return json(404, { error: 'membership_not_found' });
    const role = isObject(record.body) && record.body.role === 'organization_admin'
      ? 'organization_admin'
      : 'member';
    const saved = { ...member, role };
    state.membersByOrgId[memberMatch[1]] = (state.membersByOrgId[memberMatch[1]] || [])
      .map((entry) => entry.membershipId === saved.membershipId ? saved : entry);
    return json(200, { member: saved });
  }

  const domainsMatch = decodedPath.match(/^\/admin\/api\/organizations\/([^/]+)\/domains$/);
  if (domainsMatch && record.method === 'GET') {
    return json(200, { domains: state.domainsByOrgId[domainsMatch[1]] || [] });
  }

  const invitesMatch = decodedPath.match(/^\/admin\/api\/organizations\/([^/]+)\/invites$/);
  if (invitesMatch && record.method === 'GET') {
    return json(200, { invites: state.invitesByOrgId[invitesMatch[1]] || [] });
  }

  const billingMatch = decodedPath.match(/^\/admin\/api\/organizations\/([^/]+)\/billing$/);
  if (billingMatch && record.method === 'GET') {
    return json(200, { billing: state.billingByOrgId[billingMatch[1]] || null });
  }

  const auditMatch = decodedPath.match(/^\/admin\/api\/organizations\/([^/]+)\/audit$/);
  if (auditMatch && record.method === 'GET') {
    return json(200, { events: state.auditByOrgId[auditMatch[1]] || [] });
  }

  const aiAccessMatch = decodedPath.match(
    /^\/admin\/api\/organizations\/([^/]+)\/members\/(.+)\/ai-access$/,
  );
  if (aiAccessMatch && record.method === 'GET') {
    return json(200, state.aiAccessByOrgAndUser[`${aiAccessMatch[1]}:${aiAccessMatch[2]}`] || {
      aiAccess: null,
      availableCredentials: [],
    });
  }
  if (aiAccessMatch && record.method === 'PUT') {
    const current = state.aiAccessByOrgAndUser[`${aiAccessMatch[1]}:${aiAccessMatch[2]}`] || {
      aiAccess: null,
      availableCredentials: [],
    };
    const body = isObject(record.body) ? record.body : {};
    const saved = {
      aiAccess: {
        id: `ai-access-${aiAccessMatch[1]}`,
        userId: aiAccessMatch[2],
        enabled: body.enabled === true,
        provider: current.aiAccess?.provider || 'codex_oauth',
        credentialId: current.aiAccess?.credentialId || null,
        updatedAt: '2026-07-14T12:00:00.000Z',
      },
      availableCredentials: current.availableCredentials,
    };
    state.aiAccessByOrgAndUser[`${aiAccessMatch[1]}:${aiAccessMatch[2]}`] = saved;
    return json(200, saved);
  }

  return json(404, { error: 'not_found' });
}

async function openAdmin(page: Page, path: string) {
  await page.goto(`${adminServer.origin}${path}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#auth-state')).toHaveText('Signed in');
  await expect(page.locator('#admin-page-state')).toHaveAttribute('aria-busy', 'false');
}

async function waitForPageReady(page: Page) {
  await expect(page.locator('#auth-state')).toHaveText('Signed in');
  await expect(page.locator('#admin-page-state')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#admin-page-state')).toHaveAttribute('data-state', /^(ready|empty)$/);
}

async function expectPageError(page: Page, message: string, retryable: boolean) {
  await expect(page.locator('#admin-page-state')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#admin-page-state')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#admin-page-error')).toBeVisible();
  await expect(page.locator('#admin-page-error')).toHaveAttribute('role', 'alert');
  await expect(page.locator('#admin-page-error-message')).toHaveText(message);
  if (retryable) await expect(page.locator('#admin-page-retry')).toBeVisible();
  else await expect(page.locator('#admin-page-retry')).toBeHidden();
}

async function switchOrganization(page: Page, organization: TestOrganization) {
  const value = [organization.name, organization.id].join(' - ');
  await page.locator('#organization-selector-input').evaluate((input, nextValue) => {
    const selector = input as HTMLInputElement;
    selector.value = nextValue;
    selector.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function navigateWithPopstate(page: Page, path: string) {
  await page.evaluate((pathname) => {
    history.pushState(null, '', pathname);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

async function waitAnimationFrames(page: Page, count: number) {
  await page.evaluate(async (frames) => {
    for (let index = 0; index < frames; index += 1) {
      await new Promise<void>((resolvePromise) => window.requestAnimationFrame(() => resolvePromise()));
    }
  }, count);
}

function requestCount(records: RequestRecord[], method: string, path: string) {
  return records.filter((record) => record.method === method && record.path === path).length;
}

function qualifiedAiAccessPath(organizationId: string, userId: string) {
  return `/admin/api/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}/ai-access`;
}

async function armLeakObserver(page: Page, forbidden: string[], eventName: string) {
  await page.evaluate(
    ({ forbiddenTokens, event }) => {
      (window as WindowWithLeakObserver).__adminDataLeakObserver.armOnEvent(forbiddenTokens, event);
    },
    { forbiddenTokens: forbidden, event: eventName },
  );
}

async function leakRecords(page: Page) {
  return page.evaluate(() => (window as WindowWithLeakObserver).__adminDataLeakObserver.records());
}

async function stopLeakObserver(page: Page) {
  return page.evaluate(() => (window as WindowWithLeakObserver).__adminDataLeakObserver.stop());
}

function enqueueControlledResponse(
  queued: Map<string, QueuedResponse[]>,
  method: string,
  path: string,
) {
  let markArrived!: (record: RequestRecord) => void;
  let release!: (response: HarnessResponse) => void;
  const arrived = new Promise<RequestRecord>((resolvePromise) => {
    markArrived = resolvePromise;
  });
  const response = new Promise<HarnessResponse>((resolvePromise) => {
    release = resolvePromise;
  });
  const entry: QueuedResponse = { arrived, markArrived, response, release };
  const key = responseKey(method, path);
  queued.set(key, [...(queued.get(key) || []), entry]);
  return {
    arrived,
    release(value: HarnessResponse = json(200, {})) {
      release(value);
    },
    fail() {
      release({ networkError: 'failed' });
    },
  };
}

function createHarnessState(): HarnessState {
  const organizations = [ORG_A, ORG_B];
  const membersByOrgId = structuredClone(ORG_MEMBERS);
  return {
    session: {
      user: {
        id: 'platform-admin',
        email: 'platform-admin@example.test',
        emailVerified: true,
        name: 'PLATFORM-ADMIN',
      },
      platformAdmin: true,
      activeOrgId: ORG_A.id,
      organizations: organizations.map((entry) => ({
        id: entry.id,
        name: entry.name,
        slug: entry.slug,
        role: 'organization_admin',
      })),
      capabilities: [
        'organization',
        'users',
        'credentials',
        'usage',
        'alerts',
        'audit',
        'billing',
        'managedAiUserAccess',
      ],
      allowedPages: [
        'overview',
        'organization',
        'users',
        'credentials',
        'usage',
        'alerts',
        'audit',
        'billing',
      ],
    },
    organizations,
    globalUsers: structuredClone(GLOBAL_USERS),
    membersByOrgId,
    domainsByOrgId: {
      [ORG_A.id]: [domain('domain-a', ORG_A.id, 'ORG-A-DOMAIN.example')],
      [ORG_B.id]: [domain('domain-b', ORG_B.id, 'ORG-B-DOMAIN.example')],
    },
    invitesByOrgId: {
      [ORG_A.id]: [invite('invite-a', 'ORG-A-INVITE@example.test')],
      [ORG_B.id]: [invite('invite-b', 'ORG-B-INVITE@example.test')],
    },
    billingByOrgId: {
      [ORG_A.id]: billing('ORG-A-BILLING', 11, 7),
      [ORG_B.id]: billing('ORG-B-BILLING', 22, 13),
    },
    auditByOrgId: {
      [ORG_A.id]: [auditEvent('audit-a', 'ORG-A-AUDIT-ACTION', 'ORG-A-AUDIT-SUMMARY')],
      [ORG_B.id]: [auditEvent('audit-b', 'ORG-B-AUDIT-ACTION', 'ORG-B-AUDIT-SUMMARY')],
    },
    aiAccessByOrgAndUser: {
      [`${ORG_A.id}:${ORG_MEMBERS[ORG_A.id][0].userId}`]: aiAccess(
        ORG_MEMBERS[ORG_A.id][0].userId,
        'ORG-A-AI-CREDENTIAL',
      ),
      [`${ORG_A.id}:${ORG_MEMBERS[ORG_A.id][1].userId}`]: aiAccess(
        ORG_MEMBERS[ORG_A.id][1].userId,
        'ORG-A-SECOND-AI-CREDENTIAL',
      ),
      [`${ORG_B.id}:${ORG_MEMBERS[ORG_B.id][0].userId}`]: aiAccess(
        ORG_MEMBERS[ORG_B.id][0].userId,
        'ORG-B-AI-CREDENTIAL',
      ),
    },
    records: [],
  };
}

function organization(id: string, name: string, slug: string, seatLimit: number) {
  return {
    id,
    name,
    slug,
    ownerUserId: `owner-${id}`,
    seatLimit,
  };
}

function globalUser(
  id: string,
  name: string,
  email: string,
  org: TestOrganization,
  platformAdmin: boolean,
) {
  return {
    id,
    name,
    email,
    emailVerified: true,
    platformAdmin,
    disabled: false,
    memberships: [{
      membershipId: `membership-${id}`,
      orgId: org.id,
      orgName: org.name,
      orgSlug: org.slug,
      role: 'member',
    }],
  };
}

function organizationMember(membershipId: string, userId: string, name: string, email: string) {
  return {
    membershipId,
    userId,
    name,
    email,
    role: 'member',
    status: 'active',
    createdAt: '2026-07-14T08:00:00.000Z',
  };
}

function domain(id: string, orgId: string, value: string) {
  return { id, orgId, domain: value, enabled: true, selfSignupEnabled: false };
}

function invite(id: string, email: string) {
  return {
    id,
    email,
    role: 'member',
    status: 'pending',
    expiresAt: '2026-08-01T12:00:00.000Z',
  };
}

function billing(marker: string, licenseLimit: number, activeUserCount: number) {
  return {
    marker,
    account: {
      mode: marker,
      status: 'active',
      billingInterval: 'monthly',
      quantities: { managedAiBasic: licenseLimit, managedAiExtended: 0, localModels: 0 },
      manualAccess: { enabled: false, expiresAt: null },
    },
    entitlement: {
      effectiveMode: marker,
      status: 'active',
      canUseManagedAi: true,
      managedAiBlockingReason: null,
      licenseLimit,
      activeUserCount,
    },
    licenseLimit,
    activeUserCount,
  };
}

function auditEvent(id: string, action: string, summary: string) {
  return {
    id,
    action,
    summary,
    entityType: 'organization',
    entityId: id,
    source: 'den',
    actor: `${id}-actor`,
    timestamp: '2026-07-14T09:00:00.000Z',
  };
}

function aiAccess(userId: string, credentialName: string): TestAiAccessPayload {
  return {
    aiAccess: {
      id: `ai-access-${userId}`,
      userId,
      enabled: true,
      provider: 'codex_oauth',
      credentialId: `${credentialName}-id`,
      updatedAt: '2026-07-14T10:00:00.000Z',
    },
    availableCredentials: [{
      id: `${credentialName}-id`,
      name: credentialName,
      provider: 'codex_oauth',
    }],
  };
}

function emptyUsage() {
  return {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCachedTokens: 0,
    totalTokens: 0,
    requests: 0,
    series: [],
    byCredential: [],
  };
}

function parseRequestBody(postData: string | null): unknown {
  if (!postData) return null;
  try {
    return JSON.parse(postData);
  } catch {
    return postData;
  }
}

function responseKey(method: string, path: string) {
  return `${method.toUpperCase()} ${path}`;
}

function json(status: number, body: unknown): HarnessResponse {
  return { status, body };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function startStaticAdminServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    const extension = extname(pathname);
    const assetName = pathname.startsWith('/admin/') && (extension === '.js' || extension === '.css')
      ? pathname.slice('/admin/'.length)
      : 'index.html';
    const assetPath = join(ADMIN_PUBLIC_ROOT, assetName);

    if (!assetPath.startsWith(`${ADMIN_PUBLIC_ROOT}/`) && assetPath !== join(ADMIN_PUBLIC_ROOT, 'index.html')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

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

type LeakRecord = {
  token: string;
  channel: 'visible' | 'semantic';
  source: string;
  sample: string;
};

type WindowWithLeakObserver = Window & typeof globalThis & {
  __adminDataLeakObserver: {
    armOnEvent(tokens: string[], eventName: string): void;
    start(tokens: string[]): void;
    records(): LeakRecord[];
    stop(): LeakRecord[];
  };
};

type RequestRecord = {
  sequence: number;
  method: string;
  url: string;
  path: string;
  body: unknown;
};

type HarnessResponse =
  | { status: number; body: unknown }
  | { networkError: 'failed' };

type QueuedResponse = {
  arrived: Promise<RequestRecord>;
  markArrived(record: RequestRecord): void;
  response: Promise<HarnessResponse>;
  release(response: HarnessResponse): void;
};

type TestOrganization = ReturnType<typeof organization>;
type TestGlobalUser = ReturnType<typeof globalUser>;
type TestOrganizationMember = ReturnType<typeof organizationMember>;
type TestAiAccessPayload = {
  aiAccess: {
    id: string;
    userId: string;
    enabled: boolean;
    provider: string;
    credentialId: string | null;
    updatedAt: string;
  };
  availableCredentials: Array<{ id: string; name: string; provider: string }>;
};

type HarnessState = {
  session: {
    user: { id: string; email: string; emailVerified: boolean; name: string };
    platformAdmin: boolean;
    activeOrgId: string;
    organizations: Array<Pick<TestOrganization, 'id' | 'name' | 'slug'> & { role: string }>;
    capabilities: string[];
    allowedPages: string[];
  };
  organizations: TestOrganization[];
  globalUsers: TestGlobalUser[];
  membersByOrgId: Record<string, TestOrganizationMember[]>;
  domainsByOrgId: Record<string, Array<ReturnType<typeof domain>>>;
  invitesByOrgId: Record<string, Array<ReturnType<typeof invite>>>;
  billingByOrgId: Record<string, ReturnType<typeof billing>>;
  auditByOrgId: Record<string, Array<ReturnType<typeof auditEvent>>>;
  aiAccessByOrgAndUser: Record<string, TestAiAccessPayload>;
  records: RequestRecord[];
};
