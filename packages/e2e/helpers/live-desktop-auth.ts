import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { resolveE2EDesktopAuthSnapshotPath, writeDesktopAuthSeedFile } from './desktop-auth-seed.js';

export type DenAuthState = {
  denApiBase: string;
  token: string;
  orgId: string;
  user: { id: string; name?: string; email?: string };
  org: { id: string; name?: string; slug?: string; role?: string };
};

type DesktopAuthIntent = 'signin' | 'signup';
type DesktopAuthStatus = 'pending' | 'authorized' | 'expired' | 'cancelled' | 'exchanged';
type FetchLike = typeof fetch;

type JsonRecord = Record<string, unknown>;

export type LiveDesktopAuthSeedOptions = {
  opencodeHome: string;
  snapshotPath?: string;
  denApiBase?: string;
  redirectUri?: string;
  intent?: DesktopAuthIntent;
  keepSignedIn?: boolean | null;
  language?: string | null;
  onboardingComplete?: boolean | null;
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: FetchLike;
  openBrowser?: (url: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type LiveDesktopAuthSeedResult = {
  snapshotPath: string;
  authorizeUrl: string;
  transactionId: string;
  state: DenAuthState;
};

export const DEFAULT_DEN_API_BASE = 'https://den-control-plane-veslo.onrender.com';
export const DEFAULT_DESKTOP_AUTH_REDIRECT_URI = 'veslo://auth-complete';
export const DEFAULT_DESKTOP_AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_DESKTOP_AUTH_POLL_INTERVAL_MS = 1250;

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeDenApiBase(value?: string | null): string {
  const candidate = normalizeOptionalText(value) ?? DEFAULT_DEN_API_BASE;
  const parsed = new URL(candidate);
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
}

async function parseJsonBody(response: Response): Promise<JsonRecord | null> {
  const text = await response.text().catch(() => '');
  if (!text.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as JsonRecord) : null;
  } catch {
    return null;
  }
}

function randomBase64Url(size: number): string {
  return randomBytes(size).toString('base64url');
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function buildPkceProof() {
  const state = randomBase64Url(32);
  const codeVerifier = randomBase64Url(48);
  const codeChallenge = sha256Base64Url(codeVerifier);
  return { state, codeVerifier, codeChallenge };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readDenSessionUser(
  denApiBase: string,
  token: string,
  fetchImpl: FetchLike,
): Promise<DenAuthState['user'] | null> {
  const response = await fetchImpl(`${denApiBase}/v1/me`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await parseJsonBody(response)) as
    | { user?: { id?: unknown; name?: unknown; email?: unknown } }
    | null;
  const userId = normalizeOptionalText(payload?.user?.id);
  if (!userId) {
    return null;
  }

  return {
    id: userId,
    name: normalizeOptionalText(payload?.user?.name) ?? undefined,
    email: normalizeOptionalText(payload?.user?.email) ?? undefined,
  };
}

export async function startLiveDesktopAuthTransaction(
  fetchImpl: FetchLike,
  options?: {
    denApiBase?: string;
    redirectUri?: string;
    intent?: DesktopAuthIntent;
  },
): Promise<{
  authorizeUrl: string;
  transactionId: string;
  state: string;
  codeVerifier: string;
  expiresAt: string | null;
  denApiBase: string;
}> {
  const denApiBase = normalizeDenApiBase(options?.denApiBase);
  const redirectUri = normalizeOptionalText(options?.redirectUri) ?? DEFAULT_DESKTOP_AUTH_REDIRECT_URI;
  const intent = options?.intent ?? 'signin';
  const proof = buildPkceProof();

  const response = await fetchImpl(`${denApiBase}/v2/desktop-auth/start`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      intent,
      redirectUri,
      state: proof.state,
      codeChallenge: proof.codeChallenge,
      codeChallengeMethod: 'S256',
    }),
  });

  const payload = await parseJsonBody(response);
  if (!response.ok) {
    throw new Error(normalizeOptionalText(payload?.error) ?? `Desktop auth start failed (${response.status})`);
  }

  const authorizeUrl = normalizeOptionalText(payload?.authorizeUrl);
  const transactionId =
    normalizeOptionalText(payload?.transactionId) ??
    normalizeOptionalText(payload?.sessionId);

  if (!authorizeUrl || !transactionId) {
    throw new Error('Desktop auth start returned an invalid response.');
  }

  return {
    authorizeUrl,
    transactionId,
    state: proof.state,
    codeVerifier: proof.codeVerifier,
    expiresAt: normalizeOptionalText(payload?.expiresAt),
    denApiBase,
  };
}

