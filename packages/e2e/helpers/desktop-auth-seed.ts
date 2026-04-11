import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type DesktopAuthSeed = {
  authJson: string | null;
  keepSignedIn: boolean | null;
  language: string | null;
  onboardingComplete: boolean | null;
  source: string | null;
};

type DesktopAuthSnapshotFile = DesktopAuthSeed & {
  version: number;
  updatedAt: number;
};

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeOptionalBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  return null;
}

function parseSnapshotFile(raw: string): DesktopAuthSeed {
  const parsed = JSON.parse(raw) as Partial<DesktopAuthSnapshotFile>;
  return {
    authJson: normalizeOptionalText(parsed.authJson),
    keepSignedIn: normalizeOptionalBoolean(parsed.keepSignedIn),
    language: normalizeOptionalText(parsed.language),
    onboardingComplete: normalizeOptionalBoolean(parsed.onboardingComplete),
    source: normalizeOptionalText(parsed.source),
  };
}

export function resolveE2EDesktopAuthSnapshotPath(opencodeHome: string): string {
  return join(opencodeHome, '.veslo', 'den-auth.json');
}

export function resolveDesktopAuthSeedFromEnv(
  env: Record<string, string | undefined> = process.env,
): DesktopAuthSeed | null {
  const snapshotFile = normalizeOptionalText(env.VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE);
  if (snapshotFile) {
    return parseSnapshotFile(readFileSync(snapshotFile, 'utf8'));
  }

  const authJson = normalizeOptionalText(env.VESLO_E2E_DEN_AUTH_JSON);
  if (!authJson) {
    return null;
  }

  return {
    authJson,
    keepSignedIn: normalizeOptionalBoolean(env.VESLO_E2E_DEN_KEEP_SIGNED_IN) ?? true,
    language: normalizeOptionalText(env.VESLO_E2E_LANGUAGE) ?? 'en',
    onboardingComplete: normalizeOptionalBoolean(env.VESLO_E2E_ONBOARDING_COMPLETE) ?? true,
    source: 'e2e-env',
  };
}

export function writeDesktopAuthSeedFile(snapshotPath: string, seed: DesktopAuthSeed): void {
  mkdirSync(dirname(snapshotPath), { recursive: true });
  const payload: DesktopAuthSnapshotFile = {
    version: 1,
    authJson: seed.authJson,
    keepSignedIn: seed.keepSignedIn,
    language: seed.language,
    onboardingComplete: seed.onboardingComplete,
    updatedAt: Date.now(),
    source: seed.source,
  };
  writeFileSync(snapshotPath, JSON.stringify(payload, null, 2));
}

export function prepareDesktopAuthSeed(
  opencodeHome: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const snapshotPath = resolveE2EDesktopAuthSnapshotPath(opencodeHome);
  const seed = resolveDesktopAuthSeedFromEnv(env);
  if (seed) {
    writeDesktopAuthSeedFile(snapshotPath, seed);
  } else {
    rmSync(snapshotPath, { force: true });
  }
  return snapshotPath;
}
