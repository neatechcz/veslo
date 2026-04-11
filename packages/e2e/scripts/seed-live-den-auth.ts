import { resolve } from 'node:path';
import {
  DEFAULT_DEN_API_BASE,
  DEFAULT_DESKTOP_AUTH_TIMEOUT_MS,
  openUrlInSystemBrowser,
  seedDesktopAuthSnapshotViaLiveBrowser,
} from '../helpers/live-desktop-auth.js';
import { resolveE2EDesktopAuthSnapshotPath } from '../helpers/desktop-auth-seed.js';

function normalizeOptionalText(value: string | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}

function normalizeOptionalBoolean(value: string | undefined): boolean | null {
  if (!value || !value.trim()) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  return null;
}

function normalizeOptionalInteger(value: string | undefined): number | null {
  if (!value || !value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

const cwd = process.cwd();
const opencodeHome = normalizeOptionalText(process.env.OPENCODE_HOME)
  ?? resolve(cwd, '.tmp-opencode-home');
const snapshotPath = normalizeOptionalText(process.env.VESLO_DEN_AUTH_SNAPSHOT_PATH)
  ?? resolveE2EDesktopAuthSnapshotPath(opencodeHome);
const denApiBase = normalizeOptionalText(process.env.VESLO_E2E_DEN_API_BASE)
  ?? normalizeOptionalText(process.env.VITE_DEN_API_BASE)
  ?? DEFAULT_DEN_API_BASE;
const timeoutMs = normalizeOptionalInteger(process.env.VESLO_E2E_DEN_AUTH_TIMEOUT_MS)
  ?? DEFAULT_DESKTOP_AUTH_TIMEOUT_MS;

console.log(`[e2e] Starting live desktop auth seeding against ${denApiBase}`);
console.log(`[e2e] OPENCODE_HOME=${opencodeHome}`);
console.log(`[e2e] Snapshot path=${snapshotPath}`);
console.log('[e2e] A browser window will open. Complete sign-in there; this command will wait for authorization.');

const result = await seedDesktopAuthSnapshotViaLiveBrowser({
  opencodeHome,
  snapshotPath,
  denApiBase,
  keepSignedIn: normalizeOptionalBoolean(process.env.VESLO_E2E_DEN_KEEP_SIGNED_IN) ?? true,
  language: normalizeOptionalText(process.env.VESLO_E2E_LANGUAGE) ?? 'en',
  onboardingComplete: normalizeOptionalBoolean(process.env.VESLO_E2E_ONBOARDING_COMPLETE) ?? true,
  timeoutMs,
  openBrowser: openUrlInSystemBrowser,
});

console.log(`[e2e] Desktop auth seeded for ${result.state.user.email ?? result.state.user.id}`);
console.log(`[e2e] Transaction ID: ${result.transactionId}`);
console.log(`[e2e] Snapshot written to ${result.snapshotPath}`);
