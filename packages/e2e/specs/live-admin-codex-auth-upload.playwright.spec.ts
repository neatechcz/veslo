import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';

const execAsync = promisify(exec);

const LIVE_ENABLED = process.env.E2E_LIVE_ADMIN_CODEX_AUTH_UPLOAD?.trim() === '1';
const COMMIT_UPLOAD = process.env.E2E_LIVE_ADMIN_CODEX_AUTH_UPLOAD_COMMIT?.trim() === '1';
const DEFAULT_ADMIN_BASE = 'https://ai.veslo.work';
const ADMIN_TOKEN_STORAGE_KEY = 'veslo.den.admin.token';
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

test.skip(!LIVE_ENABLED, 'Live Codex auth upload test is disabled unless E2E_LIVE_ADMIN_CODEX_AUTH_UPLOAD=1.');

test('opens live admin, selects Václav Codex, and runs the local upload helper', async ({ page }) => {
  const adminToken = readRequiredEnv('VESLO_E2E_ADMIN_TOKEN');
  const authJsonPath = readRequiredEnv('VESLO_E2E_CODEX_AUTH_JSON_PATH');
  const adminBase = normalizeAdminBase(
    process.env.VESLO_E2E_ADMIN_BASE?.trim() ||
    process.env.VESLO_LIVE_ADMIN_BASE?.trim() ||
    DEFAULT_ADMIN_BASE,
  );
  const credentialPattern = readCredentialPattern();

  await page.addInitScript(
    ({ storageKey, token }) => {
      localStorage.setItem(storageKey, token);
    },
    {
      storageKey: ADMIN_TOKEN_STORAGE_KEY,
      token: adminToken,
    },
  );

  await page.goto(`${adminBase}/admin/credentials`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Credentials' })).toBeVisible();

  const credentialRow = page.locator('[data-credential-id]').filter({ hasText: credentialPattern }).first();
  await expect(credentialRow, `Expected a Codex credential matching ${credentialPattern}`).toBeVisible();
  await credentialRow.click();

  await page.getByRole('button', { name: 'Prepare local upload' }).click();
  const commandOutput = page.locator('[data-codex-auth-upload-command]');
  await expect(commandOutput).toBeVisible();
  const command = await commandOutput.inputValue();
  expect(command).toContain('node scripts/admin/codex-auth-upload.mjs');
  expect(command).toContain('--credential-id');

  const fullCommand = [
    command,
    '--auth-json-path',
    shellQuote(authJsonPath),
    '--yes',
    COMMIT_UPLOAD ? '' : '--dry-run',
  ].filter(Boolean).join(' ');

  const { stdout, stderr } = await execAsync(fullCommand, {
    cwd: repoRoot,
    timeout: 300000,
    maxBuffer: 1024 * 1024,
  });

  expect(`${stdout}\n${stderr}`).toContain('Codex account:');
  if (COMMIT_UPLOAD) {
    expect(stdout).toContain('Uploaded Codex auth');
  } else {
    expect(stdout).toContain('Dry run: auth.json was validated, upload skipped.');
  }
});

function normalizeAdminBase(value: string): string {
  return value.replace(/\/+$/, '').replace(/\/admin$/i, '');
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function readCredentialPattern(): RegExp {
  const configured = process.env.VESLO_E2E_CODEX_CREDENTIAL_NAME?.trim();
  if (configured) {
    return new RegExp(escapeRegExp(configured), 'i');
  }
  return /Václav\s+Codex|Vaclav\s+CODEX/i;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
