export const SIGNUP_INVITATION_SESSION_STORAGE_KEY = "veslo:signup-invite-token";
export const SIGNUP_INVITATION_MAX_LENGTH = 4096;
export const GITHUB_AUTH_CALLBACK_MARKER_PARAM = "authCallback";
export const GITHUB_AUTH_ATTEMPT_PARAM = "authAttempt";
export const GITHUB_AUTH_PENDING_STORAGE_KEY = "veslo:web:pending-github-auth";
export const GITHUB_AUTH_PENDING_TTL_MS = 10 * 60 * 1000;
const GITHUB_AUTH_ATTEMPT_MAX_LENGTH = 128;

export type AuthMode = "sign-in" | "sign-up";
export type GitHubAuthCallbackOutcome = "success" | "new-user" | "error";

const GITHUB_AUTH_CALLBACK_MARKERS: Record<GitHubAuthCallbackOutcome, string> = {
  success: "github-success",
  "new-user": "github-new-user",
  error: "github-error"
};

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "removeItem">;
type BrowserSessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type SessionStorageBrowser = { readonly sessionStorage: BrowserSessionStorage };
type HistoryBrowser = { readonly history: Pick<History, "replaceState"> };
type CryptoBrowser = {
  readonly crypto: {
    randomUUID?: () => string;
    getRandomValues?: (array: Uint8Array) => Uint8Array;
  };
};

export type ParsedSignupInvitationUrl = {
  inviteToken: string | null;
  scrubbedUrl: string;
  hadInvitationParameter: boolean;
};

export type ParsedGitHubAuthCallback = {
  outcome: GitHubAuthCallbackOutcome;
  attemptId: string | null;
  error: string | null;
  errorDescription: string | null;
  scrubbedUrl: string;
};

export type PendingGitHubAuth = {
  mode: AuthMode;
  createdAt: number;
  attemptId: string;
};

export type AuthInitialization = {
  desktopOnboarding: boolean;
  desktopTransactionId: string | null;
  githubCallback: ParsedGitHubAuthCallback | null;
  authMode: AuthMode | null;
  githubCallbackCorrelated: boolean;
  githubSignupConfirmed: boolean;
};

function normalizeInvitationToken(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.length > SIGNUP_INVITATION_MAX_LENGTH) {
    return null;
  }
  return normalized;
}

