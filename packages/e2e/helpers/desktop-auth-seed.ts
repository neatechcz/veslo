import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function firstOptionalText(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizeOptionalText(value);
    if (normalized) return normalized;
  }
  return null;
}

function firstOptionalBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    const normalized = normalizeOptionalBoolean(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

export function defaultE2EDesktopAuthSeed(): DesktopAuthSeed {
  return {
    authJson: JSON.stringify({
      denApiBase: 'http://127.0.0.1:9',
      token: 'veslo-e2e-default-token',
      orgId: 'org_veslo_e2e_default',
      user: { id: 'user_veslo_e2e_default', email: 'veslo-e2e@example.test' },
      org: { id: 'org_veslo_e2e_default', slug: 'veslo-e2e' },
    }),
    keepSignedIn: true,
    language: 'en',
    onboardingComplete: true,
    source: 'e2e-default',
  };
}

function parseSnapshotFile(raw: string): DesktopAuthSeed {
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as Partial<DesktopAuthSnapshotFile>;
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
  const snapshotFile = firstOptionalText(
    env.VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE,
    env.E2E_DEN_AUTH_SNAPSHOT_FILE,
  );
  if (snapshotFile) {
    return parseSnapshotFile(readFileSync(snapshotFile, 'utf8'));
  }

  const authJson = firstOptionalText(env.VESLO_E2E_DEN_AUTH_JSON, env.E2E_DEN_AUTH_JSON);
  if (!authJson) {
    return null;
  }

  return {
    authJson,
    keepSignedIn: firstOptionalBoolean(env.VESLO_E2E_DEN_KEEP_SIGNED_IN, env.E2E_DEN_KEEP_SIGNED_IN) ?? true,
    language: firstOptionalText(env.VESLO_E2E_LANGUAGE, env.E2E_LANGUAGE) ?? 'en',
    onboardingComplete: firstOptionalBoolean(env.VESLO_E2E_ONBOARDING_COMPLETE, env.E2E_ONBOARDING_COMPLETE) ?? true,
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
  options?: {
    preserveExisting?: boolean;
  },
): string {
  const snapshotPath = resolveE2EDesktopAuthSnapshotPath(opencodeHome);
  const seed = resolveDesktopAuthSeedFromEnv(env);
  if (seed) {
    writeDesktopAuthSeedFile(snapshotPath, seed);
  } else if (options?.preserveExisting) {
    // Custom E2E profiles may already carry a real desktop auth snapshot.
    // Preserve it unless the caller explicitly provides a replacement seed.
  } else {
    writeDesktopAuthSeedFile(snapshotPath, defaultE2EDesktopAuthSeed());
  }
  return snapshotPath;
}