export async function waitForLiveDesktopAuthCode(
  fetchImpl: FetchLike,
  denApiBase: string,
  transactionId: string,
  options?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_DESKTOP_AUTH_TIMEOUT_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_DESKTOP_AUTH_POLL_INTERVAL_MS;
  const sleep = options?.sleep ?? defaultSleep;
  const now = options?.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let lastError: string | null = null;

  while (now() < deadline) {
    try {
      const response = await fetchImpl(
        `${denApiBase}/v2/desktop-auth/status?transactionId=${encodeURIComponent(transactionId)}`,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
        },
      );
      const payload = await parseJsonBody(response);

      if (!response.ok) {
        lastError = normalizeOptionalText(payload?.error) ?? `Desktop auth status failed (${response.status})`;
      } else {
        const status = normalizeOptionalText(payload?.status)?.toLowerCase() as DesktopAuthStatus | undefined;
        if (status === 'authorized') {
          const code = normalizeOptionalText(payload?.code);
          if (!code) {
            throw new Error('Desktop auth status became authorized without a handoff code.');
          }
          return code;
        }
        if (status === 'expired' || status === 'cancelled' || status === 'exchanged') {
          throw new Error(`Desktop auth became ${status} before the E2E seed completed.`);
        }
        if (status !== 'pending') {
          lastError = `Unexpected desktop auth status: ${String(payload?.status ?? '(missing)')}`;
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(lastError ?? `Timed out waiting ${timeoutMs}ms for desktop auth authorization.`);
}

export async function exchangeLiveDesktopAuthCode(
  fetchImpl: FetchLike,
  options: {
    denApiBase: string;
    code: string;
    transactionId: string;
    state: string;
    codeVerifier: string;
  },
): Promise<DenAuthState> {
  const response = await fetchImpl(`${options.denApiBase}/v2/desktop-auth/exchange`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      code: options.code,
      transactionId: options.transactionId,
      state: options.state,
      codeVerifier: options.codeVerifier,
    }),
  });

  const payload = await parseJsonBody(response);
  if (!response.ok) {
    throw new Error(normalizeOptionalText(payload?.error) ?? `Desktop auth exchange failed (${response.status})`);
  }

  const userId = normalizeOptionalText(payload?.user && (payload.user as JsonRecord).id);
  const orgId = normalizeOptionalText(payload?.org && (payload.org as JsonRecord).id);
  const token =
    normalizeOptionalText(payload?.accessToken) ??
    normalizeOptionalText(payload?.token) ??
    normalizeOptionalText(options.code);

  if (!userId || !orgId || !token) {
    throw new Error('Desktop auth exchange returned an invalid response.');
  }

  const state: DenAuthState = {
    denApiBase: options.denApiBase,
    token,
    orgId,
    user: {
      id: userId,
      name: normalizeOptionalText(payload?.user && (payload.user as JsonRecord).name) ?? undefined,
      email: normalizeOptionalText(payload?.user && (payload.user as JsonRecord).email) ?? undefined,
    },
    org: {
      id: orgId,
      name: normalizeOptionalText(payload?.org && (payload.org as JsonRecord).name) ?? undefined,
      slug: normalizeOptionalText(payload?.org && (payload.org as JsonRecord).slug) ?? undefined,
      role: normalizeOptionalText(payload?.org && (payload.org as JsonRecord).role) ?? undefined,
    },
  };

  if (!state.user.email) {
    const resolvedUser = await readDenSessionUser(options.denApiBase, state.token, fetchImpl).catch(() => null);
    if (resolvedUser) {
      state.user = resolvedUser;
    }
  }

  return state;
}

export async function openUrlInSystemBrowser(url: string): Promise<void> {
  const launch =
    process.platform === 'darwin'
      ? { command: 'open', args: [url] }
      : process.platform === 'win32'
        ? { command: 'cmd', args: ['/c', 'start', '', url] }
        : { command: 'xdg-open', args: [url] };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export async function seedDesktopAuthSnapshotViaLiveBrowser(
  options: LiveDesktopAuthSeedOptions,
): Promise<LiveDesktopAuthSeedResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const openBrowser = options.openBrowser ?? openUrlInSystemBrowser;
  const start = await startLiveDesktopAuthTransaction(fetchImpl, {
    denApiBase: options.denApiBase,
    redirectUri: options.redirectUri,
    intent: options.intent,
  });

  await openBrowser(start.authorizeUrl);

  const code = await waitForLiveDesktopAuthCode(fetchImpl, start.denApiBase, start.transactionId, {
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    sleep: options.sleep,
    now: options.now,
  });

  const state = await exchangeLiveDesktopAuthCode(fetchImpl, {
    denApiBase: start.denApiBase,
    code,
    transactionId: start.transactionId,
    state: start.state,
    codeVerifier: start.codeVerifier,
  });

  const snapshotPath = options.snapshotPath ?? resolveE2EDesktopAuthSnapshotPath(options.opencodeHome);
  writeDesktopAuthSeedFile(snapshotPath, {
    authJson: JSON.stringify(state),
    keepSignedIn: options.keepSignedIn ?? true,
    language: normalizeOptionalText(options.language) ?? 'en',
    onboardingComplete: options.onboardingComplete ?? true,
    source: 'e2e-live-browser',
  });

  return {
    snapshotPath,
    authorizeUrl: start.authorizeUrl,
    transactionId: start.transactionId,
    state,
  };
}