function normalizeGitHubAuthAttemptId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  if (
    !normalized ||
    normalized.length > GITHUB_AUTH_ATTEMPT_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function parseSignupInvitationUrl(input: string): ParsedSignupInvitationUrl {
  const url = new URL(input);
  const fragmentSource = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const fragmentParams = new URLSearchParams(fragmentSource);
  const fragmentHasInvitation = fragmentParams.has("inviteToken");
  const queryHasInvitation = url.searchParams.has("inviteToken");
  const rawInvitation = fragmentHasInvitation
    ? fragmentParams.get("inviteToken")
    : url.searchParams.get("inviteToken");

  if (queryHasInvitation) {
    url.searchParams.delete("inviteToken");
  }
  if (fragmentHasInvitation) {
    fragmentParams.delete("inviteToken");
    const nextFragment = fragmentParams.toString();
    url.hash = nextFragment ? `#${nextFragment}` : "";
  }

  return {
    inviteToken: normalizeInvitationToken(rawInvitation),
    scrubbedUrl: url.toString(),
    hadInvitationParameter: fragmentHasInvitation || queryHasInvitation
  };
}

export function readStoredSignupInvitation(storage: StorageReader): string | null {
  try {
    return normalizeInvitationToken(storage.getItem(SIGNUP_INVITATION_SESSION_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function clearStoredSignupInvitation(storage: StorageWriter): void {
  try {
    storage.removeItem(SIGNUP_INVITATION_SESSION_STORAGE_KEY);
  } catch {
    // Storage access can be denied without making a completed signup fail.
  }
}

function getBrowserSessionStorage(browser: SessionStorageBrowser): BrowserSessionStorage | null {
  try {
    return browser.sessionStorage;
  } catch {
    return null;
  }
}

export function readStoredSignupInvitationFromBrowser(browser: SessionStorageBrowser): string | null {
  const storage = getBrowserSessionStorage(browser);
  return storage ? readStoredSignupInvitation(storage) : null;
}

export function clearStoredSignupInvitationFromBrowser(browser: SessionStorageBrowser): void {
  const storage = getBrowserSessionStorage(browser);
  if (storage) {
    clearStoredSignupInvitation(storage);
  }
}

export function storePendingGitHubAuth(
  browser: SessionStorageBrowser,
  mode: AuthMode,
  attemptId: string,
  createdAt = Date.now()
): void {
  const storage = getBrowserSessionStorage(browser);
  if (!storage) {
    return;
  }
  const normalizedAttemptId = normalizeGitHubAuthAttemptId(attemptId);
  if (!normalizedAttemptId) {
    try {
      storage.removeItem(GITHUB_AUTH_PENDING_STORAGE_KEY);
    } catch {
      // Invalid attempts must not reuse an older pending context.
    }
    return;
  }
  try {
    storage.setItem(
      GITHUB_AUTH_PENDING_STORAGE_KEY,
      JSON.stringify({ mode, createdAt, attemptId: normalizedAttemptId })
    );
  } catch {
    // OAuth can proceed even when browser storage is unavailable.
  }
}

export function consumePendingGitHubAuth(
  browser: SessionStorageBrowser,
  expectedAttemptId: string | null,
  now = Date.now()
): PendingGitHubAuth | null {
  const storage = getBrowserSessionStorage(browser);
  if (!storage) {
    return null;
  }

  let raw: string | null = null;
  try {
    raw = storage.getItem(GITHUB_AUTH_PENDING_STORAGE_KEY);
  } catch {
    return null;
  }
  try {
    storage.removeItem(GITHUB_AUTH_PENDING_STORAGE_KEY);
  } catch {
    // Reading remains useful even if cleanup is denied.
  }
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PendingGitHubAuth>;
    const createdAt = parsed.createdAt;
    const mode = parsed.mode;
    const attemptId = normalizeGitHubAuthAttemptId(parsed.attemptId);
    const normalizedExpectedAttemptId = normalizeGitHubAuthAttemptId(expectedAttemptId);
    const age = typeof createdAt === "number" ? now - createdAt : Number.NaN;
    if (
      (mode !== "sign-in" && mode !== "sign-up") ||
      !attemptId ||
      !normalizedExpectedAttemptId ||
      attemptId !== normalizedExpectedAttemptId ||
      typeof createdAt !== "number" ||
      !Number.isFinite(createdAt) ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > GITHUB_AUTH_PENDING_TTL_MS
    ) {
      return null;
    }
    return { mode, createdAt, attemptId };
  } catch {
    return null;
  }
}

export function clearPendingGitHubAuth(browser: SessionStorageBrowser): void {
  const storage = getBrowserSessionStorage(browser);
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(GITHUB_AUTH_PENDING_STORAGE_KEY);
  } catch {
    // Cleanup is best effort when browser storage is unavailable.
  }
}

export function replaceBrowserHistoryUrl(browser: HistoryBrowser, url: string): void {
  try {
    browser.history.replaceState({}, "", url);
  } catch {
    // History cleanup is best effort when the browser denies access.
  }
}

export function createGitHubAuthAttemptId(browser: CryptoBrowser): string | null {
  let browserCrypto: CryptoBrowser["crypto"];
  try {
    browserCrypto = browser.crypto;
  } catch {
    return null;
  }

  try {
    const randomUuid = normalizeGitHubAuthAttemptId(browserCrypto.randomUUID?.());
    if (randomUuid) {
      return randomUuid;
    }
  } catch {
    // Fall through to getRandomValues.
  }

  try {
    if (!browserCrypto.getRandomValues) {
      return null;
    }
    const bytes = browserCrypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

export function getGitHubAuthCallbackMarker(outcome: GitHubAuthCallbackOutcome): string {
  return GITHUB_AUTH_CALLBACK_MARKERS[outcome];
}

export function parseGitHubAuthCallbackUrl(input: string): ParsedGitHubAuthCallback | null {
  const url = new URL(input);
  const marker = url.searchParams.get(GITHUB_AUTH_CALLBACK_MARKER_PARAM);
  const outcome = (Object.entries(GITHUB_AUTH_CALLBACK_MARKERS) as Array<[
    GitHubAuthCallbackOutcome,
    string
  ]>).find(([, value]) => value === marker)?.[0];
  if (!outcome) {
    return null;
  }

  const error = url.searchParams.get("error")?.trim() || null;
  const errorDescription = url.searchParams.get("error_description")?.trim() || null;
  const attemptId = normalizeGitHubAuthAttemptId(url.searchParams.get(GITHUB_AUTH_ATTEMPT_PARAM));
  url.searchParams.delete(GITHUB_AUTH_CALLBACK_MARKER_PARAM);
  url.searchParams.delete(GITHUB_AUTH_ATTEMPT_PARAM);
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");

  return {
    outcome,
    attemptId,
    error,
    errorDescription,
    scrubbedUrl: url.toString()
  };
}

export function deriveAuthInitialization(
  input: string,
  pendingGitHubAuth: PendingGitHubAuth | null
): AuthInitialization {
  const url = new URL(input);
  const githubCallback = parseGitHubAuthCallbackUrl(input);
  const desktopOnboarding = url.searchParams.get("desktopOnboarding") === "1";
  const desktopTransactionId = (
    url.searchParams.get("tid") ?? url.searchParams.get("transactionId") ?? ""
  ).trim() || null;

  const githubCallbackCorrelated = Boolean(
    githubCallback?.attemptId &&
    pendingGitHubAuth?.attemptId === githubCallback.attemptId
  );
  const githubSignupConfirmed = Boolean(
    githubCallback?.outcome === "new-user" &&
    githubCallbackCorrelated &&
    pendingGitHubAuth?.mode === "sign-up"
  );

  let authMode: AuthMode | null = null;
  if (githubSignupConfirmed) {
    authMode = "sign-up";
  } else if (githubCallback?.outcome === "error" && githubCallbackCorrelated) {
    authMode = pendingGitHubAuth?.mode ?? "sign-in";
  } else if (githubCallback || desktopOnboarding) {
    authMode = "sign-in";
  }

  return {
    desktopOnboarding,
    desktopTransactionId,
    githubCallback,
    authMode,
    githubCallbackCorrelated,
    githubSignupConfirmed
  };
}

export const signupInvitationBootstrapScript = `(() => {
  const sessionKey = ${JSON.stringify(SIGNUP_INVITATION_SESSION_STORAGE_KEY)};
  const maxLength = ${SIGNUP_INVITATION_MAX_LENGTH};
  let parsed;
  try {
    const url = new URL(window.location.href);
    const fragmentSource = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    const fragmentParams = new URLSearchParams(fragmentSource);
    const fragmentHasInvitation = fragmentParams.has("inviteToken");
    const queryHasInvitation = url.searchParams.has("inviteToken");
    const rawInvitation = fragmentHasInvitation
      ? fragmentParams.get("inviteToken")
      : url.searchParams.get("inviteToken");
    if (queryHasInvitation) url.searchParams.delete("inviteToken");
    if (fragmentHasInvitation) {
      fragmentParams.delete("inviteToken");
      const nextFragment = fragmentParams.toString();
      url.hash = nextFragment ? "#" + nextFragment : "";
    }
    parsed = {
      token: typeof rawInvitation === "string" ? rawInvitation.trim() : "",
      scrubbedUrl: url.toString(),
      hadInvitationParameter: fragmentHasInvitation || queryHasInvitation
    };
  } catch {
    return;
  }
  if (parsed.token && parsed.token.length <= maxLength) {
    try {
      window.sessionStorage.setItem(sessionKey, parsed.token);
    } catch {
      // Continue to scrub the URL even when storage is unavailable.
    }
  } else if (parsed.hadInvitationParameter) {
    try {
      window.sessionStorage.removeItem(sessionKey);
    } catch {
      // Continue to scrub the URL even when storage is unavailable.
    }
  }
  if (parsed.hadInvitationParameter) {
    try {
      window.history.replaceState({}, "", parsed.scrubbedUrl);
    } catch {
      // A failed history write must not expose the token elsewhere.
    }
  }
})();`;
